const $ = (id) => document.getElementById(id);
// Every action shows its outcome, so a click that did not take effect is visible.
const OK_TEXT = { approval: (m) => (m.approve ? 'Approved.' : 'Denied.'), setOrgType: (m) => `Org type: ${m.type || 'detected from the address'}.`, prodWrites: (m) => (m.minutes ? `Writes allowed for ${m.minutes} min.` : 'Writes in production stopped.'), orgConsent: (m) => (m.allow ? 'Allowed.' : 'Revoked.') };
const bg = async (msg) => {
  let r;
  try { r = await chrome.runtime.sendMessage(msg); } catch (e) { r = { error: e.message }; }
  if (msg.cmd !== 'status' && !(msg.cmd === 'debuglog' && (['status', 'orgs', 'plan'].includes(msg.action) || (msg.action === 'capture' && ['view', 'check', 'log', 'search', 'explain'].includes(msg.step))))) {
    const el = document.getElementById('actionMsg');
    if (el) {
      const bad = r && (r.error || r.ok === false);
      el.hidden = false;
      el.className = `status ${bad ? 'bad' : 'ok'}`;
      el.textContent = bad ? `Not done: ${r.error || (r.errors || []).join('; ') || 'unknown error'}` : (OK_TEXT[msg.cmd]?.(msg) || 'Done.');
    }
  }
  return r;
};
const NL = String.fromCharCode(10);
// per-viewer convenience only (last tab shown); the popup works without it
const remember = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

// ---------------------------------------------------------------------------
// tabs (main sections and the Allow / Block switch), with arrow-key support
// ---------------------------------------------------------------------------
function tabGroup(tabIds, onSelect) {
  const select = (id, focus) => {
    for (const t of tabIds) {
      const on = t === id;
      $(t).setAttribute('aria-selected', String(on));
      $(t).tabIndex = on ? 0 : -1;
      $($(t).getAttribute('aria-controls')).hidden = !on;
    }
    if (focus) $(id).focus();
    onSelect?.(id);
  };
  tabIds.forEach((t, i) => {
    $(t).onclick = () => select(t);
    $(t).onkeydown = (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (d) { e.preventDefault(); select(tabIds[(i + d + tabIds.length) % tabIds.length], true); }
    };
  });
  return select;
}
const showSection = tabGroup(['tab-control', 'tab-sites', 'tab-settings'], (id) => remember.set('popupTab', id));
const SEG_HINT = {
  'seg-allow': 'Claude may act only on pages that match one of these. Empty = every site.',
  'seg-block': 'Claude never acts on pages that match one of these, even if allowed.',
};
const showList = tabGroup(['seg-allow', 'seg-block'], (id) => { $('segHint').textContent = SEG_HINT[id]; });
showList('seg-allow');
const last = remember.get('popupTab');
if (last && $(last)) showSection(last);

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------
let current = null; // current browser tab, for the address tester
// Chrome tab group colours, so a session's swatch matches its tab group
const GROUP_COLORS = { grey: '#5f6368', blue: '#1a73e8', red: '#d93025', yellow: '#f9ab00', green: '#188038', pink: '#d01884', purple: '#a142f4', cyan: '#007b83', orange: '#fa903e' };

function setStatus(el, check) {
  el.hidden = !check;
  if (!check) return;
  el.className = 'status ' + (check.allowed ? 'ok' : 'bad');
  el.textContent = check.allowed ? `✓ Claude can act here: ${check.reason}` : `✕ Claude cannot act here: ${check.reason}`;
}

