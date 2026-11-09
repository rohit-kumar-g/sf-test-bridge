// SF Test Bridge - background service worker.
// Connects to the local MCP hub (ws://127.0.0.1:<port>/ext), executes commands
// against tabs Claude is allowed to control, and reports results.
//
// Safety model: Claude may only act on tabs it opened itself (and popups/new
// tabs those tabs open) or tabs the user explicitly shared from the popup.
// A "Pause" switch in the popup rejects every command and detaches debuggers.

const DEFAULT_PORT = 17345;
const PING_MS = 20_000;
const CONSOLE_CAP = 500;
const NETWORK_CAP = 600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, msg) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms)),
]);

// ---------------------------------------------------------------------------
// persistent state
// ---------------------------------------------------------------------------
const S = {
  // chrome.storage.local
  port: DEFAULT_PORT,
  paused: false,
  openMode: 'window', // 'window' = dedicated Claude window, 'tab' = current window
  // tab ownership: chrome.storage.local so it survives extension reloads;
  // cleared on browser startup because tab ids are reused across sessions.
  controlled: {}, // tabId -> 'claude' | 'user' | 'child'
  claudeWindowId: null,
  groups: {}, // windowId -> groupId
  lastTabId: null,
  // per extension load (storage.session is wiped by a reload): stale content
  // scripts from a previous load are replaced instead of reused.
  boot: null,
};
const TAB_KEYS = ['controlled', 'claudeWindowId', 'groups', 'lastTabId'];
const ready = (async () => {
  const l = await chrome.storage.local.get(['port', 'paused', 'openMode', ...TAB_KEYS]);
  Object.assign(S, Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined)));
  let { boot } = await chrome.storage.session.get('boot');
  if (!boot) { boot = crypto.randomUUID(); await chrome.storage.session.set({ boot }); }
  S.boot = boot;
  // drop tabs that no longer exist
  const live = new Set((await chrome.tabs.query({})).map((t) => t.id));
  for (const id of Object.keys(S.controlled)) if (!live.has(Number(id))) delete S.controlled[id];
})();
const saveSession = () => chrome.storage.local.set(Object.fromEntries(TAB_KEYS.map((k) => [k, S[k]])));
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.remove(TAB_KEYS);
  Object.assign(S, { controlled: {}, claudeWindowId: null, groups: {}, lastTabId: null });
});

// ---------------------------------------------------------------------------
// hub connection
// ---------------------------------------------------------------------------
const conn = { ws: null, connected: false, retryMs: 1000, pingTimer: null, retryTimer: null, lastError: null };

function browserName() {
  const brands = navigator.userAgentData?.brands?.map((b) => b.brand) || [];
  if (navigator.brave) return 'Brave';
  for (const b of ['Microsoft Edge', 'Google Chrome', 'Opera', 'Vivaldi']) if (brands.includes(b)) return b;
  return brands.find((b) => !/Not.?A.?Brand|Chromium/i.test(b)) || 'Chromium';
}

async function connect() {
  await ready;
  if (conn.ws && conn.ws.readyState <= 1) return;
  clearTimeout(conn.retryTimer);
  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${S.port}/ext`);
  } catch (e) { conn.lastError = String(e); scheduleReconnect(); return; }
  conn.ws = ws;
  ws.onopen = () => {
    conn.connected = true;
    conn.retryMs = 1000;
    conn.lastError = null;
    ws.send(JSON.stringify({
      type: 'hello', role: 'extension', browser: browserName(),
      version: chrome.runtime.getManifest().version, userAgent: navigator.userAgent,
    }));
    clearInterval(conn.pingTimer);
    conn.pingTimer = setInterval(() => { if (ws.readyState === 1) ws.send('{"type":"ping"}'); }, PING_MS);
    updateBadge();
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'cancel') { cancelRequest(msg.id); return; }
    if (msg.type !== 'request') return;
    handle(msg.method, msg.params || {}, msg.id).then(
      (result) => send({ type: 'response', id: msg.id, result }),
      (err) => send({ type: 'response', id: msg.id, error: { message: err?.message || String(err) } }),
    );
  };
  ws.onclose = () => {
    if (conn.ws === ws) { conn.ws = null; conn.connected = false; }
    clearInterval(conn.pingTimer);
    updateBadge();
    scheduleReconnect();
  };
  ws.onerror = () => { conn.lastError = `hub not reachable on 127.0.0.1:${S.port}`; };
}
function send(obj) {
  if (conn.ws?.readyState === 1) conn.ws.send(JSON.stringify(obj));
}
function scheduleReconnect() {
  clearTimeout(conn.retryTimer);
  conn.retryTimer = setTimeout(connect, conn.retryMs);
  conn.retryMs = Math.min(conn.retryMs * 2, 15_000);
}
function updateBadge() {
  const text = S.paused ? '||' : conn.connected ? 'on' : '';
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: S.paused ? '#888' : '#d97757' }).catch(() => {});
}

chrome.alarms.create('cbb-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'cbb-keepalive') connect(); });
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

// ---------------------------------------------------------------------------
// tab ownership
// ---------------------------------------------------------------------------
async function controlTab(tabId, how) {
  S.controlled[tabId] = how;
  S.lastTabId = tabId;
  await saveSession();
}
async function releaseTab(tabId) {
  delete S.controlled[tabId];
  if (S.lastTabId === tabId) S.lastTabId = null;
  await saveSession();
  await detach(tabId);
}
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  dbg.delete(tabId);
  if (S.controlled[tabId]) { delete S.controlled[tabId]; if (S.lastTabId === tabId) S.lastTabId = null; saveSession(); }
});
// New tabs / popups opened by a controlled tab (target=_blank, window.open,
// SSO popups) become controllable too.
chrome.tabs.onCreated.addListener(async (tab) => {
  await ready;
  if (tab.openerTabId != null && S.controlled[tab.openerTabId]) {
    S.controlled[tab.id] = 'child';
    saveSession();
    addToGroup(tab).catch(() => {});
  }
});
chrome.windows.onRemoved.addListener(async (windowId) => {
  await ready;
  if (S.claudeWindowId === windowId) S.claudeWindowId = null;
  delete S.groups[windowId];
  saveSession();
});

async function addToGroup(tab) {
  if (!chrome.tabGroups) return;
  const win = await chrome.windows.get(tab.windowId);
  if (win.type !== 'normal') return;
  let groupId = S.groups[tab.windowId];
  if (groupId != null) {
    try { await chrome.tabGroups.get(groupId); } catch { groupId = null; }
  }
  groupId = await chrome.tabs.group({ tabIds: [tab.id], ...(groupId != null ? { groupId } : { createProperties: { windowId: tab.windowId } }) });
  S.groups[tab.windowId] = groupId;
  await chrome.tabGroups.update(groupId, { title: 'Claude', color: 'orange' });
  await saveSession();
}

async function tabFor(params) {
  await ready;
  if (S.paused) throw new Error('SF Test Bridge is paused by the user (extension popup). Ask the user to resume it.');
  let tabId = params.tabId;
  if (tabId == null) {
    const ids = Object.keys(S.controlled).map(Number);
    if (S.lastTabId != null && S.controlled[S.lastTabId]) tabId = S.lastTabId;
    else if (ids.length === 1) tabId = ids[0];
    else throw new Error(ids.length ? `Several controlled tabs (${ids.join(', ')}); pass tabId.` : 'No controlled tab. Call browser_open first, or ask the user to share a tab from the extension popup.');
  }
  tabId = Number(tabId);
  if (!S.controlled[tabId]) {
    throw new Error(`Tab ${tabId} is not controlled by Claude. Only tabs opened with browser_open (or shared by the user via the extension popup) can be used.`);
  }
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { await releaseTab(tabId); throw new Error(`Tab ${tabId} no longer exists.`); }
  S.lastTabId = tabId;
  saveSession();
  return tab;
}

// ---------------------------------------------------------------------------
// debugger (CDP)
// ---------------------------------------------------------------------------
const dbg = new Map(); // tabId -> session record

function dbgRec(tabId) {
  let d = dbg.get(tabId);
  if (!d) {
    d = { attached: false, attaching: null, console: [], consoleSeq: 0, network: new Map(), netSeq: 0, inflight: new Map(), dialog: null, cdpUnavailable: null };
    dbg.set(tabId, d);
  }
  return d;
}
async function attach(tabId) {
  const d = dbgRec(tabId);
  if (d.attached) return d;
  if (d.attaching) { await d.attaching; return d; }
  d.attaching = (async () => {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (e) {
      if (!/already attached/i.test(e.message)) throw e;
    }
    d.attached = true;
    d.cdpUnavailable = null;
    d.stalled = null;
    const t = { tabId };
    // Runtime.enable does not answer while the page is blocked (e.g. by a
    // JavaScript dialog that opened before the bridge attached): never wait forever.
    const hung = [];
    await Promise.all([
      ['Page.enable'], ['Runtime.enable'], ['Log.enable'], ['Network.enable', { maxPostDataSize: 0 }],
    ].map(([m, prm]) => withTimeoutFn(chrome.debugger.sendCommand(t, m, prm), 4000, () => `${m} timed out`).catch((e) => {
      if (/timed out/.test(e.message)) hung.push(m); else throw e;
    })));
    if (hung.length) d.stalled = `${hung.join(', ')} did not answer`;
    // Make the page believe it has focus even if the window is in the background.
    await withTimeoutFn(chrome.debugger.sendCommand(t, 'Emulation.setFocusEmulationEnabled', { enabled: true }), 3000, () => 'focus emulation timed out').catch(() => {});
  })();
  try { await d.attaching; } catch (e) { d.cdpUnavailable = e.message; throw e; } finally { d.attaching = null; }
  return d;
}
async function detach(tabId) {
  const d = dbg.get(tabId);
  if (d?.attached) { d.attached = false; await chrome.debugger.detach({ tabId }).catch(() => {}); }
}
async function canCdp(tabId) {
  try { await withTimeoutFn(attach(tabId), 8000, () => 'attach timed out'); return true; } catch { return false; }
}
// The bridge only works inside sessions the user already has. It never reads
// cookies or credentials, so these CDP methods are refused outright.
const FORBIDDEN_CDP = /^(Network\.(getCookies|getAllCookies|setCookie|setCookies|deleteCookies|clearBrowserCookies)|Storage\.(getCookies|setCookies|clearCookies|clearDataForOrigin)|Security\.)/;
const PASSWORD_REFUSAL = 'Refused: the browser bridge never types into password fields or performs logins. Log in yourself in the browser; Claude then works inside that session.';

async function cdp(tabId, method, params = {}, timeoutMs = 15_000) {
  if (FORBIDDEN_CDP.test(method)) throw new Error(`Refused: ${method} is blocked (the bridge never accesses cookies or credentials).`);
  checkRun(tabId);
  await attach(tabId);
  // The dialog note is built when the timeout fires (a dialog often opens
  // during the command, e.g. beforeunload during Page.navigate).
  return withTimeoutFn(chrome.debugger.sendCommand({ tabId }, method, params), timeoutMs, () => `${method} timed out after ${timeoutMs}ms${dialogNote(tabId)}`);
}
const withTimeoutFn = (p, ms, msgFn) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msgFn())), ms); })]).finally(() => clearTimeout(t));
};
function dialogNote(tabId) {
  const dl = dbg.get(tabId)?.dialog;
  return dl ? ` (a JavaScript ${dl.type} dialog is open${dl.message ? `: "${dl.message}"` : ''} - use browser_dialog)` : '';
}

// ---------------------------------------------------------------------------
// per-tab run tracking: current step, watchdog, cancellation
// ---------------------------------------------------------------------------
// One command runs per tab at a time. Each records the step it is on, so a
// call that stops answering can say where it stopped. A command that was
// abandoned (watchdog fired, hub gave up, or a newer command for the same tab
// arrived) is cancelled: its next CDP/content-script call throws instead of
// acting on the page minutes later.
const runs = new Map(); // tabId -> {id, method, step, stepAt, started, cancelled}
let runSeq = 0;
class Cancelled extends Error {}
function checkRun(tabId) {
  const r = runs.get(tabId);
  if (r?.cancelled) throw new Cancelled(`command ${r.method} was cancelled (${r.cancelled})`);
}
function step(tabId, what) {
  const r = runs.get(tabId);
  if (r) { r.step = what; r.stepAt = Date.now(); }
  checkRun(tabId);
}
const DIALOG_OK = new Set(['dialog', 'status', 'tabs', 'console', 'network', 'close', 'reload', 'open', 'cancel']);
class TabBlocked extends Error {}
function blockedError(tabId, r) {
  const dl = dbg.get(tabId)?.dialog;
  const kind = dl.type === 'beforeunload' ? 'beforeunload ("Leave site? Changes you made may not be saved")' : dl.type;
  return new TabBlocked(`tab blocked by a JavaScript ${kind} dialog${dl.message ? ` "${dl.message}"` : ''}${r ? ` while ${r.step || 'starting'}` : ''}. `
    + 'The page cannot run anything until it is answered: call browser_dialog (accept:true leaves/discards, accept:false stays)'
    + `${dl.type === 'beforeunload' ? ', or pass onBeforeUnload to browser_navigate' : ''}.`);
}

chrome.debugger.onDetach.addListener((src, reason) => {
  const d = dbg.get(src.tabId);
  if (d) { d.attached = false; d.inflight.clear(); if (reason === 'canceled_by_user') d.cdpUnavailable = 'debugger detached by user'; }
});

function pushCapped(arr, item, cap) { arr.push(item); if (arr.length > cap) arr.splice(0, arr.length - cap); }
function argText(a) {
  if (a.type === 'string') return a.value;
  if ('value' in a) return JSON.stringify(a.value);
  return a.unserializableValue || a.description || a.type;
}

chrome.debugger.onEvent.addListener((src, method, p) => {
  const d = dbg.get(src.tabId);
  if (!d) return;
  switch (method) {
    case 'Runtime.consoleAPICalled': {
      const frame = p.stackTrace?.callFrames?.[0];
      pushCapped(d.console, {
        seq: ++d.consoleSeq, time: Date.now(), level: p.type === 'warn' ? 'warning' : p.type,
        text: (p.args || []).map(argText).join(' ').slice(0, 2000),
        source: frame ? `${frame.url}:${frame.lineNumber + 1}` : undefined,
      }, CONSOLE_CAP);
      break;
    }
    case 'Runtime.exceptionThrown': {
      const ex = p.exceptionDetails;
      pushCapped(d.console, {
        seq: ++d.consoleSeq, time: Date.now(), level: 'error', exception: true,
        text: (ex.exception?.description || ex.text || 'exception').slice(0, 2000),
        source: ex.url ? `${ex.url}:${ex.lineNumber + 1}` : undefined,
      }, CONSOLE_CAP);
      break;
    }
    case 'Log.entryAdded': {
      const e = p.entry;
      pushCapped(d.console, {
        seq: ++d.consoleSeq, time: Date.now(), level: e.level === 'verbose' ? 'debug' : e.level,
        text: e.text.slice(0, 2000), source: e.url,
      }, CONSOLE_CAP);
      break;
    }
    case 'Page.frameNavigated':
      if (!p.frame.parentId) {
        pushCapped(d.console, { seq: ++d.consoleSeq, time: Date.now(), level: 'info', text: `[navigated] ${p.frame.url}` }, CONSOLE_CAP);
      }
      break;
    case 'Page.javascriptDialogOpening':
      d.dialog = { type: p.type, message: p.message, defaultPrompt: p.defaultPrompt, url: p.url };
      break;
    case 'Page.javascriptDialogClosed':
      d.dialog = null;
      break;
    case 'Network.requestWillBeSent': {
      const r = {
        seq: ++d.netSeq, id: p.requestId, time: Date.now(), method: p.request.method, url: p.request.url,
        type: p.type, status: null, ok: null,
      };
      if (p.redirectResponse) {
        const prev = d.network.get(p.requestId);
        if (prev) { prev.status = p.redirectResponse.status; prev.ok = true; prev.redirected = true; d.network.delete(p.requestId); d.network.set(`${p.requestId}#${prev.seq}`, prev); }
      }
      d.network.set(p.requestId, r);
      if (d.network.size > NETWORK_CAP) d.network.delete(d.network.keys().next().value);
      if (!isLongLived(r)) d.inflight.set(p.requestId, Date.now());
      break;
    }
    case 'Network.responseReceived': {
      const r = d.network.get(p.requestId);
      if (r) { r.status = p.response.status; r.statusText = p.response.statusText; r.mimeType = p.response.mimeType; r.ok = p.response.status < 400; }
      break;
    }
    case 'Network.loadingFinished': {
      const r = d.network.get(p.requestId);
      if (r) { r.done = true; r.durationMs = Date.now() - r.time; r.bytes = p.encodedDataLength; }
      d.inflight.delete(p.requestId);
      break;
    }
    case 'Network.loadingFailed': {
      const r = d.network.get(p.requestId);
      if (r) { r.done = true; r.ok = false; r.failed = true; r.errorText = p.errorText; r.canceled = p.canceled; r.blockedReason = p.blockedReason; }
      d.inflight.delete(p.requestId);
      break;
    }
  }
});
// Telemetry beacons that fail routinely; still listed by browser_network.
const NOISE_URL = /InstrumentationBeacon|\/_ui\/common\/request\/servlet|\/csp-report/i;
function isLongLived(r) {
  return r.type === 'EventSource' || r.type === 'WebSocket' || /\/cometd\/|\/longpoll|event-?stream/i.test(r.url);
}