async function render() {
  const s = await bg({ cmd: 'status' });
  $('dot').className = 'dot' + (s.connected ? ' on' : '');
  $('browser').textContent = s.browser || '';
  $('pausedPill').hidden = !s.paused;
  $('pausedPill').className = 'pill' + (s.paused ? ' paused' : '');
  const connText = s.connected ? `Connected to Claude on port ${s.port}` : 'Not connected to Claude';
  $('conn').textContent = connText;
  $('conn2').textContent = connText;
  $('connErr').textContent = s.connected ? '' : `Claude Code starts the hub when it loads the browser MCP server. ${s.lastError || ''}`;
  $('pause').textContent = s.paused ? 'Resume Claude' : 'Pause Claude';
  $('pause').className = s.paused ? 'primary' : '';
  $('pause').onclick = async () => { await bg({ cmd: 'setPaused', value: !s.paused }); render(); };

  const cur = s.currentTab;
  current = cur;
  $('cur').textContent = cur ? (cur.title || cur.url) : '-';
  $('cur').title = cur?.url || '';
  setStatus($('curSite'), cur?.site);
  $('share').disabled = !cur;
  $('share').textContent = cur?.controlled ? (cur.controlled === 'user' ? 'Stop sharing this tab' : 'Take this tab back from Claude') : 'Let Claude control this tab';
  $('share').onclick = async () => { await bg({ cmd: cur.controlled ? 'unshare' : 'share', tabId: cur.id }); render(); };

  const ul = $('tabs');
  ul.replaceChildren();
  for (const t of s.tabs) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'grow title';
    name.textContent = t.title || t.url;
    name.title = t.url;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = t.session || (t.controlled === 'user' ? 'shared by you' : 'Claude');
    who.title = { claude: 'opened by Claude', user: 'shared by you', child: 'popup / new tab of a Claude tab' }[t.controlled] || '';
    li.append(name, who);
    ul.append(li);
  }
  if (!s.tabs.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'None';
    ul.append(li);
  }
  $('tabCount').textContent = s.tabs.length;

  // Claude sessions (lanes), each with its own tabs; End releases or closes them
  const lanes = $('lanes');
  lanes.replaceChildren();
  for (const l of s.sessions || []) {
    const li = document.createElement('li');
    li.className = 'lane';
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = GROUP_COLORS[l.color] || GROUP_COLORS.grey;
    const name = document.createElement('span');
    name.className = 'grow title';
    name.textContent = l.label;
    const info = document.createElement('span');
    info.className = 'who';
    const mode = !l.agent ? '' : l.brief ? (l.brief.data === 'write' ? ' · may write' : ' · read-only') : ' · no brief (read-only)';
    info.textContent = `${l.tabs} tab${l.tabs === 1 ? '' : 's'} · ${l.busy ? 'working' : l.idleMin ? `idle ${l.idleMin} min` : 'active'}${mode}`;
    if (l.brief) info.title = `Brief: ${l.brief.target}\nOrg: ${l.brief.org}`;
    const end = document.createElement('button');
    end.className = 'small';
    end.textContent = 'End';
    end.title = s.closeOnEnd ? 'End this session and close its tabs' : 'End this session; its tabs stay open';
    end.onclick = async () => { await bg({ cmd: 'endLane', id: l.id }); render(); };
    li.append(sw, name, info, end);
    lanes.append(li);
  }
  if (!s.sessions?.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'None';
    lanes.append(li);
  }
  $('laneCount').textContent = s.sessions?.length || 0;

  renderDebugLogs(); // asks the MCP server; filled in when it answers

  // destructive actions waiting for the user's approval
  const al = $('approvalList');
  al.replaceChildren();
  for (const a of s.approvals || []) {
    const li = document.createElement('li');
    li.className = 'lane';
    const txt = document.createElement('span');
    txt.className = 'grow';
    let page = a.url;
    try { const u = new URL(a.url); page = u.pathname; } catch { /* keep */ }
    txt.textContent = `${a.session}: ${a.what}`;
    txt.title = `on ${page}`;
    const yes = document.createElement('button');
    yes.className = 'small primary';
    yes.textContent = 'Approve';
    yes.onclick = async () => { await bg({ cmd: 'approval', id: a.id, approve: true }); render(); };
    const no = document.createElement('button');
    no.className = 'small';
    no.textContent = 'Deny';
    no.onclick = async () => { await bg({ cmd: 'approval', id: a.id, approve: false }); render(); };
    li.append(txt, yes, no);
    al.append(li);
  }
  $('approvals').hidden = !(s.approvals || []).length;

  // reading the current org's setup (UI API): the user's choice per org
  const co = s.currentOrg;
  // org type (correctable) and writes in production
  $('orgType').hidden = !co;
  $('prodWrites').hidden = !co || co.type !== 'production';
  if (co) {
    $('orgTypeName').textContent = co.type;
    $('orgTypeSource').textContent = `(${co.typeSource})`;
    if (document.activeElement !== $('orgTypeSel')) $('orgTypeSel').value = co.typeSource === 'set by the user' ? co.type : '';
    $('orgTypeSel').onchange = async (e) => { await bg({ cmd: 'setOrgType', url: `https://${co.host}`, type: e.target.value || null }); render(); };
    const btns = $('prodWritesBtns');
    btns.replaceChildren();
    if (s.managed?.productionWrites === 'never') {
      $('prodWritesText').textContent = 'Read-only for Claude (your organization\'s policy).';
    } else if (co.prodWritesUntil) {
      $('prodWritesText').textContent = `Claude may write here until ${new Date(co.prodWritesUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
      const stop = document.createElement('button');
      stop.className = 'small';
      stop.textContent = 'Stop';
      stop.onclick = async () => { await bg({ cmd: 'prodWrites', url: `https://${co.host}`, minutes: 0 }); render(); };
      btns.append(stop);
    } else {
      $('prodWritesText').textContent = 'Production: read-only for Claude. Allow writes for';
      for (const m of [15, 30, 60]) {
        const b = document.createElement('button');
        b.className = 'small';
        b.textContent = `${m} min`;
        b.onclick = async () => { await bg({ cmd: 'prodWrites', url: `https://${co.host}`, minutes: m }); render(); };
        btns.append(b);
      }
    }
  }
  $('orgRead').hidden = !co;
  if (co) {
    $('orgReadText').textContent = co.allowed ? `Claude may read this org's setup (${co.type})` : `Let Claude read this org's setup? (${co.type})`;
    $('orgReadBtn').textContent = co.allowed ? 'Revoke' : 'Allow';
    $('orgReadBtn').className = co.allowed ? 'small' : 'small primary';
    $('orgReadBtn').onclick = async () => { await bg({ cmd: 'orgConsent', url: `https://${co.host}`, allow: !co.allowed }); render(); };
  }
  const cl = $('consentList');
  cl.replaceChildren();
  for (const c of Object.values(s.orgConsent || {})) {
    const li = document.createElement('li');
    li.className = 'lane';
    const name = document.createElement('span');
    name.className = 'grow title';
    name.textContent = c.host;
    name.title = `allowed ${c.at}`;
    const clear = document.createElement('button');
    clear.className = 'small';
    clear.textContent = 'Clear cache';
    clear.title = 'Delete what the MCP server cached for this org (read again on next use)';
    clear.onclick = async () => { await bg({ cmd: 'clearOrgCache', host: c.host }); clear.textContent = 'Cleared'; };
    const rev = document.createElement('button');
    rev.className = 'small';
    rev.textContent = 'Revoke';
    rev.onclick = async () => { await bg({ cmd: 'orgConsent', url: `https://${c.host}`, allow: false }); render(); };
    li.append(name, clear, rev);
    cl.append(li);
  }
  if (!cl.children.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'None yet. Allow an org from the Control tab while it is open.';
    cl.append(li);
  }
  if (document.activeElement !== $('closeOnEnd')) $('closeOnEnd').value = s.closeOnEnd ? 'close' : 'keep';
  if (document.activeElement !== $('laneIdleMin')) $('laneIdleMin').value = s.laneIdleMin ?? 30;

  if (document.activeElement !== $('openMode')) $('openMode').value = s.openMode;
  if (document.activeElement !== $('port')) $('port').value = s.port;

  // keep what the user is typing; fill only when not being edited
  if (!sitesDirty) {
    $('allowList').value = (s.allowList || []).join(NL);
    $('blockList').value = (s.blockList || []).join(NL);
  }
  sitesChanged(false);
  // lists set by the organization's policy: shown, not editable
  const locked = !!s.managed?.siteLists;
  $('managedNotice').hidden = !locked;
  for (const id of ['allowList', 'blockList', 'saveSites', 'resetSites']) $(id).disabled = locked;
  // saved lists older than the current defaults: offer them once (not forced)
  const older = (s.sitesDefaultsVersion || 1) < SitePolicy.DEFAULTS_VERSION;
  $('defaultsNotice').hidden = !older || remember.get('defaultsDismissed') === String(SitePolicy.DEFAULTS_VERSION);
  if (!$('testUrl').value && cur?.url) { $('testUrl').value = cur.url; testUrl(); }
}