// ---------------------------------------------------------------------------
// waiting
// ---------------------------------------------------------------------------
async function waitForLoad(tabId, timeoutMs = 30_000) {
  const start = Date.now();
  await sleep(150);
  while (Date.now() - start < timeoutMs) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) throw new Error(`tab ${tabId} closed`);
    if (t.status === 'complete') return true;
    if (dbg.get(tabId)?.dialog) return false;
    await sleep(100);
  }
  return false;
}
// Network idle: no in-flight (non long-poll) request for `quietMs`.
async function waitIdle(tabId, { quietMs = 500, timeoutMs = 5000 } = {}) {
  const d = dbg.get(tabId);
  if (!d?.attached) { await sleep(Math.min(700, timeoutMs)); return false; }
  const start = Date.now();
  let quietSince = Date.now();
  while (Date.now() - start < timeoutMs) {
    const now = Date.now();
    let busy = false;
    for (const [id, t] of d.inflight) {
      if (now - t > 15_000) d.inflight.delete(id); // stuck/long request: ignore
      else busy = true;
    }
    if (busy || d.dialog) quietSince = now;
    else if (now - quietSince >= quietMs) return true;
    await sleep(100);
  }
  return false;
}

// ---------------------------------------------------------------------------
// content-script calls
// ---------------------------------------------------------------------------
async function inject(tabId, frameIds) {
  await ready;
  const target = frameIds ? { tabId, frameIds } : { tabId, allFrames: true };
  // Remove a content script left by a previous extension load, then inject.
  const t = (p) => withTimeoutFn(p, 10_000, () => `inject timed out${dialogNote(tabId)}`);
  await t(chrome.scripting.executeScript({
    target, func: (boot) => { if (globalThis.__cbb && globalThis.__cbbBoot !== boot) delete globalThis.__cbb; }, args: [S.boot],
  })).catch(() => {});
  await t(chrome.scripting.executeScript({ target, files: ['content.js'] }))
    .catch(() => {}); // some frames (chrome-error://, sandboxed) refuse; ignore
  await t(chrome.scripting.executeScript({ target, func: (boot) => { globalThis.__cbbBoot = boot; }, args: [S.boot] })).catch(() => {});
}
// A page blocked by a JavaScript dialog (or a hung renderer) never answers
// executeScript, so every content-script call has its own timeout.
const FRAME_TIMEOUT_MS = 20_000;
async function callFrame(tabId, frameId, method, params = {}) {
  await ready;
  checkRun(tabId);
  const run = () => withTimeoutFn(chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: (m, p, boot) => (globalThis.__cbb && globalThis.__cbbBoot === boot
      ? globalThis.__cbb.call(m, p).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: String(e?.message || e) }))
      : { missing: true }),
    args: [method, params, S.boot],
  }), params.__timeoutMs || FRAME_TIMEOUT_MS, () => `page did not answer "${method}" in frame ${frameId} within ${params.__timeoutMs || FRAME_TIMEOUT_MS}ms${dialogNote(tabId)}`);
  let [res] = await run();
  checkRun(tabId);
  if (res?.result?.missing) {
    await inject(tabId, [frameId]);
    [res] = await run();
  }
  const out = res?.result;
  if (!out) throw new Error(`could not run in frame ${frameId} (${res?.error?.message || 'no result'})`);
  if (out.missing) throw new Error(`content script could not be injected into frame ${frameId}`);
  if (!out.ok) throw new Error(out.e);
  return out.r;
}
async function frames(tabId) {
  const all = (await chrome.webNavigation.getAllFrames({ tabId })) || [{ frameId: 0, parentFrameId: -1, url: '' }];
  return all
    .filter((f) => f.frameId === 0 || (!f.errorOccurred && /^(https?|file|about):/.test(f.url) && f.url !== 'about:blank'))
    .sort((a, b) => (a.frameId === 0 ? -1 : b.frameId === 0 ? 1 : a.frameId - b.frameId));
}
const prefixFor = (frameId) => (frameId ? `f${frameId}` : '');
// True if `method` returns truthy in any frame of the tab.
async function anyFrame(tabId, method, params = {}) {
  for (const f of await frames(tabId)) {
    if (await callFrame(tabId, f.frameId, method, params).catch(() => false)) return true;
  }
  return false;
}
function parseRef(ref) {
  const m = /^(?:f(\d+))?e(\d+)$/.exec(String(ref).trim().replace(/^ref=/, ''));
  if (!m) throw new Error(`bad ref "${ref}" - expected something like "e12" or "f3e12" from browser_snapshot`);
  return { frameId: Number(m[1] || 0), ref: Number(m[2]) };
}

// Resolve {ref|selector|text} to {frameId, params, el} (params uses a numeric ref).
// Auto-wait: Lightning renders lazily, so a target that is not there yet is
// retried until `timeoutMs` (default 5s) before giving up.
// If the target is still missing after a short wait, scroll the page (or the
// open modal) step by step: Lightning only renders sections near the viewport.
async function locate(tabId, target) {
  const timeoutMs = target.timeoutMs ?? 5000;
  const deadline = Date.now() + timeoutMs;
  const scrollFrom = Date.now() + Math.min(1500, timeoutMs);
  const canScroll = !target.ref && target.scrollToFind !== false && timeoutMs > 0;
  let scrollDone = false;
  let steps = 0;
  step(tabId, `locating ${describeTarget(target)}`);
  for (;;) {
    checkRun(tabId);
    try {
      return await locateOnce(tabId, target);
    } catch (e) {
      if (/^bad ref|give a target/.test(e.message) || e instanceof Cancelled || e instanceof TabBlocked) throw e;
      if (canScroll && !scrollDone && Date.now() > scrollFrom) {
        const r = await scrollStepIn(tabId, target.scope);
        steps++;
        scrollDone = r.atEnd || !r.moved || steps >= 40;
        await waitIdle(tabId, { quietMs: 300, timeoutMs: 2500 });
        continue;
      }
      if (Date.now() > deadline) {
        if (steps) e.message += ` (also scrolled ${steps} step(s) to load lazy content)`;
        throw e;
      }
      await sleep(300);
    }
  }
}
async function scrollStepIn(tabId, scope, extra = {}) {
  const inModal = scope !== 'page' && (await callFrame(tabId, 0, 'modalState').catch(() => ({ open: false }))).open;
  return callFrame(tabId, 0, 'scrollStep', { ...extra, inModal }).catch(() => ({ atEnd: true, moved: false }));
}
// Scroll through the whole page so lazily rendered sections exist, then back to top.
async function loadAllContent(tabId, maxSteps = 40) {
  let steps = 0;
  for (; steps < maxSteps; steps++) {
    const r = await scrollStepIn(tabId, 'page');
    await waitIdle(tabId, { quietMs: 300, timeoutMs: 2500 });
    if (r.atEnd || !r.moved) break;
  }
  await scrollStepIn(tabId, 'page', { toTop: true });
  // sections that just came into view are still fetching their data
  await sleep(300);
  await waitIdle(tabId, { quietMs: 800, timeoutMs: 8000 });
  return steps;
}
async function locateOnce(tabId, target) {
  if (target.ref) {
    const { frameId, ref } = parseRef(target.ref);
    const el = await callFrame(tabId, frameId, 'find', { ref, prefix: prefixFor(frameId) });
    if (!el) throw new Error(`ref ${target.ref} is stale or gone. Take a new browser_snapshot.`);
    return { frameId, params: { ref, prefix: prefixFor(frameId) }, el };
  }
  if (!target.selector && !target.text) throw new Error('give a target: ref (from browser_snapshot), selector, or text');
  const list = target.frame != null ? [{ frameId: Number(target.frame) }] : await frames(tabId);
  let lastErr = null;
  for (const f of list) {
    const el = await callFrame(tabId, f.frameId, 'find', {
      selector: target.selector, text: target.text, exact: target.exact, role: target.role,
      scope: target.scope || 'auto', within: target.within, index: target.index, prefix: prefixFor(f.frameId),
    }).catch((e) => { if (/out of range|no section, card/.test(e.message)) lastErr = e; return null; });
    if (el) {
      const { ref } = parseRef(el.ref);
      return { frameId: f.frameId, params: { ref, prefix: prefixFor(f.frameId) }, el };
    }
  }
  if (lastErr) throw lastErr;
  throw new Error(`no element matches ${JSON.stringify(target.selector ? { selector: target.selector } : { text: target.text, within: target.within, role: target.role })} in any frame`);
}
const describeTarget = (t) => (t.ref ? `ref ${t.ref}` : t.selector ? `selector ${t.selector}` : `"${t.text}"${t.role ? ` (${[].concat(t.role).join('/')})` : ''}`);
const describeEl = (el) => `${el.role} "${el.name || ''}" (${el.ref})`;
// Warn when a text/selector target matched several elements.
const ambiguity = (el, target) => (el?.matchCount > 1 && !target.index
  ? `${el.matchCount} elements match; used #1. Pass index (1-${el.matchCount}) or within (a section/card label) to choose another.`
  : undefined);

// ---------------------------------------------------------------------------
// input via CDP
// ---------------------------------------------------------------------------
const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 }, Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 }, Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 }, ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 }, ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 }, End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 }, PageDown: { code: 'PageDown', keyCode: 34 },
  Insert: { code: 'Insert', keyCode: 45 },
};
for (let i = 1; i <= 12; i++) KEYS[`F${i}`] = { code: `F${i}`, keyCode: 111 + i };
const KEY_ALIASES = { esc: 'Escape', return: 'Enter', del: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', ' ': 'Space', spacebar: 'Space' };
const MODS = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
const EDIT_COMMANDS = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo', y: 'redo' };

async function pressKey(tabId, combo) {
  const parts = combo.split('+').map((s) => s.trim()).filter(Boolean);
  let keyName = parts.pop() || combo;
  let modifiers = 0;
  for (const m of parts) {
    const bit = MODS[m.toLowerCase()];
    if (!bit) throw new Error(`unknown modifier "${m}" (use Control, Shift, Alt, Meta)`);
    modifiers |= bit;
  }
  keyName = KEY_ALIASES[keyName.toLowerCase()] || keyName;
  let def = KEYS[keyName] || KEYS[keyName[0].toUpperCase() + keyName.slice(1)];
  if (!def) {
    if ([...keyName].length !== 1) throw new Error(`unknown key "${keyName}"`);
    const ch = (modifiers & 8) ? keyName.toUpperCase() : keyName;
    const up = keyName.toUpperCase();
    def = {
      key: ch, code: /[a-z]/i.test(keyName) ? `Key${up}` : /\d/.test(keyName) ? `Digit${keyName}` : '',
      keyCode: /[a-z0-9]/i.test(keyName) ? up.charCodeAt(0) : 0, text: ch,
    };
  }
  const key = def.key || keyName;
  const plainText = (modifiers & 7) ? undefined : def.text;
  const commands = (modifiers & 6) && EDIT_COMMANDS[key.toLowerCase()] ? [EDIT_COMMANDS[key.toLowerCase()]] : undefined;
  const base = { key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers };
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: plainText ? 'keyDown' : 'rawKeyDown', text: plainText, unmodifiedText: plainText, commands }, 5000);
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, 5000);
}