// ---------------------------------------------------------------------------
// sites
// ---------------------------------------------------------------------------
let sitesDirty = false;
function sitesChanged(byUser = true) {
  if (byUser) { sitesDirty = true; $('sitesSaved').textContent = ''; }
  $('sitesDirtyDot').hidden = !sitesDirty;
  // count and check while typing, with the same code the extension uses
  const allow = SitePolicy.compile($('allowList').value);
  const block = SitePolicy.compile($('blockList').value);
  $('allowCount').textContent = allow.rules.length || 'any';
  $('blockCount').textContent = block.rules.length;
  $('siteErr').textContent = [...allow.errors.map((e) => `Allow: ${e}`), ...block.errors.map((e) => `Block: ${e}`)].join(NL);
  $('saveSites').disabled = !sitesDirty || !!(allow.errors.length || block.errors.length);
  testUrl();
}
// the tester uses what is in the boxes (saved or not), so you can try a pattern first
function testUrl() {
  const url = $('testUrl').value.trim();
  if (!url) { setStatus($('testOut'), null); return; }
  const full = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
  const check = SitePolicy.check(full, $('allowList').value, $('blockList').value);
  setStatus($('testOut'), { ...check, reason: check.reason + (sitesDirty ? ' (unsaved lists)' : '') });
}
$('allowList').oninput = () => sitesChanged();
$('blockList').oninput = () => sitesChanged();
$('testUrl').oninput = testUrl;

// fills the boxes only; nothing changes until Save
let filledDefaults = false;
$('resetSites').onclick = () => {
  $('allowList').value = SitePolicy.DEFAULT_ALLOW.join(NL);
  $('blockList').value = SitePolicy.DEFAULT_BLOCK.join(NL);
  sitesChanged();
  filledDefaults = true;
  $('sitesSaved').textContent = 'Defaults filled in. Press Save.';
};
$('useDefaults').onclick = () => { $('resetSites').onclick(); $('defaultsNotice').hidden = true; };
$('dismissDefaults').onclick = () => { remember.set('defaultsDismissed', String(SitePolicy.DEFAULTS_VERSION)); $('defaultsNotice').hidden = true; };
$('saveSites').onclick = async () => {
  const r = await bg({
    cmd: 'setSites', allow: $('allowList').value, block: $('blockList').value,
    ...(filledDefaults ? { defaultsVersion: SitePolicy.DEFAULTS_VERSION } : {}),
  });
  filledDefaults = false;
  if (!r?.ok) { $('siteErr').textContent = (r?.errors || [r?.error || 'not saved']).join(NL); return; }
  sitesDirty = false;
  $('sitesSaved').textContent = 'Saved.';
  render();
};

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------
// Debug logs: set up only in the developer's terminal; here Start / Stop / Remove.
async function renderDebugLogs() {
  const r = await bg({ cmd: 'debuglog', action: 'status' });
  const btns = $('dlBtns');
  btns.replaceChildren();
  const button = (text, primary, msg) => {
    const b = document.createElement('button');
    b.className = `small${primary ? ' primary' : ''}`;
    b.textContent = text;
    b.onclick = async () => { b.disabled = true; await bg({ cmd: 'debuglog', ...msg }); renderDebugLogs(); };
    btns.append(b);
  };
  // no bridge server: it runs inside Claude Code
  if (!r?.ok) { $('dlText').textContent = /not connected|did not answer/i.test(r?.error || '') ? 'Open Claude Code to capture (the bridge server runs with it).' : `Unavailable: ${r?.error || 'no answer'}`; $('dlCap').hidden = true; return; }
  const d = r.debuglog;
  $('dlCap').hidden = d.state === 'not set up';
  if (d.state === 'not set up') {
    $('dlText').textContent = 'Not set up.';
    const b = document.createElement('button');
    b.className = 'small primary';
    b.textContent = 'Set up…';
    b.onclick = () => { showSection('tab-settings'); openDebugSetup(); };
    btns.append(b);
  } else if (d.state === 'ready') {
    $('dlText').textContent = 'Off.';
    $('dlText').title = `${d.user} · ${d.org}`;
    button('Start 30 min', true, { action: 'start', minutes: 30 });
    button('Remove', false, { action: 'remove' });
  } else {
    $('dlText').textContent = `On · ${d.minutesLeft} min left`;
    $('dlText').title = `${d.user} · ${d.org}`;
    button('Stop', false, { action: 'stop' });
    button('Remove', false, { action: 'remove' });
  }
}
OK_TEXT.debuglog = (m) => ({ start: 'Debug logs started.', stop: 'Debug logs stopped.', remove: 'Debug logging removed from the org.', setup: 'Debug logs are set up and on.', capture: { start: 'Capture started.', stop: 'Capture stopped.', adduser: 'Logging added.', send: 'Sent to Claude.', end: 'Capture ended.' }[m.step] }[m.action] || 'Done.');