async function mouseClick(tabId, x, y, { button = 'left', double = false } = {}) {
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, 5000);
  for (let n = 1; n <= (double ? 2 : 1); n++) {
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'right' ? 2 : 1, clickCount: n }, 5000);
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: n }, 5000);
  }
}

// Coordinates of an element in the top-level viewport (handles nested iframes).
async function pointOf(tabId, loc) {
  if (loc.frameId !== 0) await inject(tabId); // every frame must answer frame-offset queries
  return callFrame(tabId, loc.frameId, 'point', loc.params);
}

// ---------------------------------------------------------------------------
// result reporting
// ---------------------------------------------------------------------------
// Taken at the start of every action. Besides the console/network positions it
// stamps the alerts visible now (content alertsMark), so the action's report
// lists only alerts it produced; older ones go to `staleAlerts`.
const alertEpochs = new Map(); // tabId -> last mark epoch
async function marks(tabId) {
  const d = dbg.get(tabId);
  const epoch = (alertEpochs.get(tabId) || 0) + 1;
  alertEpochs.set(tabId, epoch);
  if (!d?.dialog) await callFrame(tabId, 0, 'alertsMark', { epoch }).catch(() => null);
  return { consoleSeq: d?.consoleSeq || 0, netSeq: d?.netSeq || 0, epoch };
}
async function pageReport(tabId, before, { alerts = true } = {}) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const out = { tabId, title: tab?.title, url: tab?.url };
  const d = dbg.get(tabId);
  if (d?.dialog) out.dialog = d.dialog;
  if (alerts && !d?.dialog) {
    const a = await callFrame(tabId, 0, 'alerts').catch(() => null);
    if (a?.alerts?.length) out.alerts = a.alerts;
    if (a?.stale?.length) out.staleAlerts = a.stale;
    if (a?.reused?.length) out.reusedAlerts = a.reused;
    if (a?.modal) out.openModal = a.modal;
  }
  if (before && d) {
    const errs = d.console.filter((c) => c.seq > before.consoleSeq && c.level === 'error' && !NOISE_URL.test(c.source || ''));
    if (errs.length) out.newConsoleErrors = errs.slice(-5).map((c) => c.text.slice(0, 300));
    const bad = [...d.network.values()].filter((r) => r.seq > before.netSeq && r.ok === false && !r.canceled && !NOISE_URL.test(r.url));
    if (bad.length) out.failedRequests = bad.slice(-5).map((r) => `${r.method} ${r.status ?? r.errorText} ${r.url.slice(0, 200)}`);
  }
  return out;
}
async function settle(tabId, timeoutMs = 3000) {
  step(tabId, 'waiting for the page to settle');
  await sleep(120);
  await waitIdle(tabId, { quietMs: 400, timeoutMs });
  // Lightning shows "Loading..." as the title while it builds the next view
  await poll(async () => !/^Loading\b/i.test((await chrome.tabs.get(tabId)).title || ''), 10_000, 250);
  // A modal still loading (empty shell, spinner, controls still appearing)
  // is not settled: wait until its control count is stable.
  let prev = -1;
  let stable = 0;
  await poll(async () => {
    const m = await callFrame(tabId, 0, 'modalState').catch(() => ({ open: false }));
    if (!m.open) return true;
    stable = m.ready && m.controls === prev ? stable + 1 : 0;
    prev = m.controls;
    return stable >= 2;
  }, 8000, 250);
}

// Merge alerts/toasts seen while waiting into the report's `alerts`.
function withToasts(report, outcome) {
  if (outcome?.toasts?.length) {
    const all = [...(report.alerts || [])];
    for (const t of outcome.toasts) if (!all.includes(t)) all.push(t);
    report.alerts = all;
  }
  if (report.submitted?.outcome?.result) report.submitted.outcome = report.submitted.outcome.result;
  return report;
}
// Buttons that commit a modal/flow screen; after them we wait for the outcome.
const COMMIT_BUTTON = /^(save|save & new|next|finish|submit|delete|done|confirm|ok|yes|apply|change owner|send)\b/i;
const currentModal = (tabId) => callFrame(tabId, 0, 'modalState').then((m) => (m.open ? m.title : null)).catch(() => null);
// After committing a modal, wait (up to 15s) until it closes, changes
// (next flow screen / error popover) or shows an error/toast.
// Toasts are transient, so every alert seen while waiting is collected.
async function awaitOutcome(tabId, modalBefore, timeoutMs = 15_000) {
  step(tabId, `waiting for the outcome of "${modalBefore}"`);
  const start = Date.now();
  const seen = [];
  const collect = async () => {
    const a = await callFrame(tabId, 0, 'alerts').catch(() => null);
    for (const t of a?.alerts || []) if (!seen.includes(t)) seen.push(t);
    return (a?.alerts || []).join(' ');
  };
  let res = 'still open';
  await poll(async () => {
    const txt = await collect();
    const m = await callFrame(tabId, 0, 'modalState').catch(() => ({ open: false }));
    if (!m.open) { res = 'modal closed'; return true; }
    if (m.title !== modalBefore) { res = `modal changed: ${m.title}`; return true; }
    if (/error|snag|complete this field|required|invalid|duplicate|can't|cannot/i.test(txt)) { res = 'error shown'; return true; }
    return false;
  }, timeoutMs, 300);
  // a success toast usually appears right after the modal closes
  if (res === 'modal closed') await poll(async () => /success|was (created|saved|deleted)/i.test(await collect()), 4000, 250);
  await settle(tabId, 3000);
  await collect();
  return { result: `${res} after ${((Date.now() - start) / 1000).toFixed(1)}s`, toasts: seen };
}

// After Save in a record page's inline edit: wait until the editor closes
// (Save button gone) or an error shows. Toasts seen meanwhile are collected.
async function awaitInlineOutcome(tabId, saveLoc, timeoutMs = 15_000) {
  step(tabId, 'waiting for the inline edit save');
  const start = Date.now();
  const seen = [];
  const collect = async () => {
    const a = await callFrame(tabId, 0, 'alerts').catch(() => null);
    for (const t of a?.alerts || []) if (!seen.includes(t)) seen.push(t);
    return (a?.alerts || []).join(' ');
  };
  let res = 'still editing';
  await poll(async () => {
    const txt = await collect();
    const s = await callFrame(tabId, saveLoc.frameId, 'optionState', saveLoc.params).catch(() => ({ gone: true }));
    if (s.gone) { res = 'saved (inline edit closed)'; return true; }
    if (/error|snag|complete this field|required|invalid|duplicate|can't|cannot|review the errors/i.test(txt)) { res = 'error shown (still editing)'; return true; }
    return false;
  }, timeoutMs, 300);
  if (res.startsWith('saved')) await poll(async () => /saved|success/i.test(await collect()), 3000, 250);
  await settle(tabId, 2000);
  await collect();
  return { result: `${res} after ${((Date.now() - start) / 1000).toFixed(1)}s`, toasts: seen };
}

// Click a located element. Trusted CDP click at its coordinates when possible,
// DOM click as fallback (or when method === 'dom').
// Element the last click / typing went to (outlined in evidence screenshots).
const lastTarget = new Map(); // tabId -> {loc, label, at}
const noteTarget = (tabId, loc) => lastTarget.set(tabId, { loc, label: describeEl(loc.el).replace(/ \((f\d+)?e\d+\)$/, ''), at: Date.now() });

async function clickLoc(tabId, loc, { method = 'auto', button, double } = {}) {
  step(tabId, `clicking ${describeEl(loc.el)}`);
  noteTarget(tabId, loc);
  let note;
  if (method !== 'dom' && await canCdp(tabId)) {
    const pt = await pointOf(tabId, loc);
    if (pt.offsetError) note = `could not compute iframe offset (${pt.offsetError})`;
    else if (!pt.inView) note = 'element not in viewport after scrolling';
    else if (pt.covered && method === 'auto') note = `element is covered by ${pt.coveredBy}; used a DOM click instead`;
    else {
      if (pt.covered) note = `element is covered by ${pt.coveredBy}; the click went to that element`;
      const pick = method === 'auto' && /^(option|menuitem|menuitemradio|menuitemcheckbox)$/.test(loc.el.role);
      const toggle = method === 'auto' && !double && /^(radio|checkbox|switch)$/.test(loc.el.role);
      const stateBefore = pick || toggle ? await callFrame(tabId, loc.frameId, 'optionState', loc.params).catch(() => null) : null;
      await mouseClick(tabId, pt.x, pt.y, { button, double });
      if (stateBefore && !stateBefore.gone) return { how: await confirmPick(tabId, loc, stateBefore, toggle), note };
      return { how: 'trusted', note };
    }
    if (method === 'cdp') throw new Error(`trusted click impossible: ${note}`);
  }
  await callFrame(tabId, loc.frameId, 'domClick', { ...loc.params, double });
  return { how: 'dom', note };
}

// Some Lightning dropdowns (e.g. App Launcher inside a console app) ignore a
// trusted click on an option. A pick took effect if the option disappeared or
// its selected state changed; otherwise retry with a DOM click, then Enter.
async function confirmPick(tabId, loc, before, toggle = false) {
  const urlBefore = (await chrome.tabs.get(tabId)).url;
  const took = () => poll(async () => {
    if ((await chrome.tabs.get(tabId)).url !== urlBefore) return true; // navigated
    const s = await callFrame(tabId, loc.frameId, 'optionState', loc.params).catch(() => ({ gone: true }));
    return s.gone || s.selected !== before.selected;
  }, toggle ? 1200 : 2500, 200);
  if (await took()) return 'trusted';
  if (toggle) {
    // radio/checkbox ignored the click (e.g. re-rendered underneath): aim again
    const pt = await pointOf(tabId, loc).catch(() => null);
    if (pt?.inView && !pt.covered) {
      await mouseClick(tabId, pt.x, pt.y);
      if (await took()) return 'trusted (second attempt)';
    }
    await callFrame(tabId, loc.frameId, 'domClick', loc.params).catch(() => {});
    if (await took()) return 'trusted, then dom';
    return 'trusted (state did not change)';
  }
  await callFrame(tabId, loc.frameId, 'domClick', loc.params).catch(() => {});
  if (await took()) return 'trusted, then dom (trusted click was ignored)';
  await callFrame(tabId, loc.frameId, 'focus', loc.params).catch(() => {});
  await pressKey(tabId, 'Enter');
  if (await took()) return 'trusted, dom, then Enter key';
  return 'trusted (no visible effect)';
}

// Type into a located element (focus by click, optional clear, insert text).
// Short text is typed key by key (real keydown/keyup: filters and type-ahead
// listen to those); long text is inserted in one go.
async function typeLoc(tabId, loc, text, { clear = true, slowly, method = 'auto' } = {}) {
  slowly = slowly ?? text.length <= 60;
  if (loc.el.type === 'password') throw new Error(PASSWORD_REFUSAL);
  step(tabId, `typing into ${describeEl(loc.el)}`);
  noteTarget(tabId, loc);
  const nativeOnly = ['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'].includes(loc.el.type);
  if (method === 'dom' || nativeOnly || !(await canCdp(tabId))) {
    await callFrame(tabId, loc.frameId, 'domType', { ...loc.params, text, clear });
    return 'dom';
  }
  const pt = await pointOf(tabId, loc);
  if (pt.inView && !pt.covered && !pt.offsetError) await mouseClick(tabId, pt.x, pt.y);
  else await callFrame(tabId, loc.frameId, 'focus', loc.params);
  if (clear) {
    const sel = await callFrame(tabId, loc.frameId, 'selectForClear', loc.params);
    if (sel.hasContent) await pressKey(tabId, 'Backspace');
  }
  if (slowly) {
    for (const ch of text) {
      if (ch === '\n') await pressKey(tabId, 'Enter');
      else {
        await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch }, 5000);
        await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ch }, 5000);
      }
      await sleep(30);
    }
  } else if (text) {
    await cdp(tabId, 'Input.insertText', { text }, 10_000);
  }
  return 'trusted';
}

// Poll `fn` until it returns a truthy value or the timeout passes.
async function poll(fn, timeoutMs, everyMs = 200) {
  const start = Date.now();
  for (;;) {
    const v = await fn().catch((e) => { if (e instanceof Cancelled || e instanceof TabBlocked) throw e; return null; });
    if (v || Date.now() - start > timeoutMs) return v;
    await sleep(everyMs);
  }
}
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
function pickOption(options, value) {
  const w = norm(value);
  return options.find((o) => norm(o.name) === w || norm(o.title) === w)
    || options.find((o) => norm(o.title).startsWith(w) || norm(o.name).startsWith(w))
    || options.find((o) => norm(o.name).includes(w));
}
const asList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/\s*[,;]\s*/)).map(String).filter(Boolean);
const asBool = (v) => (typeof v === 'boolean' ? v : /^(true|yes|y|1|on|checked)$/i.test(String(v).trim()));

// Locate a form field by its visible label across frames (modal first).
async function locateField(tabId, label, opts = {}) {
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  step(tabId, `locating field "${label}"`);
  for (;;) {
    checkRun(tabId);
    try {
      return await locateFieldOnce(tabId, label, opts);
    } catch (e) {
      if (Date.now() > deadline || e instanceof Cancelled || e instanceof TabBlocked) throw e;
      await sleep(300);
    }
  }
}
async function locateFieldOnce(tabId, label, { exact, scope, frame, skip, kind, within, index, inline } = {}) {
  const list = frame != null ? [{ frameId: Number(frame) }] : await frames(tabId);
  let lastErr = null;
  for (const f of list) {
    const field = await callFrame(tabId, f.frameId, 'findField', { label, exact, scope: scope || 'auto', skip, kind, within, index, inline, prefix: prefixFor(f.frameId) })
      .catch((e) => { if (e instanceof Cancelled || e instanceof TabBlocked) throw e; if (/out of range|no section, card/.test(e.message)) lastErr = e; return null; });
    if (field) {
      const { ref } = parseRef(field.ref);
      return { frameId: f.frameId, params: { ref, prefix: prefixFor(f.frameId) }, el: field, field };
    }
  }
  if (lastErr) throw lastErr;
  throw new Error(`no form field labelled "${label}"${kind ? ` of kind ${kind}` : ''}${within ? ` within "${within}"` : ''} found${scope && scope !== 'auto' ? ` in scope ${scope}` : ' (searched the open modal first, then the page)'}`);
}
const locFromRef = (refStr, el) => {
  const { frameId, ref } = parseRef(refStr);
  return { frameId, params: { ref, prefix: prefixFor(frameId) }, el };
};