// Capture: Start marks "from now" (and turns logging on), Stop is optional. The logs
// of every user since then are listed: the record, errors and data changes first,
// the rest folded. Find searches the downloaded logs as you type (highlights,
// hides nothing); Check fetches new ones. Explain, Download, Send to Claude.
// Claude can start, stop and search the same capture.
const capture = (step, extra = {}) => bg({ cmd: 'debuglog', action: 'capture', step, ...extra });
const capTicks = new Map(); // the developer's own ticks
let capTimer = null; let capBusy = false; let capTyping = null;
const recordOf = (url) => /\/lightning\/r\/(?:\w+\/)?([a-zA-Z0-9]{15,18})(?:[/?#]|$)/.exec(url || '')?.[1] || /[?&]id=([a-zA-Z0-9]{15,18})\b/.exec(url || '')?.[1] || '';
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const node = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text !== undefined) x.textContent = text; return x; };
// a line with the search words highlighted (DOM nodes, never HTML strings)
function highlighted(line, terms) {
  const out = node('code');
  // whole words, as the search does ("Hot" not in "PhotoUrl")
  const words = terms.filter(Boolean).map((t) => `${/^\w/.test(t) ? '(?<![A-Za-z0-9_])' : ''}${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${/\w$/.test(t) ? '(?![A-Za-z0-9_])' : ''}`);
  if (!words.length) { out.textContent = line; return out; }
  const re = new RegExp(`(${words.join('|')})`, 'gi');
  let last = 0;
  for (const m of line.matchAll(re)) { out.append(line.slice(last, m.index), node('mark', '', m[0])); last = m.index + m[0].length; }
  out.append(line.slice(last));
  return out;
}
function logItem(h, v) {
  const item = node('li');
  if (h.record || h.error) item.className = 'likely';
  const box = node('input');
  box.type = 'checkbox';
  box.checked = capTicks.has(h.id) ? capTicks.get(h.id) : (v.selected ? v.selected.includes(h.id) : h.record || h.error);
  box.setAttribute('aria-label', `Use log ${h.id}`);
  box.dataset.id = h.id;
  box.onchange = () => capTicks.set(h.id, box.checked);
  const text = node('div', 'what', `${clock(h.at)} · ${h.kind}${h.user ? ` · ${h.user}` : ''}`);
  const flags = [h.record && 'has the record', h.changes && 'changes data'].filter(Boolean);
  text.append(node('div', 'why', flags.length ? flags.join(', ') : 'nothing about the record'));
  if (h.errorText) text.append(node('code', 'err', `Error: ${h.errorText}`));
  for (const [term, lines] of Object.entries(h.matches || {})) for (const l of lines.slice(0, 1)) text.append(highlighted(l.length > 220 ? `${l.slice(0, 220)}…` : l, [term]));
  const ex = node('div', 'ex'); ex.hidden = true;
  text.append(ex);
  const btns = node('div', 'btns');
  const explain = node('button', 'small', 'Explain'); explain.type = 'button'; explain.title = 'What this log changed, and why';
  explain.onclick = () => explainLog(h.id, explain, ex);
  const dl = node('button', 'small', 'Download'); dl.type = 'button'; dl.title = `Download ${h.id}.log`;
  dl.onclick = () => downloadLog(h.id, dl);
  btns.append(explain, dl);
  item.append(box, text, btns);
  return item;
}
function showCapture(v) {
  const live = !!v && v.status && v.status !== 'none';
  $('dlCapStart').textContent = live ? 'New capture' : 'Start capture';
  $('dlCapStop').hidden = !(live && v.status === 'capturing');
  $('dlCapEnd').hidden = !live;
  $('dlCapFind').hidden = !live;
  $('dlCapList').replaceChildren(); $('dlCapRest').replaceChildren();
  $('dlCapMore').hidden = true; $('dlCapSend').hidden = true; $('dlCapAdd').hidden = true;
  if (!live) {
    $('dlCapState').textContent = 'Finds the logs of your next change, API call or scheduled job.';
    $('dlCapSay').textContent = '';
    clearInterval(capTimer); capTimer = null;
    return;
  }
  const who = (b) => (b === 'claude' ? ' by Claude' : '');
  $('dlCapState').textContent = v.status === 'capturing'
    ? `Capturing since ${clock(v.at)}${who(v.startedBy)}`
    : `${clock(v.at)} to ${clock(v.stoppedAt)}${v.startedBy === 'claude' ? ', started by Claude' : ''}${v.stoppedBy === 'claude' ? ', stopped by Claude' : ''}`;
  if (document.activeElement !== $('dlCapTerms')) $('dlCapTerms').value = (v.terms || []).join(', ');
  $('dlCapSay').textContent = `${v.say || ''}${v.sentAt ? ` Sent to Claude at ${clock(v.sentAt)}: ask Claude to investigate your capture.` : ''}`.trim();
  if (v.addUser) { const add = $('dlCapAdd'); add.hidden = false; add.textContent = `Log ${v.addUser.name} too`; add.onclick = () => capAction('adduser', { user: v.addUser.id }); }
  const logs = v.logs || [];
  for (const h of logs.filter((x) => !x.folded)) $('dlCapList').append(logItem(h, v));
  const rest = logs.filter((x) => x.folded);
  if (rest.length) { $('dlCapMore').hidden = false; $('dlCapMoreSum').textContent = `${rest.length} other log(s), nothing about the record`; for (const h of rest) $('dlCapRest').append(logItem(h, v)); }
  $('dlCapSend').hidden = !logs.length;
  if (v.status === 'capturing' && !capTimer) capTimer = setInterval(() => capAction('check', {}, true), 15_000);
  if (v.status !== 'capturing') { clearInterval(capTimer); capTimer = null; }
}
async function capAction(step, extra = {}, quiet = false) {
  if (capBusy && quiet) return; // a check is still running
  capBusy = true;
  if (!quiet && ['check', 'stop', 'send'].includes(step)) $('dlCapSay').textContent = step === 'send' ? 'Explaining the ticked logs…' : 'Fetching the logs…';
  const r = await capture(step, extra);
  capBusy = false;
  if (!r?.ok) { $('dlCapSay').textContent = `Not done: ${r?.error || 'no answer'}`; return; }
  if (step === 'adduser') { $('dlCapSay').textContent = r.debuglog.note; renderDebugLogs(); return capAction('check'); }
  showCapture(r.debuglog);
}
async function explainLog(id, btn, box) {
  if (!box.hidden) { box.hidden = true; return; }
  btn.disabled = true; btn.textContent = '…';
  const r = await capture('explain', { id });
  btn.disabled = false; btn.textContent = 'Explain';
  box.replaceChildren(); box.hidden = false;
  if (!r?.ok) { box.append(node('code', 'err', `Not done: ${r?.error || 'no answer'}`)); return; }
  const e = r.debuglog;
  if (e.notSaved) box.append(node('code', 'err', `Not saved: ${e.notSaved}`));
  for (const x of e.errors || []) box.append(node('code', 'err', x));
  for (const x of e.changes || []) box.append(node('code', '', x));
  if (!e.changes?.length && !e.errors?.length) box.append(node('code', '', e.sameValue?.length ? `Saved, no field changed (${e.sameValue.join(', ')} set to the same value)` : 'No field changes in this log.'));
  if (e.note) box.append(node('code', '', e.note));
}
async function downloadLog(id, btn) {
  btn.disabled = true; btn.textContent = '…';
  const r = await capture('log', { id });
  btn.disabled = false; btn.textContent = 'Download';
  if (!r?.ok) { $('dlCapSay').textContent = `Not done: ${r?.error || 'no answer'}`; return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([r.debuglog.text], { type: 'text/plain' }));
  a.download = r.debuglog.file;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}