// ---------------------------------------------------------------------------
// lookups
// ---------------------------------------------------------------------------
const LOOKUP_JUNK = /^(search|show (all|more) results|new\b|add\b|\+|recent|advanced search|"[^"]*" in )/i;
const LOOKUP_FULL = /^(search\b|show (all|more) results|advanced search|"[^"]*" in )/i;
function netBusy(tabId) {
  const d = dbg.get(tabId);
  if (!d?.attached) return false;
  const now = Date.now();
  for (const t of d.inflight.values()) if (now - t < 15_000) return true;
  return false;
}
// Search-ish requests since `netSeq` (Aura puts the action names in the URL).
function searchRequests(tabId, netSeq) {
  const d = dbg.get(tabId);
  if (!d) return [];
  return [...d.network.values()]
    .filter((r) => r.seq > netSeq && /lookup|search|typeahead|getRecords|mru/i.test(r.url) && !NOISE_URL.test(r.url))
    .slice(-3)
    .map((r) => `${r.method} ${r.status ?? (r.failed ? r.errorText : 'pending')}${r.durationMs != null ? ` ${r.durationMs}ms` : ''} ${r.url.replace(/^https?:\/\/[^/]+/, '').slice(0, 140)}`);
}
const fieldError = (msg, details) => Object.assign(new Error(msg), { details });

// Type into a lookup and pick `value`. When nothing matches, the error says
// which of these happened (details.status):
//   searching  - a spinner was still visible (or requests in flight) when the wait ended
//   no-results - the search finished (no spinner, network idle) and Salesforce listed no record
//   no-match   - records came back but none matched (they are listed)
// spec.fullSearch: also run the full search ("Search <Object>..." / "Show all
// results") and report its result count and rows; a matching row is picked.
// After clicking a lookup option: does the field now hold a selection?
async function lookupTook(tabId, label, spec, opt) {
  await settle(tabId, 2000);
  const f = await locateFieldOnce(tabId, label, { ...spec, exact: true, index: undefined, inline: false }).catch(() => null);
  if (!f) return { ok: true, note: 'field not found again after the pick (editor closed?)' }; // e.g. a modal that closed
  const v = f.field.value || '';
  return { ok: f.field.kind === 'pill' || (norm(v).includes(norm(opt.title)) && f.field.kind !== 'lookup'), shows: v };
}
async function fillLookup(tabId, loc, spec) {
  const { label, value } = spec;
  const fieldLabel = loc.field?.fieldLabel || label;
  const search = String(spec.search ?? value);
  const netSeq = dbg.get(tabId)?.netSeq || 0;
  const t0 = Date.now();
  await typeLoc(tabId, loc, search, { clear: true, slowly: spec.slowly ?? true });
  const typedMs = Date.now() - t0;
  step(tabId, `waiting for lookup results for "${search}"`);
  const waitMs = spec.timeoutMs || 8000;
  let tw = Date.now();
  let last = { options: [], real: [] };
  let quietSince = null;
  let attempts = 0;
  for (;;) {
    checkRun(tabId);
    const r = await callFrame(tabId, loc.frameId, 'listOptions', loc.params).catch((e) => {
      if (e instanceof Cancelled || e instanceof TabBlocked) throw e;
      return { open: false, options: [] };
    });
    const real = r.options.filter((o) => !LOOKUP_JUNK.test(o.title));
    const opt = pickOption(real, value);
    if (opt) {
      // The dropdown re-renders while results arrive (e.g. "Recent Items" are
      // replaced by search results): pick only from a settled list.
      if ((r.spinner || netBusy(tabId)) && Date.now() - tw < waitMs) { await sleep(250); continue; }
      await clickLoc(tabId, locFromRef(opt.ref, { role: 'option', name: opt.name, ref: opt.ref }));
      const took = await lookupTook(tabId, fieldLabel, spec, opt);
      if (took.ok) return null;
      if (++attempts >= 2) {
        throw fieldError(`"${label}": clicked "${opt.title}" twice but the lookup did not take it (the field still shows "${took.shows}")`, {
          status: 'not-picked', typed: search, option: opt.title, shows: took.shows,
        });
      }
      // retype and pick again from a fresh list
      step(tabId, `lookup did not take "${opt.title}"; typing "${search}" again`);
      loc = await locateField(tabId, fieldLabel, { ...spec, exact: true, index: undefined, inline: false, timeoutMs: 3000 }).catch(() => loc);
      await typeLoc(tabId, loc, search, { clear: true, slowly: spec.slowly ?? true });
      tw = Date.now();
      quietSince = null;
      continue;
    }
    last = { ...r, real };
    // Final once nothing has been loading for 1.5s: no spinner, no request in flight.
    if (!r.spinner && !netBusy(tabId)) quietSince = quietSince ?? Date.now(); else quietSince = null;
    if (quietSince && Date.now() - quietSince >= 1500 && Date.now() - tw >= 1500 && (r.open || r.emptyText)) break;
    if (Date.now() - tw > waitMs) break;
    await sleep(250);
  }
  const waitedMs = Date.now() - tw;
  const status = last.spinner || (netBusy(tabId) && !last.real.length) ? 'searching' : last.real.length ? 'no-match' : 'no-results';
  const shown = last.options.map((o) => o.title);
  const details = {
    status, typed: search, inputValue: last.inputValue, typedMs, waitedMs,
    shown: shown.slice(0, 15), emptyText: last.emptyText || undefined,
    searchRequests: searchRequests(tabId, netSeq),
  };
  const what = {
    'searching': `lookup still searching after ${sec(waitedMs)} (a spinner was visible or a request was still running when the wait ended; try a larger timeoutMs)`,
    'no-results': `lookup search finished with zero results (no spinner, network idle${last.emptyText ? `, Salesforce says "${last.emptyText}"` : ''}; only ${shown.length ? shown.join(' | ') : 'nothing'} shown)`,
    'no-match': `lookup results came back but none matched "${value}": ${last.real.map((o) => o.title).slice(0, 15).join(' | ')}`,
  }[status];
  let msg = `"${label}": ${what}. Typed "${search}" in ${sec(typedMs)} (field shows "${last.inputValue ?? '?'}"), waited ${sec(waitedMs)}.`;

  if (spec.fullSearch) {
    const full = shown.length ? last.options.find((o) => LOOKUP_FULL.test(o.title)) : null;
    let via;
    if (full) {
      step(tabId, `running the full search (${full.title})`);
      await clickLoc(tabId, locFromRef(full.ref, { role: 'option', name: full.name, ref: full.ref }));
      via = `dropdown entry "${full.title}"`;
    } else {
      // No "Search ..." entry: press the search (lens) icon in the input, or Enter.
      step(tabId, 'running the full search (search icon)');
      const lens = await callFrame(tabId, loc.frameId, 'lookupSearchButton', loc.params).catch(() => null);
      if (lens) {
        await clickLoc(tabId, locFromRef(lens.ref, { role: 'button', name: lens.name, ref: lens.ref }));
        via = `search icon "${lens.name}"`;
      } else {
        await callFrame(tabId, loc.frameId, 'focus', loc.params).catch(() => {});
        await pressKey(tabId, 'Enter');
        via = 'Enter in the search box';
      }
    }
    {
      await settle(tabId, 5000);
      const res = await poll(async () => {
        const x = await callFrame(tabId, 0, 'searchResults', {});
        return x?.ready ? x : null;
      }, 12_000, 300) || await callFrame(tabId, 0, 'searchResults', {}).catch(() => null);
      if (!res) {
        details.fullSearch = { via, error: 'the full search did not open a results view' };
      } else {
        details.fullSearch = { via, title: res.title, count: res.count, rows: res.rows.map((r) => r.text).slice(0, 20), emptyText: res.emptyText || undefined };
        const w = norm(value);
        const row = res.rows.find((r) => r.link && (norm(r.linkText) === w || norm(r.linkText).startsWith(w)))
          || res.rows.find((r) => r.link && norm(r.text).includes(w));
        if (row) {
          await clickLoc(tabId, locFromRef(row.link, { role: 'link', name: row.linkText, ref: row.link }));
          await settle(tabId, 3000);
          return { label, kind: 'lookup', value: row.linkText, via: `full search (${res.count} result(s))`, fullSearch: details.fullSearch };
        }
        msg += ` Full search "${res.title}": ${res.count} result(s)${res.rows.length ? `: ${details.fullSearch.rows.slice(0, 10).join(' / ')}` : ''}${res.emptyText ? ` ("${res.emptyText}")` : ''}.`;
        if (res.closeRef) await clickLoc(tabId, locFromRef(res.closeRef, { role: 'button', name: 'Cancel', ref: res.closeRef })).catch(() => {});
        else await pressKey(tabId, 'Escape').catch(() => {});
        await poll(async () => (await currentModal(tabId)) !== res.title, 4000, 250);
      }
    }
  }
  throw fieldError(msg, details);
}

// Fill one field according to its kind. Returns a short result record.
// "3 fields match ...; used #1 ..." when a label matched several fields.
function fieldAmbiguity(field, label) {
  if (!field.candidates) return undefined;
  const c = field.candidates;
  const desc = (x) => `#${x.n} ${x.kind} "${x.label}"${x.section ? ` in ${x.section}` : ''} (${x.match})`;
  return `${c.length} fields match "${label}"; used #1. Pass index, within (section) or kind to choose: ${c.map(desc).join(' | ')}`;
}
async function fillField(tabId, spec) {
  try {
    return await fillFieldInner(tabId, spec);
  } catch (e) {
    // Tell the caller when a wrong field may have been picked.
    if (e.ambiguous && !/fields match/.test(e.message)) e.message += ` [${e.ambiguous}]`;
    throw e;
  }
}
// A record page hides most fields until the Details tab or the Path's key
// fields panel is open. Open them (no data changes) so fields can be found.
// `found()` says whether the field is visible now; reveal stops once it is.
async function revealRecordFields(tabId, found) {
  if (await currentModal(tabId)) return [];
  const done = [];
  const ps = await callFrame(tabId, 0, 'pathState', {}).catch(() => null);
  if (ps?.toggle && !ps.expanded) {
    step(tabId, 'opening the Path key fields panel');
    await clickLoc(tabId, locFromRef(ps.toggle.ref, { role: 'button', name: ps.toggle.name, ref: ps.toggle.ref })).catch(() => {});
    await poll(async () => (await callFrame(tabId, 0, 'pathState', {}))?.keyFields?.length, 4000, 250);
    done.push('opened the Path key fields panel');
    if (await found()) return done;
  }
  const det = await locate(tabId, { text: 'Details', exact: true, role: ['tab'], scope: 'page', timeoutMs: 0, scrollToFind: false }).catch(() => null);
  if (det && (await callFrame(tabId, det.frameId, 'optionState', det.params).catch(() => ({})))?.selected !== 'true') {
    step(tabId, 'opening the Details tab');
    await clickLoc(tabId, det).catch(() => {});
    await settle(tabId, 3000);
    done.push('opened the Details tab');
  }
  return done;
}
async function fillFieldInner(tabId, spec) {
  const { label } = spec;
  let revealed;
  let loc = await locateField(tabId, label, spec).catch(async (e) => {
    if (!/^no form field labelled/.test(e.message) || spec.scope === 'modal') throw e;
    revealed = await revealRecordFields(tabId, () => locateFieldOnce(tabId, label, spec).then(() => true, () => false));
    if (!revealed.length) throw e;
    return locateField(tabId, label, { ...spec, timeoutMs: 3000 }).catch((e2) => { e2.message += ` (after: ${revealed.join(', ')})`; throw e2; });
  });
  const ambiguous = fieldAmbiguity(loc.field, label);
  const matched = loc.field.match && loc.field.match !== 'exact' ? `matched "${loc.field.fieldLabel}" by ${loc.field.match}` : undefined;
  let inlineEdit;
  try {
    if (loc.field.kind === 'inline') {
      // Read-mode record field: open inline edit with its pencil, then fill the editor.
      step(tabId, `opening inline edit for "${loc.field.fieldLabel}"`);
      await clickLoc(tabId, loc);
      await settle(tabId, 3000);
      loc = await locateField(tabId, loc.field.fieldLabel, { ...spec, exact: true, index: undefined, inline: false, timeoutMs: 6000 })
        .catch(() => locateField(tabId, label, { ...spec, index: undefined, inline: false, timeoutMs: 2000 }));
      inlineEdit = true;
    }
    const r = await fillFieldKind(tabId, spec, loc);
    return { ...r, ...(inlineEdit ? { inlineEdit } : {}), ...(revealed?.length ? { revealed: revealed.join(', ') } : {}), ...(ambiguous ? { ambiguous } : matched ? { note: matched } : {}) };
  } catch (e) {
    e.ambiguous = ambiguous || matched;
    e.inlineEdit = inlineEdit;
    throw e;
  }
}
async function fillFieldKind(tabId, spec, loc) {
  const { label, value } = spec;
  step(tabId, `filling "${label}"`);
  let usedSkip = 0;
  // Same label on a radio/checkbox group and another control (e.g. "X open as"):
  // if the group has no matching option, use the next field with that label.
  for (let skip = 1; skip <= 3 && /^(radiogroup|checkboxgroup)$/.test(loc.field.kind); skip++) {
    const names = (loc.field.options || []).map((o) => norm(o.name));
    if (asList(value).every((v) => names.includes(norm(v)))) break;
    const next = await locateField(tabId, label, { ...spec, skip, index: undefined, inline: false, timeoutMs: 0 }).catch(() => null);
    if (!next || next.field.ref === loc.field.ref) break;
    loc = next;
    usedSkip = skip;
  }
  let kind = loc.field.kind;

  if (kind === 'pill') { // lookup already holds a value: clear it first
    if (norm(loc.field.value).includes(norm(value))) return { label, kind: 'lookup', value: loc.field.value, note: 'already set' };
    await clickLoc(tabId, loc);
    await settle(tabId, 1500);
    loc = await locateField(tabId, label, { ...spec, exact: true, index: undefined, inline: false })
      .catch(() => locateField(tabId, label, { ...spec, index: undefined, inline: false }));
    kind = loc.field.kind;
  }

  switch (kind) {
    case 'text':
    case 'native':
    case 'file': {
      if (kind === 'file') throw new Error(`"${label}" is a file input; use browser_upload`);
      await typeLoc(tabId, loc, String(value), { clear: true, slowly: spec.slowly });
      if (loc.field.dateLike || spec.blur) await pressKey(tabId, 'Tab');
      break;
    }
    case 'select':
      await callFrame(tabId, loc.frameId, 'select', { ...loc.params, values: Array.isArray(value) ? value : [value] });
      break;
    case 'checkbox': {
      const want = asBool(value);
      if (loc.field.checked !== want) await clickLoc(tabId, loc);
      break;
    }
    case 'radio':
    case 'radiogroup': {
      const opts = loc.field.options || [{ ref: loc.field.ref, name: loc.field.name }];
      const opt = pickOption(opts, value);
      if (!opt) throw new Error(`"${label}": no radio option "${value}". Options: ${opts.map((o) => o.name).join(' | ')}`);
      await clickLoc(tabId, locFromRef(opt.ref, { role: 'radio', name: opt.name, ref: opt.ref }));
      break;
    }
    case 'checkboxgroup': {
      const want = asList(value).map(norm);
      const opts = loc.field.options || [];
      const missing = want.filter((w) => !opts.some((o) => norm(o.name) === w));
      if (missing.length) throw new Error(`"${label}": no checkbox ${missing.join(', ')}. Options: ${opts.map((o) => o.name).join(' | ')}`);
      for (const o of opts) {
        if (o.checked !== want.includes(norm(o.name))) await clickLoc(tabId, locFromRef(o.ref, { role: 'checkbox', name: o.name, ref: o.ref }));
      }
      break;
    }
    case 'duallistbox': {
      const want = asList(value).map(norm);
      const state = () => callFrame(tabId, loc.frameId, 'dualState', loc.params);
      let st = await state();
      const all = [...st.available, ...st.chosen];
      const missing = want.filter((w) => !all.some((o) => norm(o.name) === w));
      if (missing.length) throw new Error(`"${label}": no option ${missing.join(', ')}. Options: ${all.map((o) => o.name).join(' | ')}`);
      const move = async (opt, btnRef, dir) => {
        if (!btnRef) throw new Error(`"${label}": dual listbox has no "move to ${dir}" button`);
        await clickLoc(tabId, locFromRef(opt.ref, { role: 'option', name: opt.name, ref: opt.ref }));
        await clickLoc(tabId, locFromRef(btnRef, { role: 'button', name: `move to ${dir}`, ref: btnRef }));
        await sleep(150);
      };
      for (const w of want) {
        st = await state();
        const opt = st.available.find((o) => norm(o.name) === w);
        if (opt) await move(opt, st.toChosen, 'chosen');
      }
      for (;;) {
        st = await state();
        const extra = st.chosen.find((o) => !want.includes(norm(o.name)));
        if (!extra) break;
        await move(extra, st.toAvailable, 'available');
      }
      break;
    }
    case 'picklist': {
      await clickLoc(tabId, loc);
      step(tabId, `waiting for the "${label}" listbox`);
      const list = await poll(async () => {
        const r = await callFrame(tabId, loc.frameId, 'listOptions', loc.params);
        return r.open && r.options.length ? r : null;
      }, 4000);
      if (!list) throw new Error(`"${label}": picklist did not open any options`);
      const opt = pickOption(list.options, value);
      if (!opt) {
        // close the dropdown only: Escape with no dropdown open would close the modal
        if ((await callFrame(tabId, loc.frameId, 'listOptions', loc.params).catch(() => ({}))).open) await pressKey(tabId, 'Escape').catch(() => {});
        throw new Error(`"${label}": no option "${value}". Options: ${list.options.map((o) => o.name).slice(0, 40).join(' | ')}`);
      }
      await clickLoc(tabId, locFromRef(opt.ref, { role: 'option', name: opt.name, ref: opt.ref }));
      break;
    }
    case 'lookup': {
      const r = await fillLookup(tabId, loc, spec);
      if (r) return r; // picked through the full search
      break;
    }
    default:
      throw new Error(`"${label}": unsupported field kind ${kind}`);
  }
  await settle(tabId, 1500);
  const after = await locateField(tabId, loc.field.fieldLabel || label, { ...spec, exact: !!loc.field.fieldLabel, index: undefined, inline: false, skip: usedSkip, timeoutMs: 1000 }).catch(() => null);
  return { label, kind: kind === 'pill' ? 'lookup' : kind, value: after?.field.kind === 'checkbox' ? after.field.checked : after?.field.value };
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------
const commands = {
  async status() {
    await ready;
    const ids = Object.keys(S.controlled).map(Number);
    return {
      browser: browserName(), version: chrome.runtime.getManifest().version, paused: S.paused,
      openMode: S.openMode, controlledTabs: ids, lastTabId: S.lastTabId,
    };
  },

  // Re-read the unpacked extension from disk (picks up code changes). The
  // worker restarts and reconnects to the hub within a few seconds.
  async reload() {
    setTimeout(() => chrome.runtime.reload(), 200);
    // A dialog open during a reload can no longer be answered through the
    // debugger afterwards (the new worker attaches after it opened).
    const open = [...dbg.entries()].filter(([, d]) => d.dialog).map(([id, d]) => `tab ${id}: ${d.dialog.type}`);
    return { reloading: true, version: chrome.runtime.getManifest().version, ...(open.length ? { warning: `JavaScript dialog open (${open.join(', ')}); after the reload browser_dialog cannot answer it - the user must, or close the tab` } : {}) };
  },

  // Resize / maximize the window of a controlled tab, and zoom the tab.
  // Zoom is per tab, so the user's other tabs on the same site are unaffected.
  async window(p) {
    const tab = await tabFor(p);
    const upd = {};
    if (p.state) upd.state = p.state;
    for (const k of ['width', 'height', 'left', 'top']) if (p[k] != null) upd[k] = Math.round(p[k]);
    if (Object.keys(upd).length) {
      if ((upd.width || upd.height || upd.left != null || upd.top != null) && !upd.state) upd.state = 'normal';
      try {
        await chrome.windows.update(tab.windowId, upd);
      } catch (e) {
        // new size would put the window mostly off-screen at its current position
        if (!/bounds/i.test(e.message) || upd.left != null || upd.top != null) throw e;
        await chrome.windows.update(tab.windowId, { ...upd, left: 0, top: 0 });
      }
    }
    if (p.zoom != null) {
      await chrome.tabs.setZoomSettings(tab.id, { mode: 'automatic', scope: 'per-tab' });
      const cur = await chrome.tabs.getZoom(tab.id);
      const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
      let z = p.zoom;
      if (z === 'in') z = STEPS.find((s) => s > cur + 0.001) ?? 5;
      else if (z === 'out') z = [...STEPS].reverse().find((s) => s < cur - 0.001) ?? 0.25;
      else if (z === 'reset') z = 1;
      z = Number(z);
      if (!(z >= 0.25 && z <= 5)) throw new Error('zoom must be in, out, reset or a factor between 0.25 and 5');
      await chrome.tabs.setZoom(tab.id, z);
      await sleep(300);
    }
    const w = await chrome.windows.get(tab.windowId);
    const vp = await callFrame(tab.id, 0, 'ping').catch(() => null);
    return {
      tabId: tab.id, windowId: w.id, state: w.state, width: w.width, height: w.height, left: w.left, top: w.top,
      zoom: await chrome.tabs.getZoom(tab.id), viewport: vp?.viewport,
    };
  },

  async tabs({ all = false }) {
    await ready;
    const tabs = await chrome.tabs.query({});
    return tabs
      .filter((t) => all || S.controlled[t.id])
      .map((t) => ({
        tabId: t.id, windowId: t.windowId, title: t.title, url: t.url, active: t.active,
        controlled: S.controlled[t.id] || false, status: t.status,
      }));
  },

  async open({ url = 'about:blank', where }) {
    await ready;
    if (S.paused) throw new Error('SF Test Bridge is paused by the user.');
    where = where || S.openMode;
    let tab;
    if (where === 'window') {
      let winOk = false;
      if (S.claudeWindowId != null) winOk = !!(await chrome.windows.get(S.claudeWindowId).catch(() => null));
      if (winOk) tab = await chrome.tabs.create({ windowId: S.claudeWindowId, url: 'about:blank', active: true });
      else {
        const w = await chrome.windows.create({ url: 'about:blank', focused: true, type: 'normal' });
        S.claudeWindowId = w.id;
        tab = w.tabs[0];
      }
    } else {
      tab = await chrome.tabs.create({ url: 'about:blank', active: true });
    }
    await controlTab(tab.id, 'claude');
    await addToGroup(tab).catch(() => {});
    const before = await marks(tab.id);
    // Attach before navigating so console/network are captured from the start.
    const hasCdp = await canCdp(tab.id);
    if (url !== 'about:blank') {
      if (hasCdp) {
        const r = await cdp(tab.id, 'Page.navigate', { url }, 30_000);
        if (r.errorText) throw new Error(`navigation failed: ${r.errorText}`);
      } else {
        await chrome.tabs.update(tab.id, { url });
      }
      await waitForLoad(tab.id);
      await waitIdle(tab.id, { timeoutMs: 8000 });
    }
    return { ...(await pageReport(tab.id, before)), cdp: hasCdp ? 'attached' : `unavailable: ${dbgRec(tab.id).cdpUnavailable}` };
  },

  // Closing the last tab of a window closes the window too, which has cost
  // the hub connection before. Keep the window: open a blank tab first.
  async close(p) {
    const tab = await tabFor(p);
    const siblings = await chrome.tabs.query({ windowId: tab.windowId });
    let kept;
    if (siblings.length <= 1) {
      const blank = await chrome.tabs.create({ windowId: tab.windowId, url: 'about:blank', active: true });
      kept = blank.id;
    }
    await releaseTab(tab.id);
    await chrome.tabs.remove(tab.id);
    return { closed: tab.id, ...(kept ? { note: `it was the last tab in its window; opened a blank tab (${kept}) first so the window stays open` } : {}) };
  },

  // onBeforeUnload: what to do when the page asks "Leave site? Changes you
  // made may not be saved" (unsaved inline edit / form):
  //   report (default) - stay on the page (unsaved changes kept) and fail with that message
  //   accept           - leave the page, discarding the unsaved changes
  //   dismiss          - stay on the page and return normally with a note
  async navigate(p) {
    const tab = await tabFor(p);
    const before = await marks(tab.id);
    const action = p.action || (p.url ? 'goto' : null);
    const mode = p.onBeforeUnload || 'report';
    if (!/^(report|accept|dismiss)$/.test(mode)) throw new Error('onBeforeUnload must be report, accept or dismiss');
    const fromUrl = tab.url;
    let start;
    if (action === 'goto') {
      if (await canCdp(tab.id)) {
        start = async () => {
          const r = await cdp(tab.id, 'Page.navigate', { url: p.url }, 60_000);
          if (r.errorText && !/ERR_ABORTED/.test(r.errorText)) throw new Error(`navigation failed: ${r.errorText}`);
        };
      } else start = () => chrome.tabs.update(tab.id, { url: p.url });
    } else if (action === 'back') start = () => chrome.tabs.goBack(tab.id);
    else if (action === 'forward') start = () => chrome.tabs.goForward(tab.id);
    else if (action === 'reload') start = () => chrome.tabs.reload(tab.id);
    else throw new Error('give url, or action: back | forward | reload');

    const d = dbgRec(tab.id);
    let note;
    // A beforeunload dialog already open (left over from an earlier action).
    const answer = async () => {
      if (d.dialog?.type !== 'beforeunload') return false;
      step(tab.id, 'answering the beforeunload dialog');
      if (mode === 'accept') {
        await cdp(tab.id, 'Page.handleJavaScriptDialog', { accept: true }, 5000);
        d.dialog = null;
        note = 'the page had unsaved changes ("Leave site?"); left it and discarded them (onBeforeUnload: accept)';
        return false;
      }
      await cdp(tab.id, 'Page.handleJavaScriptDialog', { accept: false }, 5000);
      d.dialog = null;
      const msg = `navigation not done: the page has unsaved changes and asked "Leave site?" (beforeunload). Stayed on ${fromUrl}; the unsaved changes are still there. Save or cancel them first, or pass onBeforeUnload: "accept" to discard them.`;
      if (mode === 'report') throw new Error(msg);
      note = msg.replace('navigation not done', 'stayed on the page (onBeforeUnload: dismiss)');
      return true;
    };
    if (await answer()) return { note, ...(await pageReport(tab.id, before)) };
    step(tab.id, `navigating${action === 'goto' ? ` to ${p.url}` : ` (${action})`}`);
    let done = false;
    let navErr = null;
    start().then(() => { done = true; }, (e) => { navErr = e; done = true; });
    // Page.navigate does not return while a beforeunload dialog is open.
    for (const t0 = Date.now(); !done && Date.now() - t0 < 60_000;) {
      if (await answer()) return { note, ...(await pageReport(tab.id, before)) };
      await sleep(100);
    }
    if (navErr) throw navErr;
    step(tab.id, 'waiting for the page to load');
    await waitForLoad(tab.id, p.timeoutMs || 30_000);
    if (await answer()) return { note, ...(await pageReport(tab.id, before)) };
    step(tab.id, 'waiting for network idle');
    await waitIdle(tab.id, { timeoutMs: 8000 });
    return { ...(note ? { note } : {}), ...(await pageReport(tab.id, before)) };
  },

  async snapshot(p) {
    const tab = await tabFor(p);
    if (p.loadAll) await loadAllContent(tab.id);
    const maxChars = p.maxChars || 40_000;
    let budget = maxChars;
    const parts = [`Page: ${tab.title}`, `URL: ${tab.url}`, `Tab: ${tab.id}`];
    const d = dbg.get(tab.id);
    if (d?.dialog) parts.push(`!! JavaScript ${d.dialog.type} dialog open: "${d.dialog.message}" - use browser_dialog`);
    let truncated = 0;
    for (const f of await frames(tab.id)) {
      if (budget < 200) { truncated++; continue; }
      step(tab.id, `reading frame ${f.frameId}`);
      const snap = await callFrame(tab.id, f.frameId, 'snapshot', { mode: p.mode, maxChars: budget, prefix: prefixFor(f.frameId) })
        .catch((e) => ({ error: e.message, lines: [] }));
      if (!snap.lines.length && f.frameId !== 0) continue;
      const block = [];
      if (f.frameId !== 0) block.push(`\n--- frame f${f.frameId}: ${snap.url || f.url} ---`);
      if (snap.error) block.push(`(could not read frame: ${snap.error})`);
      block.push(...snap.lines);
      truncated += snap.truncated || 0;
      const text = block.join('\n');
      budget -= text.length;
      parts.push(text);
    }
    if (truncated) parts.push(`\n… ${truncated} more element(s) omitted (maxChars=${maxChars}). Use browser_get_text, a larger maxChars, or scroll/act on a smaller region.`);
    return { text: parts.join('\n') };
  },

  async click(p) {
    const tab = await tabFor(p);
    let loc;
    let via;
    try {
      loc = await locate(tab.id, p);
    } catch (e) {
      // A tab that does not fit the bar lives in its "More" overflow menu
      // (console workspace tabs, record page tabs, app nav items).
      const wantsTab = p.text && Array.isArray(p.role) && p.role.includes('tab');
      if (!wantsTab) throw e;
      const more = await locate(tab.id, { text: 'Show additional tabs', role: ['button'], within: p.within, timeoutMs: 0, scrollToFind: false })
        .catch(() => locate(tab.id, { text: 'More', role: ['button'], within: p.within, timeoutMs: 0, scrollToFind: false }))
        .catch(() => null);
      if (!more) throw e;
      await clickLoc(tab.id, more);
      loc = await locate(tab.id, { text: p.text, exact: p.exact, role: ['menuitem', 'option', 'tab', 'link'], scope: 'page', timeoutMs: 3000, scrollToFind: false })
        .catch(async () => { await pressKey(tab.id, 'Escape').catch(() => {}); throw e; });
      via = 'overflow "More" menu';
    }
    const before = await marks(tab.id);
    const modalBefore = COMMIT_BUTTON.test(loc.el.name || '') ? await currentModal(tab.id) : null;
    const { how, note } = await clickLoc(tab.id, loc, p);
    await settle(tab.id, p.waitMs ?? 3000);
    const outcome = modalBefore ? await awaitOutcome(tab.id, modalBefore) : undefined;
    return withToasts({ clicked: describeEl(loc.el), via, how, note, ambiguous: ambiguity(loc.el, p), outcome: outcome?.result, ...(await pageReport(tab.id, before)) }, outcome);
  },

  // Fill form fields by visible label: text, textarea, picklist (lightning-combobox),
  // lookup, checkbox/toggle, radio group, native select, date. Modal-aware.
  async fill(p) {
    const tab = await tabFor(p);
    const before = await marks(tab.id);
    const specs = p.fields?.length ? p.fields : [{ label: p.label, value: p.value }];
    const results = [];
    for (const f of specs) {
      if (!f.label) throw new Error('each field needs a label');
      try {
        results.push(await fillField(tab.id, { scope: p.scope, frame: p.frame, ...f }));
      } catch (e) {
        results.push({ label: f.label, error: e.message, ...(e.inlineEdit ? { inlineEdit: true } : {}), ...(e.details ? { details: e.details } : {}) });
        if (!p.continueOnError) break;
      }
    }
    let submitted;
    const inline = results.some((r) => r.inlineEdit);
    if (p.submit && !results.some((r) => r.error)) {
      step(tab.id, `clicking "${p.submit}"`);
      const loc = await locate(tab.id, { text: p.submit, exact: true, role: ['button'], scope: p.scope || 'auto' })
        .catch(() => locate(tab.id, { text: p.submit, role: ['button', 'link', 'clickable'], scope: p.scope || 'auto' }));
      const modalBefore = await currentModal(tab.id);
      submitted = { button: describeEl(loc.el), ...(await clickLoc(tab.id, loc)) };
      await settle(tab.id, 6000);
      if (modalBefore) submitted.outcome = await awaitOutcome(tab.id, modalBefore);
      else if (inline || /^save\b/i.test(loc.el.name || '')) submitted.outcome = await awaitInlineOutcome(tab.id, loc);
    }
    const out = { fields: results, submitted, ...(await pageReport(tab.id, before)) };
    if (inline && (!p.submit || !submitted)) out.note = 'inline edit is still open with unsaved changes: click Save or Cancel (or fill with submit "Save"); leaving the page now asks "Leave site?"';
    return withToasts(out, submitted?.outcome);
  },

  // Click a record action (highlights panel), using the "Show more actions"
  // overflow menu when the action is not shown directly.
  async recordAction(p) {
    const tab = await tabFor(p);
    const before = await marks(tab.id);
    const label = p.label;
    const roles = ['button', 'menuitem', 'link'];
    const tryFind = (scope, exact, timeoutMs = 0) => locate(tab.id, { text: label, exact, role: roles, scope, timeoutMs, scrollToFind: false }).catch(() => null);
    let loc = (await tryFind('header', true, 3000)) || (await tryFind('header', false));
    let via = 'highlights panel';
    if (!loc) {
      const more = await locate(tab.id, { text: 'Show more actions', role: ['button'], scope: 'header', timeoutMs: 1000 })
        .catch(() => locate(tab.id, { text: 'more actions', role: ['button'], scope: 'header', timeoutMs: 0 }))
        .catch(() => null);
      if (more) {
        await clickLoc(tab.id, more);
        loc = await locate(tab.id, { text: label, exact: true, role: ['menuitem'], scope: 'page', timeoutMs: 4000 })
          .catch(() => locate(tab.id, { text: label, role: ['menuitem'], scope: 'page', timeoutMs: 0 })).catch(() => null);
        via = 'Show more actions menu';
      }
    }
    if (!loc && p.anywhere !== false) {
      loc = (await tryFind('page', true)) || null;
      via = 'page';
    }
    if (!loc) {
      const avail = await callFrame(tab.id, 0, 'headerActions', {}).catch(() => []);
      await pressKey(tab.id, 'Escape').catch(() => {});
      throw new Error(`record action "${label}" not found. Visible header actions: ${avail.map((a) => a.name).join(' | ') || '(none - is a record page open?)'}`);
    }
    const r = await clickLoc(tab.id, loc);
    await settle(tab.id, 5000);
    // waitForModal: true (default, 4s) / false / a number of ms (slow console apps)
    if (p.waitForModal !== false) await poll(() => callFrame(tab.id, 0, 'modal'), typeof p.waitForModal === 'number' ? Math.min(p.waitForModal, 60_000) : 4000, 250);
    return { action: label, via, clicked: describeEl(loc.el), ...r, ...(await pageReport(tab.id, before)) };
  },

  // Salesforce Path on a record page.
  //   action "read" (default): stages (complete/current/incomplete), the
  //     current and selected stage, time in stage, key fields and guidance
  //     (details: false skips opening the key-fields panel). stage: show that
  //     stage's key fields and guidance.
  //   action "select": click a stage (shows its key fields/guidance).
  //   action "mark": optionally select `stage`, then click the mark button
  //     ("Mark as Current Stage" / "Mark Stage as Complete" / "Select Closed
  //     Stage"; `button` requires a specific label). closedStage picks the
  //     value in the closed-stage dialog. Returns the outcome, toasts and errors.
  //   action "editKeyFields": open the key fields' Edit and return the
  //     editable fields; with `fields` fill them, and with submit (default
  //     "Save" when fields are given) save and return the outcome.
  async path(p) {
    const tab = await tabFor(p);
    const before = await marks(tab.id);
    const action = p.action || 'read';
    if (!/^(read|select|mark|editKeyFields)$/.test(action)) throw new Error('action must be read, select, mark or editKeyFields');
    step(tab.id, 'reading the Path');
    const read = () => callFrame(tab.id, 0, 'pathState', {});
    let st = await poll(read, p.timeoutMs ?? 5000, 300);
    if (!st) {
      await loadAllContent(tab.id, 6);
      st = await read();
    }
    if (!st) throw new Error('no Path on this page (no .slds-path stages found). Is a record page with a Path component open?');
    const loc = (ref, el) => locFromRef(ref, el);
    const fmt = (s) => s.stages.map((x) => `${x.name} [${x.state}${x.selected && x.state !== 'current' ? ', selected' : ''}]`).join(' > ');
    const findStage = (s, name) => {
      const w = norm(name);
      const hit = s.stages.find((x) => norm(x.name) === w) || s.stages.find((x) => norm(x.name).startsWith(w));
      if (!hit) throw new Error(`no stage "${name}". Stages: ${s.stages.map((x) => x.name).join(' | ')}`);
      return hit;
    };
    const selectStage = async (name) => {
      const sg = findStage(st, name);
      if (!sg.selected) {
        step(tab.id, `selecting stage "${sg.name}"`);
        await clickLoc(tab.id, loc(sg.ref, { role: 'option', name: sg.name, ref: sg.ref }), { method: 'auto' });
        await settle(tab.id, 3000);
        st = await poll(async () => { const x = await read(); return x && x.selected && norm(x.selected) === norm(sg.name) && (!x.expanded || x.keyFields?.length) ? x : null; }, 5000, 250) || await read();
      }
      return sg;
    };
    const expand = async () => {
      if (st.expanded && !st.keyFields?.length && !st.guidance) {
        // panel open (it stays open across page loads) but still rendering
        st = await poll(async () => { const x = await read(); return x?.keyFields?.length ? x : null; }, 6000, 250) || st;
      }
      if (st.expanded || !st.toggle) return;
      step(tab.id, 'opening the key fields / guidance panel');
      await clickLoc(tab.id, loc(st.toggle.ref, { role: 'button', name: st.toggle.name, ref: st.toggle.ref }));
      // the key fields render a moment after the panel opens
      st = await poll(async () => { const x = await read(); return x?.expanded && x.keyFields?.length ? x : null; }, 6000, 250) || await read();
    };
    const result = (extra) => ({
      ...extra,
      stages: fmt(st), current: st.current, selected: st.selected, timeInStage: st.timeInStage,
      ...(st.keyFields ? { keyFields: st.keyFields.map((f) => `${f.label}${f.required ? '*' : ''}: ${f.value || '(empty)'}`), keyFieldsMode: st.keyFieldsMode } : {}),
      ...(st.guidance ? { guidance: st.guidance } : {}),
      markButton: st.markButton?.name,
    });

    if (p.stage && action !== 'mark') await selectStage(p.stage);
    if (action === 'read' || action === 'select') {
      if (p.details !== false && action === 'read') await expand();
      return { ...result({}), ...(await pageReport(tab.id, before)) };
    }

    if (action === 'mark') {
      if (p.stage) await selectStage(p.stage);
      const btn = st.markButton;
      if (!btn) throw new Error(`no mark button on the Path (selected: ${st.selected || st.current})`);
      if (p.button && !norm(btn.name).startsWith(norm(p.button))) throw new Error(`the Path button is "${btn.name}", not "${p.button}" (selected stage: ${st.selected || st.current})`);
      if (btn.disabled) throw new Error(`the Path button "${btn.name}" is disabled`);
      const from = st.current;
      const seen = [];
      const collect = async () => {
        const a = await callFrame(tab.id, 0, 'alerts').catch(() => null);
        for (const t of a?.alerts || []) if (!seen.includes(t)) seen.push(t);
        return a;
      };
      step(tab.id, `clicking "${btn.name}"`);
      await clickLoc(tab.id, loc(btn.ref, { role: 'button', name: btn.name, ref: btn.ref }));
      await settle(tab.id, 4000);
      let outcome;
      const modal = await currentModal(tab.id);
      if (modal) {
        // "Select Closed Stage" dialog
        if (!p.closedStage) {
          return { ...result({ clicked: btn.name, outcome: `dialog open: ${modal}. Pass closedStage (e.g. "Closed Won") to choose.` }), ...(await pageReport(tab.id, before)) };
        }
        step(tab.id, `choosing closed stage "${p.closedStage}"`);
        await fillField(tab.id, { label: 'Stage', value: p.closedStage, scope: 'modal' });
        const ok = await locate(tab.id, { text: 'Save', exact: true, role: ['button'], scope: 'modal', timeoutMs: 2000 })
          .catch(() => locate(tab.id, { text: 'Done', exact: true, role: ['button'], scope: 'modal', timeoutMs: 1000 }));
        await clickLoc(tab.id, ok);
        outcome = (await awaitOutcome(tab.id, modal)).result;
      }
      step(tab.id, 'waiting for the stage change');
      let res = 'no change';
      await poll(async () => {
        const a = await collect();
        const x = await read();
        if (x) st = x;
        if (x && x.current !== from) { res = `stage changed: ${from} -> ${x.current}`; return true; }
        if (/error|snag|review|required|invalid|can't|cannot|must|choose/i.test((a?.alerts || []).join(' '))) { res = 'error shown'; return true; }
        return false;
      }, p.waitMs ?? 12_000, 300);
      if (res.startsWith('stage changed')) await poll(async () => (await collect(), seen.some((t) => /changed|success|saved|updated/i.test(t))), 2500, 250);
      st = (await read()) || st;
      const report = await pageReport(tab.id, before);
      const out = { ...result({ clicked: btn.name, outcome: outcome ? `${outcome}; ${res}` : res }), ...report };
      return withToasts(out, { toasts: seen });
    }

    // editKeyFields
    await expand();
    if (st.keyFieldsMode !== 'edit') {
      if (!st.editRef) throw new Error(`the key fields panel has no Edit button (key fields: ${(st.keyFields || []).map((f) => f.label).join(', ') || 'none'})`);
      step(tab.id, 'opening key fields Edit');
      await clickLoc(tab.id, loc(st.editRef, { role: 'button', name: 'Edit', ref: st.editRef }));
      // Depending on the org the key fields open inline or in an "Edit <Object>" modal.
      await poll(async () => { const x = await read(); return x?.keyFieldsMode === 'edit' || (await currentModal(tab.id)); }, 8000, 250);
      await settle(tab.id, 3000);
      st = (await read()) || st;
    }
    const modal = st.keyFieldsMode === 'edit' ? null : await currentModal(tab.id);
    if (!modal && st.keyFieldsMode !== 'edit') throw new Error('key fields Edit did not open an editor');
    const scope = modal ? 'modal' : 'page';
    if (!p.fields?.length) {
      const editable = modal
        ? (await callFrame(tab.id, 0, 'formFields', { scope: 'modal' })).map((f) => `${f.label} (${f.kind})${f.required ? '*' : ''}: ${f.value || '(empty)'}`)
        : (st.keyFields || []).filter((f) => f.editable).map((f) => f.label);
      return { ...result({ editor: modal ? `modal "${modal}"` : 'inline', editable }), ...(await pageReport(tab.id, before)) };
    }
    const filled = [];
    for (const f of p.fields) {
      try { filled.push(await fillField(tab.id, { scope, inline: false, ...f })); } catch (e) {
        filled.push({ label: f.label, error: e.message, ...(e.details ? { details: e.details } : {}) });
        break;
      }
    }
    let submitted;
    const submit = p.submit ?? 'Save';
    if (submit && !filled.some((r) => r.error) && modal) {
      const sLoc = await locate(tab.id, { text: submit, exact: true, role: ['button'], scope: 'modal' });
      submitted = { button: describeEl(sLoc.el), ...(await clickLoc(tab.id, sLoc)) };
      submitted.outcome = await awaitOutcome(tab.id, modal);
      st = (await read()) || st;
    } else if (submit && !filled.some((r) => r.error)) {
      st = (await read()) || st;
      const ref = /^save$/i.test(submit) ? st.saveRef : /^cancel$/i.test(submit) ? st.cancelRef : null;
      const sLoc = ref ? loc(ref, { role: 'button', name: submit, ref }) : await locate(tab.id, { text: submit, exact: true, role: ['button'], scope: 'page' });
      submitted = { button: describeEl(sLoc.el), ...(await clickLoc(tab.id, sLoc)) };
      await settle(tab.id, 3000);
      submitted.outcome = await awaitInlineOutcome(tab.id, sLoc);
      st = (await read()) || st;
    }
    return withToasts({ ...result({ editor: modal ? `modal "${modal}"` : 'inline', fields: filled, submitted }), ...(await pageReport(tab.id, before)) }, submitted?.outcome);
  },

  // Options of a dropdown/combobox (opens it first if needed).
  async options(p) {
    const tab = await tabFor(p);
    const loc = p.label ? await locateField(tab.id, p.label, p) : await locate(tab.id, p);
    let r = await callFrame(tab.id, loc.frameId, 'listOptions', loc.params);
    if (!r.open || !r.options.length) {
      await clickLoc(tab.id, loc);
      r = (await poll(async () => {
        const x = await callFrame(tab.id, loc.frameId, 'listOptions', loc.params);
        return x.open && x.options.length ? x : null;
      }, 4000)) || r;
    }
    return { field: describeEl(loc.el), open: r.open, options: r.options };
  },

  async hover(p) {
    const tab = await tabFor(p);
    const loc = await locate(tab.id, p);
    const pt = await pointOf(tab.id, loc);
    await cdp(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y }, 5000);
    await settle(tab.id, 1500);
    return { hovered: describeEl(loc.el), covered: pt.covered ? pt.coveredBy : undefined };
  },

  async type(p) {
    const tab = await tabFor(p);
    // Text targets only match editable elements (never a link or button).
    const loc = await locate(tab.id, p.text && !p.role ? { ...p, role: ['textbox', 'searchbox', 'combobox', 'spinbutton'] } : p);
    const before = await marks(tab.id);
    const how = await typeLoc(tab.id, loc, String(p.value ?? ''), { clear: p.clear !== false, slowly: p.slowly, method: p.method });
    if (p.submit) {
      if (how === 'trusted' || await canCdp(tab.id)) await pressKey(tab.id, 'Enter');
      else throw new Error('submit needs the debugger (CDP), which is unavailable on this tab');
    }
    await settle(tab.id, p.submit ? 5000 : 1500);
    const after = await callFrame(tab.id, loc.frameId, 'value', loc.params).catch(() => null);
    return { typedInto: describeEl(loc.el), how, value: after?.value, ...(await pageReport(tab.id, before)) };
  },

  async select(p) {
    const tab = await tabFor(p);
    const loc = await locate(tab.id, p);
    const before = await marks(tab.id);
    const values = Array.isArray(p.values) ? p.values : [p.values];
    const r = await callFrame(tab.id, loc.frameId, 'select', { ...loc.params, values });
    await settle(tab.id, 2000);
    return { selected: r.selected, in: describeEl(loc.el), ...(await pageReport(tab.id, before)) };
  },

  async key(p) {
    const tab = await tabFor(p);
    const before = await marks(tab.id);
    if (p.ref || p.selector || p.text) {
      const loc = await locate(tab.id, p);
      if (loc.el.type === 'password') throw new Error(PASSWORD_REFUSAL);
      await callFrame(tab.id, loc.frameId, 'focus', loc.params);
    }
    if (!/^(Shift\+)?Tab$|^Escape$/i.test(p.key) && await anyFrame(tab.id, 'activeIsPassword')) throw new Error(PASSWORD_REFUSAL);
    for (let i = 0; i < (p.repeat || 1); i++) await pressKey(tab.id, p.key);
    await settle(tab.id, 2000);
    return { pressed: p.key, ...(await pageReport(tab.id, before)) };
  },

  async scroll(p) {
    const tab = await tabFor(p);
    if (p.ref || p.selector || p.text) {
      const loc = await locate(tab.id, p);
      return { scrolledTo: describeEl(await callFrame(tab.id, loc.frameId, 'scroll', loc.params)) };
    }
    const dy = p.dy ?? (p.direction === 'up' ? -600 : 600);
    return callFrame(tab.id, 0, 'scroll', { dy, dx: p.dx || 0 });
  },

  // Annotated evidence screenshot (for test reports; the MCP server stores it
  // on disk and gives Claude only the path). CSS markup drawn on the page
  // just for the capture: the element last acted on (orange), error messages
  // (red), success toasts (green) and a caption banner with the status.
  //   caption, status ("pass" / "fail" / ...), detail (scroll the first error
  //   into view), target (false = no element outline), format jpeg|png, quality.
  async evidenceShot(p) {
    const tab = await tabFor(p);
    step(tab.id, 'capturing evidence');
    const boxes = [];
    const lt = lastTarget.get(tab.id);
    if (p.target !== false && lt && Date.now() - lt.at < (p.targetMaxAgeMs ?? 180_000)) {
      const r = await callFrame(tab.id, lt.loc.frameId, 'rect', lt.loc.params).catch(() => null);
      if (r && r.width > 0 && r.height > 0) boxes.push({ x: r.x, y: r.y, width: r.width, height: r.height, kind: 'target', label: p.targetLabel || lt.label });
    }
    const format = p.format === 'png' ? 'png' : 'jpeg';
    try {
      const marked = await callFrame(tab.id, 0, 'markup', { boxes, caption: p.caption || '', status: p.status || '', messages: p.messages !== false, scrollToMessage: !!p.detail });
      await sleep(80); // let the overlay paint
      const shot = await cdp(tab.id, 'Page.captureScreenshot', { format, ...(format === 'jpeg' ? { quality: p.quality || 70 } : {}), optimizeForSpeed: true }, 15_000);
      const cur = await chrome.tabs.get(tab.id).catch(() => tab);
      return { image: shot.data, mimeType: `image/${format}`, url: cur.url, title: cur.title, marked };
    } finally {
      await callFrame(tab.id, 0, 'unmarkup').catch(() => {});
    }
  },

  async screenshot(p) {
    const tab = await tabFor(p);
    if (!tab.active) { await chrome.tabs.update(tab.id, { active: true }); await sleep(300); }
    const format = p.format === 'jpeg' ? 'jpeg' : 'png';
    const params = { format, ...(format === 'jpeg' ? { quality: p.quality || 75 } : {}) };
    if (p.ref || p.selector || p.text) {
      const loc = await locate(tab.id, p);
      const pt = await pointOf(tab.id, loc);
      const m = await cdp(tab.id, 'Page.getLayoutMetrics');
      const vv = m.cssVisualViewport || m.visualViewport;
      params.clip = { x: pt.rect.x + vv.pageX, y: pt.rect.y + vv.pageY, width: Math.max(1, pt.rect.width), height: Math.max(1, pt.rect.height), scale: 1 };
    } else if (p.fullPage) {
      const m = await cdp(tab.id, 'Page.getLayoutMetrics');
      const cs = m.cssContentSize || m.contentSize;
      params.clip = { x: 0, y: 0, width: Math.ceil(cs.width), height: Math.min(Math.ceil(cs.height), 16_000), scale: 1 };
      params.captureBeyondViewport = true;
    }
    try {
      const r = await cdp(tab.id, 'Page.captureScreenshot', params, 10_000);
      return { image: r.data, mimeType: `image/${format}`, tabId: tab.id, url: tab.url };
    } catch (e) {
      if (params.clip) throw e;
      // Occluded/minimized window: bring it forward and use the plain capture API.
      await chrome.windows.update(tab.windowId, { focused: true, state: 'normal' });
      await sleep(400);
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format, quality: params.quality });
      return { image: dataUrl.split(',')[1], mimeType: `image/${format}`, tabId: tab.id, url: tab.url, note: 'captured after focusing the window' };
    }
  },

  async getText(p) {
    const tab = await tabFor(p);
    if (p.loadAll) await loadAllContent(tab.id);
    if (p.ref || p.selector || p.text) {
      const loc = await locate(tab.id, p);
      step(tab.id, `reading text of ${describeEl(loc.el)}`);
      return callFrame(tab.id, loc.frameId, 'text', { ...loc.params, maxChars: p.maxChars });
    }
    const chunks = [];
    let budget = p.maxChars || 20_000;
    for (const f of await frames(tab.id)) {
      if (budget < 100) break;
      const r = await callFrame(tab.id, f.frameId, 'text', { maxChars: budget }).catch(() => null);
      if (!r?.text) continue;
      chunks.push(f.frameId ? `\n--- frame f${f.frameId}: ${r.url} ---\n${r.text}` : r.text);
      budget -= r.text.length;
    }
    return { url: tab.url, title: tab.title, text: chunks.join('\n') };
  },

  async waitFor(p) {
    const tab = await tabFor(p);
    const timeoutMs = Math.min(p.timeoutMs || 15_000, 120_000);
    const start = Date.now();
    let staleOnly = false;
    const check = async () => {
      const fl = await frames(tab.id);
      const anyFrame = async (method, params) => {
        for (const f of fl) if (await callFrame(tab.id, f.frameId, method, params).catch(() => false)) return true;
        return false;
      };
      if (p.text && !(await anyFrame('hasText', { text: p.text }))) return false;
      // Text found only in an alert left over from an earlier action does not
      // count: keep waiting for this action's own message (allowStale: true
      // accepts it).
      if (p.text && !p.allowStale) {
        const tf = await callFrame(tab.id, 0, 'textFreshness', { text: p.text }).catch(() => null);
        staleOnly = !!(tf && !tf.inFresh && tf.inStale && !tf.elsewhere);
        if (staleOnly) return false;
      }
      if (p.textGone && (await anyFrame('hasText', { text: p.textGone }))) return false;
      if (p.option && !(await anyFrame('hasOption', { text: p.option }))) return false;
      if (p.selector && !(await anyFrame('hasSelector', { selector: p.selector }))) return false;
      if (p.selectorGone && (await anyFrame('hasSelector', { selector: p.selectorGone }))) return false;
      if (p.urlIncludes && !(await chrome.tabs.get(tab.id)).url.includes(p.urlIncludes)) return false;
      if (p.networkIdle && !(await waitIdle(tab.id, { quietMs: 500, timeoutMs: 1000 }))) return false;
      return true;
    };
    while (Date.now() - start < timeoutMs) {
      if (await check()) return { ok: true, waitedMs: Date.now() - start, ...(await pageReport(tab.id, null)) };
      if (dbg.get(tab.id)?.dialog) break;
      await sleep(300);
    }
    if (!p.text && !p.textGone && !p.option && !p.selector && !p.selectorGone && !p.urlIncludes && !p.networkIdle) {
      return { ok: true, waitedMs: timeoutMs }; // plain sleep
    }
    const shown = Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith('__') && k !== 'tabId'));
    const staleNote = staleOnly ? ` (the text is on screen only in an old alert left from an earlier action, not one this action produced; pass allowStale: true to accept it)` : '';
    throw new Error(`condition not met within ${timeoutMs}ms: ${JSON.stringify(shown)}${staleNote}${dialogNote(tab.id)}`);
  },

  // Close visible toasts and the record edit error popover before an action,
  // so any message after it must be new. Waits up to 3s for the toasts to go.
  async dismissAlerts(p) {
    const tab = await tabFor(p);
    step(tab.id, 'closing old toasts');
    const r = await callFrame(tab.id, 0, 'dismissAlerts').catch(() => ({ closed: 0 }));
    if (r.closed) {
      await poll(async () => {
        const a = await callFrame(tab.id, 0, 'alerts').catch(() => null);
        return !(a?.alerts || []).some((t) => (r.texts || []).includes(t));
      }, 3000, 200);
    }
    return { closed: r.closed || 0, texts: r.texts || [] };
  },

  // Network position, taken by browser_steps before an action.
  async netMark(p) {
    const tab = await tabFor(p);
    return { tabId: tab.id, netSeq: dbg.get(tab.id)?.netSeq || 0, captured: !!dbg.get(tab.id)?.attached };
  },

  // Error messages the server returned to save requests sent after sinceSeq
  // (Aura actions, UI API, REST). Proof that an action produced an error even
  // when the page shows it in the same element as before. With `text`,
  // `matched` says whether any of those responses contains it. Only error
  // messages are returned, never record data.
  async serverMessages(p) {
    const tab = await tabFor(p);
    const d = dbgRec(tab.id);
    if (!d.attached) return { captured: false, matched: false, errors: [] };
    const since = Number(p.sinceSeq) || 0;
    const isSave = (r) => r.seq > since && r.method === 'POST' && /\/aura\?|\/ui-api\/|\/services\/data\//i.test(r.url) && !NOISE_URL.test(r.url);
    // let requests still in flight finish (bounded)
    await poll(async () => ![...d.network.values()].some((r) => isSave(r) && !r.done), p.waitMs ?? 3000, 200);
    const unescape = (s) => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\(["\\/'])/g, '$1').replace(/\\n/g, ' ')
      .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const squash = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
    const want = p.text ? squash(p.text) : null;
    const errors = [];
    let matched = false;
    let checked = 0;
    for (const r of [...d.network.values()].filter(isSave).slice(-40)) {
      if (!r.done || r.failed) continue;
      const body = await cdp(tab.id, 'Network.getResponseBody', { requestId: r.id }, 5000).catch(() => null);
      if (!body || body.base64Encoded) continue;
      checked++;
      const raw = String(body.body).slice(0, 2_000_000);
      const looksError = r.ok === false || /FIELD_CUSTOM_VALIDATION_EXCEPTION|"errorCode"|"state"\s*:\s*"(ERROR|INCOMPLETE)"|"isUserDefinedException"/.test(raw);
      if (!looksError) continue;
      if (want && squash(unescape(raw)).includes(want)) matched = true;
      for (const m of raw.matchAll(/"message"\s*:\s*"((?:[^"\\]|\\.){1,400})"/g)) {
        const msg = unescape(m[1]).trim();
        if (msg && !errors.includes(msg)) errors.push(msg);
      }
    }
    return { captured: true, checked, matched, errors: errors.slice(0, 10) };
  },

  async evaluate(p) {
    const tab = await tabFor(p);
    if (await anyFrame(tab.id, 'hasSelector', { selector: 'input[type=password]' })) {
      throw new Error('Refused: browser_evaluate does not run on pages with a password field (login pages).');
    }
    const r = await cdp(tab.id, 'Runtime.evaluate', {
      expression: p.expression, returnByValue: true, awaitPromise: true, userGesture: true, replMode: true,
    }, Math.min(p.timeoutMs || 30_000, 120_000));
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    const v = r.result;
    return { type: v.type, value: 'value' in v ? v.value : (v.unserializableValue ?? v.description) };
  },

  async console(p) {
    const tab = await tabFor(p);
    const d = dbgRec(tab.id);
    if (!d.attached) await canCdp(tab.id);
    let items = d.console;
    if (p.level) {
      const order = ['debug', 'log', 'info', 'warning', 'error'];
      const min = order.indexOf(p.level === 'warn' ? 'warning' : p.level);
      items = items.filter((c) => order.indexOf(c.level === 'verbose' ? 'debug' : c.level) >= min || (min < 0 && c.level === p.level));
    }
    if (p.pattern) { const re = new RegExp(p.pattern, 'i'); items = items.filter((c) => re.test(c.text)); }
    const out = items.slice(-(p.limit || 50)).map((c) => ({ level: c.level, text: c.text, source: c.source, time: new Date(c.time).toISOString() }));
    if (p.clear) d.console = [];
    return { tabId: tab.id, count: out.length, captured: d.attached, entries: out };
  },

  async network(p) {
    const tab = await tabFor(p);
    const d = dbgRec(tab.id);
    if (p.requestId) {
      const body = await cdp(tab.id, 'Network.getResponseBody', { requestId: p.requestId });
      const text = body.base64Encoded ? `[base64, ${body.body.length} chars]` : body.body;
      return { requestId: p.requestId, body: text.slice(0, p.maxChars || 20_000), truncated: text.length > (p.maxChars || 20_000) };
    }
    let items = [...d.network.values()];
    if (p.failedOnly) items = items.filter((r) => r.ok === false && !r.canceled);
    if (p.pattern) { const re = new RegExp(p.pattern, 'i'); items = items.filter((r) => re.test(r.url)); }
    if (p.types?.length) items = items.filter((r) => p.types.includes(r.type));
    const out = items.slice(-(p.limit || 50)).map((r) => ({
      requestId: r.id, method: r.method, status: r.status ?? (r.failed ? r.errorText : 'pending'),
      type: r.type, url: r.url.length > 300 ? r.url.slice(0, 300) + '…' : r.url, ms: r.durationMs,
    }));
    if (p.clear) { d.network.clear(); }
    return { tabId: tab.id, count: out.length, captured: d.attached, requests: out };
  },

  async dialog(p) {
    const tab = await tabFor(p);
    const d = dbgRec(tab.id);
    let was = d.dialog;
    if (!was) {
      // A dialog that opened before the bridge attached sends no event; try anyway.
      try {
        await withTimeoutFn(attach(tab.id), 6000, () => 'attach timed out').catch(() => {});
        await withTimeoutFn(chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.handleJavaScriptDialog', { accept: p.accept !== false, promptText: p.promptText }), 4000, () => 'timed out');
        was = { type: 'unknown (opened before the bridge attached)' };
      } catch (e) {
        const stalled = dbg.get(tab.id)?.stalled && !(await probeTab(tab.id));
        return {
          handled: false,
          note: stalled
            ? 'the page is blocked but the debugger cannot see a dialog: it opened before the bridge attached and is shown in the browser window. Ask the user to answer it there, or close this tab with browser_close (that works) and open the page again.'
            : `no JavaScript dialog is open (${e.message})`,
        };
      }
    } else {
      await cdp(tab.id, 'Page.handleJavaScriptDialog', { accept: p.accept !== false, promptText: p.promptText });
    }
    d.dialog = null;
    d.stalled = null;
    await settle(tab.id, 3000);
    return { handled: true, dialog: was, accepted: p.accept !== false, ...(await pageReport(tab.id, null)) };
  },

  async upload(p) {
    const tab = await tabFor(p);
    const loc = await locate(tab.id, p);
    const nonce = Math.random().toString(36).slice(2);
    const input = await callFrame(tab.id, loc.frameId, 'markForUpload', { ...loc.params, nonce });
    await cdp(tab.id, 'DOM.getDocument', { depth: 0 });
    const search = await cdp(tab.id, 'DOM.performSearch', { query: `[data-cbb-upload="${nonce}"]`, includeUserAgentShadowDOM: false });
    let nodeId;
    if (search.resultCount) {
      const { nodeIds } = await cdp(tab.id, 'DOM.getSearchResults', { searchId: search.searchId, fromIndex: 0, toIndex: 1 });
      nodeId = nodeIds[0];
    }
    await cdp(tab.id, 'DOM.discardSearchResults', { searchId: search.searchId }).catch(() => {});
    if (!nodeId) throw new Error('file input not reachable through the debugger (it may be inside a cross-origin iframe)');
    const before = await marks(tab.id);
    await cdp(tab.id, 'DOM.setFileInputFiles', { files: p.paths, nodeId });
    await settle(tab.id, 5000);
    return { uploaded: p.paths, into: describeEl(input), ...(await pageReport(tab.id, before)) };
  },
};