$('dlCapStart').onclick = async () => {
  let url = '';
  try { [{ url } = {}] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); } catch { /* no tab */ }
  capTicks.clear();
  $('dlCapStart').disabled = true;
  $('dlCapSay').textContent = 'Starting…';
  const r = await capture('start', { recordId: recordOf(url) });
  $('dlCapStart').disabled = false;
  if (!r?.ok) { $('dlCapSay').textContent = `Not done: ${r?.error || 'no answer'}`; return; }
  showCapture(r.debuglog);
  renderDebugLogs(); // logging may have been turned on
};
$('dlCapStop').onclick = () => capAction('stop');
$('dlCapEnd').onclick = async () => { capTicks.clear(); await capture('end'); showCapture(null); };
// Find: as you type, over the downloaded logs (instant); Check / Enter also fetches new logs
$('dlCapTerms').addEventListener('input', () => {
  clearTimeout(capTyping);
  capTyping = setTimeout(() => capAction('search', { terms: $('dlCapTerms').value }, true), 300);
});
$('dlCapFind').addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(capTyping); capAction('search', { terms: $('dlCapTerms').value, sync: true }); });
$('dlCapSend').onclick = () => {
  const ids = [...document.querySelectorAll('#dlCap input[type=checkbox]:checked')].map((x) => x.dataset.id);
  if (!ids.length) { $('dlCapSay').textContent = 'Tick at least one log.'; return; }
  capAction('send', { ids });
};
// on open: show the capture at once, then catch up (nothing runs while the popup is closed)
(async () => {
  const r = await capture('view');
  if (r?.ok && r.debuglog?.status && r.debuglog.status !== 'none') { showCapture(r.debuglog); capAction('check', {}, true); }
})();