// Commands that never touch a page (or create their own tab).
const NO_TAB = new Set(['status', 'reload', 'tabs', 'open']);
// Read-only debugging commands: never supersede a running command.
const PASSIVE = new Set(['console', 'network', 'netMark', 'serverMessages']);
// Default watchdog budgets, a few seconds under the MCP tool timeouts, used
// when the hub does not send __budgetMs.
const BUDGET = { fill: 175_000, getText: 175_000, snapshot: 175_000, navigate: 85_000, evaluate: 125_000, upload: 115_000, path: 175_000, screenshot: 55_000 };
const sec = (ms) => `${(ms / 1000).toFixed(1)}s`;

async function probeTab(tabId) {
  return withTimeoutFn(chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: () => 1 }), 3000, () => 'probe timeout')
    .then(() => true, () => false);
}
// The page stopped answering: find out why and try to make the next call work.
async function recoverTab(tabId) {
  if (dbg.get(tabId)?.dialog) return 'blocked by a JavaScript dialog: answer it with browser_dialog';
  if (await probeTab(tabId)) {
    await inject(tabId).catch(() => {});
    return 'tab unresponsive, recovered (the page answers again; content script re-injected)';
  }
  await withTimeoutFn(detach(tabId), 3000, () => 'detach timed out').catch(() => {});
  dbgRec(tabId).dialog = null;
  await withTimeoutFn(attach(tabId), 8000, () => 'attach timed out').catch(() => {});
  if (dbg.get(tabId)?.stalled && !dbg.get(tabId)?.dialog) return `tab unresponsive (${dbg.get(tabId).stalled}): probably a JavaScript dialog opened before the bridge attached - call browser_dialog; otherwise reload needed`;
  if (dbg.get(tabId)?.dialog) return 'blocked by a JavaScript dialog (seen after re-attaching): answer it with browser_dialog';
  if (await probeTab(tabId)) {
    await inject(tabId).catch(() => {});
    return 'tab unresponsive, recovered (debugger re-attached, content script re-injected)';
  }
  return 'tab unresponsive, reload needed (the page does not run scripts; use browser_navigate action "reload")';
}

async function handle(method, params, reqId) {
  const fn = commands[method];
  if (!fn) throw new Error(`unknown command "${method}"`);
  if (NO_TAB.has(method) || PASSIVE.has(method)) return fn(params);
  const tabId = (await tabFor(params)).id; // also validates ownership / pause
  // Attach first (bounded) so a dialog that is already open is known before
  // any page call: page calls freeze while one is open.
  if (method !== 'dialog' && !dbg.get(tabId)?.attached) await withTimeoutFn(attach(tabId), 8000, () => 'attach timed out').catch(() => {});
  const d = dbg.get(tabId);
  if (d?.stalled && !d.dialog && !DIALOG_OK.has(method)) {
    // The debugger answers but the page does not: confirm with a probe.
    if (await probeTab(tabId)) d.stalled = null;
    else {
      throw new TabBlocked(`the page is not running scripts (${d.stalled}); most likely a JavaScript dialog ("Leave site?", alert or confirm) is open that opened before the bridge attached. `
        + 'Call browser_dialog (accept:true leaves/confirms, accept:false stays/cancels). If it says no dialog is showing, the dialog is displayed in the browser window itself: ask the user to answer it, or close this tab with browser_close and open the page again.');
    }
  }
  const nav = method === 'navigate';
  if (d?.dialog && !DIALOG_OK.has(method) && !(nav && d.dialog.type === 'beforeunload' && /^(accept|dismiss)$/.test(params.onBeforeUnload || ''))) {
    throw blockedError(tabId, null);
  }
  // A newer command for the same tab supersedes an older one still running
  // (the caller gave up on it): it must not act on the page any more.
  const prev = runs.get(tabId);
  if (prev && !prev.cancelled) prev.cancelled = `superseded by ${method} after ${sec(Date.now() - prev.started)} while ${prev.step || 'starting'}`;
  const run = { id: ++runSeq, reqId, method, step: 'starting', stepAt: Date.now(), started: Date.now(), cancelled: null };
  runs.set(tabId, run);
  const budget = Math.max(5000, (params.__budgetMs ? params.__budgetMs - 4000 : BUDGET[method] || (method === 'waitFor' ? Math.min(params.timeoutMs || 15_000, 120_000) + 10_000 : 55_000)));
  let watch;
  const watchdog = new Promise((_, reject) => {
    watch = setInterval(() => {
      const dl = dbg.get(tabId)?.dialog;
      if (dl && !DIALOG_OK.has(method) && !(nav && dl.type === 'beforeunload')) {
        run.cancelled = 'tab blocked by a dialog';
        reject(blockedError(tabId, run));
      } else if (run.cancelled && /hub/.test(run.cancelled)) {
        reject(new Cancelled(`cancelled: ${run.cancelled}`));
      } else if (Date.now() - run.started > budget) {
        run.cancelled = `watchdog after ${sec(budget)}`;
        reject(Object.assign(new Error(`no progress within ${sec(budget)}`), { watchdog: true }));
      }
    }, 200);
  });
  try {
    return await Promise.race([fn(params), watchdog]);
  } catch (e) {
    if (e instanceof TabBlocked || e instanceof Cancelled) throw e;
    if (e.watchdog || /did not answer|timed out after/.test(e.message)) {
      run.cancelled = run.cancelled || 'page stopped answering';
      const where = `${method} stopped while ${run.step} (step running for ${sec(Date.now() - run.stepAt)}, ${sec(Date.now() - run.started)} in total)`;
      const status = await recoverTab(tabId);
      throw new Error(`${where}: ${e.message}. ${status}.`);
    }
    throw e;
  } finally {
    clearInterval(watch);
    if (runs.get(tabId) === run) runs.delete(tabId);
  }
}
// The hub gave up on a request (its own timeout): stop that command.
function cancelRequest(reqId) {
  for (const r of runs.values()) if (r.reqId === reqId && !r.cancelled) r.cancelled = 'the hub stopped waiting for it';
}