// Setup in the popup: choose the org -> see what will be created -> Create and test.
const li = (text, cls) => { const x = document.createElement('li'); x.textContent = text; if (cls) x.className = cls; return x; };
async function openDebugSetup() {
  $('dlSetup').hidden = false;
  $('dlPlan').textContent = '';
  $('dlWinRow').hidden = true;
  $('dlCreate').hidden = true;
  $('dlProgress').replaceChildren();
  const sel = $('dlOrgSel');
  sel.replaceChildren(new Option('loading the Salesforce CLI\'s orgs…', ''));
  const r = await bg({ cmd: 'debuglog', action: 'orgs' });
  if (!r?.ok) { sel.replaceChildren(new Option('unavailable', '')); $('dlPlan').textContent = r?.error || 'no answer'; return; }
  // short: the alias (or user) and the org's name, not the full host
  sel.replaceChildren(new Option('choose an org…', ''), ...r.debuglog.map((o) => new Option(`${o.alias || o.username} · ${o.host.split('.')[0]}`, o.username)));
  sel.value = ''; // never preselected
}
$('dlOrgSel').onchange = async (e) => {
  $('dlCreate').hidden = true;
  $('dlWinRow').hidden = true;
  $('dlProgress').replaceChildren();
  if (!e.target.value) { $('dlPlan').textContent = ''; return; }
  $('dlPlan').textContent = 'Checking the org…';
  const r = await bg({ cmd: 'debuglog', action: 'plan', username: e.target.value });
  if (!r?.ok) { $('dlPlan').textContent = `Not possible: ${r?.error}`; return; }
  const p = r.debuglog;
  const box = $('dlPlan');
  box.replaceChildren();
  const head = document.createElement('div');
  head.textContent = `${p.organizationType}${p.isSandbox ? ' (sandbox)' : ''} · ${p.userName}`;
  box.append(head);
  if (p.refused) {
    const no = document.createElement('div');
    no.className = 'status bad';
    no.textContent = p.refused;
    box.append(no);
    return;
  }
  const ul = document.createElement('ul');
  ul.style.paddingLeft = '16px';
  for (const c of p.summary) ul.append(li(c));
  box.append(ul);
  const note = document.createElement('div');
  note.textContent = p.note;
  box.append(note);
  $('dlWinRow').hidden = false;
  $('dlCreate').hidden = false;
  $('dlCreate').disabled = false;
};
$('dlCreate').onclick = async () => {
  const username = $('dlOrgSel').value;
  if (!username) return;
  $('dlCreate').disabled = true;
  $('dlOrgSel').disabled = true;
  $('dlProgress').replaceChildren(li('Setting up… (about a minute)'));
  const r = await bg({ cmd: 'debuglog', action: 'setup', username, minutes: Number($('dlWin').value), confirmed: true });
  $('dlOrgSel').disabled = false;
  const prog = $('dlProgress');
  prog.replaceChildren();
  if (r?.ok) {
    for (const l of r.debuglog.lines || []) prog.append(li(l));
    $('dlCreate').hidden = true;
  } else {
    prog.append(li(`Not set up: ${r?.error}`, 'muted'));
    $('dlCreate').disabled = false;
  }
  renderDebugLogs();
};
$('dlCancel').onclick = () => { $('dlSetup').hidden = true; };

const saveLaneOptions = async () => {
  await bg({ cmd: 'setLaneOptions', closeOnEnd: $('closeOnEnd').value === 'close', laneIdleMin: $('laneIdleMin').value });
  $('laneSaved').textContent = 'Saved.';
  setTimeout(() => { $('laneSaved').textContent = ''; }, 1500);
};
$('closeOnEnd').onchange = saveLaneOptions;
$('saveLane').onclick = saveLaneOptions;
$('reconnect').onclick = async () => { await bg({ cmd: 'reconnect' }); setTimeout(render, 600); };
$('openMode').onchange = (e) => bg({ cmd: 'setOpenMode', value: e.target.value });
$('savePort').onclick = async () => { await bg({ cmd: 'setPort', value: $('port').value }); setTimeout(render, 600); };

render();