// ---------------------------------------------------------------------------
// popup messages
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    await ready;
    switch (msg.cmd) {
      case 'status': {
        const [cur] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const tabs = await commands.tabs({});
        return {
          connected: conn.connected, port: S.port, paused: S.paused, openMode: S.openMode,
          lastError: conn.lastError, browser: browserName(),
          currentTab: cur ? { id: cur.id, title: cur.title, url: cur.url, controlled: S.controlled[cur.id] || false } : null,
          tabs,
        };
      }
      case 'share': await controlTab(msg.tabId, 'user'); return { ok: true };
      case 'unshare': await releaseTab(msg.tabId); return { ok: true };
      case 'setPaused':
        S.paused = !!msg.value;
        await chrome.storage.local.set({ paused: S.paused });
        if (S.paused) for (const id of dbg.keys()) await detach(id);
        updateBadge();
        return { ok: true };
      case 'setOpenMode':
        S.openMode = msg.value === 'tab' ? 'tab' : 'window';
        await chrome.storage.local.set({ openMode: S.openMode });
        return { ok: true };
      case 'setPort':
        S.port = Number(msg.value) || DEFAULT_PORT;
        await chrome.storage.local.set({ port: S.port });
        conn.ws?.close();
        conn.retryMs = 500;
        connect();
        return { ok: true };
      case 'reconnect':
        conn.retryMs = 1000;
        await connect();
        return { ok: true };
      default: return { error: 'unknown' };
    }
  })().then(reply, (e) => reply({ error: e.message }));
  return true;
});
