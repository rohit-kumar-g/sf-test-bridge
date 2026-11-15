// Phase 4: debug logs through the developer's own Salesforce CLI.
// Spec: runs/20261115_dev-companion-plan/DEBUGLOG_SPEC.md
//
// Promises: set up only by the developer (cli.js debuglog setup), never a
// guessed org (every call passes --target-org <username>), production
// refused, only the records this setup created are ever changed (their ids
// are in the state file), Claude can only stop / remove, everything is in the
// action log. Logs are read only for the configured user and only during a
// check window.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, exec } from 'node:child_process';
import { createRequire } from 'node:module';
import { STATE_DIR } from './hub.js';
import { logAction } from './actionlog.js';
import * as D from './sfdirect.js';
import { mask } from './apexlog.js';

const SitePolicy = createRequire(import.meta.url)('../../extension/sitepolicy.js');
export const STATE_FILE = process.env.BROWSER_BRIDGE_DEBUGLOG_STATE || path.join(STATE_DIR, 'debuglog.json');
const SF = process.env.BROWSER_BRIDGE_SF_BIN || (process.platform === 'win32' ? 'sf.cmd' : 'sf');
const PREFIX = 'SF_Test_Bridge';

// ---- the CLI ----
// One argument for cmd.exe -> the CLI's argv: wrapped in double quotes when it
// has spaces or shell characters; inner double quotes escaped; % doubled is
// not needed in a non-interactive cmd /c for our arguments (no %VAR% in them).
export function winQuote(a) {
  const s = String(a);
  if (!/[\s"'<>&|^(),;=]/.test(s)) return s;
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}
// Every call: JSON output, the explicit org (never the CLI's default), logged.
export function sf(args, { org, timeoutMs = 120_000, write = false, what } = {}) {
  const full = [...args, ...(org ? ['--target-org', org] : []), '--json'];
  // BROWSER_BRIDGE_SF_BIN may point at a .js / .mjs stand-in (tests).
  // On Windows sf is sf.cmd and runs through the shell, which splits
  // arguments at spaces: quote them (a SOQL query is one argument).
  const viaShell = process.platform === 'win32' && !/\.m?js$/.test(SF);
  const opts = { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true };
  return new Promise((resolve, reject) => {
    const done = (err, stdout) => {
      let j = null;
      try { j = JSON.parse(stdout); } catch { /* not JSON */ }
      const ok = j && j.status === 0;
      logAction('sf-test-bridge (debug logs)', `sf ${args.slice(0, 3).join(' ')}`, { org, what, write }, ok, ok ? 'ok' : (j?.message || err?.message || 'failed'));
      if (ok) resolve(j.result);
      else reject(new Error(j?.message || (err?.code === 'ENOENT' || /not recognized/.test(err?.message || '') ? 'Salesforce CLI (sf) not found' : err?.message) || 'sf failed'));
    };
    if (/\.m?js$/.test(SF)) execFile(process.execPath, [SF, ...full], opts, done);
    else if (viaShell) exec([SF, ...full].map(winQuote).join(' '), opts, done); // one quoted command line for cmd.exe
    else execFile(SF, full, opts, done);
  });
}
// Reads go straight to Salesforce through the CLI's own library and login (fast;
// sfdirect.js: GET only, the session stays in the library), the CLI when that
// fails. Writes: the CLI.
async function readQuery(username, soql, { tooling: tq = false, what = 'query' } = {}) {
  if (D.enabled()) { try { return await D.query(username, soql, { tooling: tq, what }); } catch { /* the CLI below */ } }
  return sf(['data', 'query', ...(tq ? ['--use-tooling-api'] : []), '--query', soql], { org: username, what });
}
const tooling = (obj, fields, org, what) => sf(['data', 'create', 'record', '--use-tooling-api', '--sobject', obj, '--values', fields], { org, write: true, what });
const toolingDelete = (obj, id, org, what) => sf(['data', 'delete', 'record', '--use-tooling-api', '--sobject', obj, '--record-id', id], { org, write: true, what });
const toolingGet = (obj, id, org) => sf(['data', 'get', 'record', '--use-tooling-api', '--sobject', obj, '--record-id', id], { org, what: `read ${obj}` });

// trace.js, loaded fresh when it changed: the hub reloads this file on change, but
// not the files it imports, so a fix in trace.js would otherwise need a restart
const loadTrace = () => { const u = new URL('./trace.js', import.meta.url); let v = 0; try { v = fs.statSync(u).mtimeMs; } catch { /* keep 0 */ } return import(`${u.href}?v=${v}`); };

// ---- state ----
export function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}
function writeState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  if (s) fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1)); else fs.rmSync(STATE_FILE, { force: true });
}
export function stateView(s = readState()) {
  if (!s) return { state: 'not set up', note: 'Debug logs are off. Only the developer can set them up: node mcp-server/src/cli.js debuglog setup' };
  const on = s.traceFlagId && Date.parse(s.expiresAt) > Date.now();
  return {
    state: on ? 'on' : 'ready', org: s.myDomain, orgType: s.orgType, user: s.username,
    ...(on ? { expiresAt: s.expiresAt, minutesLeft: Math.ceil((Date.parse(s.expiresAt) - Date.now()) / 60_000) } : {}),
    ...(on && (s.extraFlags || []).some((e) => Date.parse(e.expiresAt) > Date.now()) ? { alsoLogging: s.extraFlags.filter((e) => Date.parse(e.expiresAt) > Date.now()).map((e) => e.name) } : {}),
    level: s.levels,
  };
}

// ---- org identity and the production rule ----
export async function identify(username) {
  const disp = await sf(['org', 'display'], { org: username, what: 'identify org and user' });
  const q = await readQuery(username, 'SELECT Id, IsSandbox, OrganizationType, InstanceName FROM Organization', { what: 'org type' });
  const o = q.records?.[0] || {};
  const host = new URL(disp.instanceUrl).hostname;
  const byHost = SitePolicy.orgInfo(disp.instanceUrl);
  // production unless a sandbox, a developer / trial / scratch org, or a non-production partition in the address
  // (a Developer Edition org has IsSandbox = false, so IsSandbox alone is not enough)
  const devLike = /Developer|Trial|Scratch|Partner Developer/i.test(o.OrganizationType || '');
  const production = !o.IsSandbox && !devLike && (!byHost || byHost.type === 'production');
  const user = await readQuery(username, `SELECT Id, Name FROM User WHERE Username = '${String(disp.username).replace(/'/g, "\\'")}' LIMIT 1`, { what: 'CLI user id' });
  return {
    username: disp.username, userId: user.records?.[0]?.Id, userName: user.records?.[0]?.Name, orgId: disp.id || o.Id,
    instanceUrl: disp.instanceUrl, myDomain: host, alias: disp.alias, isSandbox: !!o.IsSandbox, organizationType: o.OrganizationType,
    orgType: o.IsSandbox ? 'sandbox' : devLike ? 'developer' : byHost?.type || 'production', production,
  };
}

// Full detail: the highest level each category takes; Wave and NBA (unrelated
// to the developer's code) off. Salesforce's rejection ("bad value for
// restricted picklist field: FINEST") does not say which category, so:
// 1. one try with the best-known maxima (normally accepted),
// 2. else a baseline every category accepts, then each category raised on
//    its own, highest first (a rejection then pinpoints the category).
const MAXIMA = { ApexCode: 'FINEST', ApexProfiling: 'FINEST', Callout: 'FINEST', Database: 'FINEST', System: 'FINE', Validation: 'INFO', Visualforce: 'FINEST', Workflow: 'FINER', Nba: 'NONE', Wave: 'NONE' };
const SAFE = { ApexCode: 'DEBUG', ApexProfiling: 'INFO', Callout: 'INFO', Database: 'INFO', System: 'DEBUG', Validation: 'INFO', Visualforce: 'INFO', Workflow: 'INFO', Nba: 'NONE', Wave: 'NONE' };
const RAISE = {
  ApexCode: ['FINEST', 'FINER', 'FINE'], ApexProfiling: ['FINEST', 'FINE'], Callout: ['FINEST', 'FINER', 'FINE'], Database: ['FINEST'],
  System: ['FINEST', 'FINER', 'FINE'], Visualforce: ['FINEST', 'FINER', 'FINE'], Workflow: ['FINEST', 'FINER', 'FINE'],
};
const levelValues = (lv) => Object.entries(lv).map(([k, v]) => `${k}=${v}`).join(' ');
async function createDebugLevel(org, name) {
  try {
    const r = await tooling('DebugLevel', `DeveloperName=${name} MasterLabel=${name} ${levelValues(MAXIMA)}`, org, 'create the debug level (full detail)');
    return { id: r.id, levels: { ...MAXIMA } };
  } catch (e) {
    if (!/restricted picklist/i.test(e.message)) throw e;
  }
  const r = await tooling('DebugLevel', `DeveloperName=${name} MasterLabel=${name} ${levelValues(SAFE)}`, org, 'create the debug level (baseline)');
  const levels = { ...SAFE };
  for (const [cat, tries] of Object.entries(RAISE)) {
    for (const lv of tries) {
      try {
        await sf(['data', 'update', 'record', '--use-tooling-api', '--sobject', 'DebugLevel', '--record-id', r.id, '--values', `${cat}=${lv}`], { org, write: true, what: `debug level: ${cat} ${lv}` });
        levels[cat] = lv;
        break;
      } catch (e) { if (!/restricted picklist/i.test(e.message)) throw e; }
    }
  }
  return { id: r.id, levels };
}
async function createTraceFlag(st, minutes) {
  const start = new Date(Date.now() - 60_000);
  const end = new Date(Date.now() + minutes * 60_000);
  const r = await tooling('TraceFlag', `TracedEntityId=${st.userId} DebugLevelId=${st.debugLevelId} LogType=USER_DEBUG StartDate=${start.toISOString()} ExpirationDate=${end.toISOString()}`, st.username, `start debug logs for ${minutes} min`);
  return { id: r.id, expiresAt: end.toISOString() };
}

// ---- setup (the developer, once per org) ----
// Three steps, used by the extension popup (Settings > Debug logs) and by the
// terminal ("debuglog setup"): listOrgs -> plan (identify, refuse
// production, what will be created) -> create (after the developer's
// confirmation: debug level, trace flag, controlled test, rollback on failure).
// Never reachable for Claude: no MCP tool offers it; the hub accepts it only
// from the extension's own connection (the popup).
export async function listOrgs() {
  const list = await sf(['org', 'list'], { what: 'orgs the CLI is logged into' });
  const orgs = [...(list.nonScratchOrgs || []), ...(list.scratchOrgs || []), ...(list.sandboxes || [])]
    .filter((o, i, a) => a.findIndex((x) => x.username === o.username) === i && o.connectedStatus !== 'RefreshTokenAuthError');
  if (!orgs.length) throw new Error('The Salesforce CLI is not logged into any org. Log in first in a terminal: sf org login web --alias <name>');
  return orgs.map((o) => ({ username: o.username, alias: o.alias || null, host: new URL(o.instanceUrl).hostname }));
}

export async function plan(username) {
  const existing = readState();
  if (existing) throw new Error(`Debug logs are already set up for ${existing.username} in ${existing.myDomain}. Remove that first to set up another org or user.`);
  if (!username) throw new Error('No org chosen.');
  const id = await identify(username);
  return {
    org: id.myDomain, orgType: id.orgType, organizationType: id.organizationType, isSandbox: id.isSandbox, production: id.production,
    user: id.username, userName: id.userName, userId: id.userId,
    // short and plain for the developer; the exact records only in the action log
    ...(id.production ? { refused: 'Production org: debug logs are not set up here.' } : {
      summary: ['Adds debug logging for you, for the time you choose', 'Runs a quick check that logs arrive'],
      note: 'Use the same user in the browser. Remove any time.',
    }),
  };
}

// After the developer confirmed. say(line) reports progress.
export async function create({ username, minutes = 30, say = () => {} } = {}) {
  const existing = readState();
  if (existing) throw new Error(`Debug logs are already set up for ${existing.username} in ${existing.myDomain}.`);
  const id = await identify(username); // checked again here: never trust an earlier answer
  if (id.production) throw new Error(`${id.myDomain} is a production org. Debug logs are not set up in production. Nothing was created.`);
  if (![15, 30, 60].includes(Number(minutes))) minutes = 30;
  const name = `${PREFIX}_${new Date().toISOString().replace(/\D/g, '').slice(0, 12)}`;
  const lines = []; // what the developer sees: short
  const step = (t) => { lines.push(t); say(t); };
  // the exact records (ids, levels): action log only, not shown to the user
  const record = (action, details) => logAction('sf-test-bridge (debug logs)', `setup: ${action}`, { org: id.myDomain, ...details }, true, 'ok');
  const created = {};
  const rollback = async (why) => {
    if (created.traceFlagId) await toolingDelete('TraceFlag', created.traceFlagId, id.username, 'rollback').catch(() => {});
    if (created.debugLevelId) await toolingDelete('DebugLevel', created.debugLevelId, id.username, 'rollback').catch(() => {});
    const e = new Error(`${why}. Nothing was left behind.`);
    e.lines = lines;
    throw e;
  };
  let st;
  try {
    const dl = await createDebugLevel(id.username, name);
    created.debugLevelId = dl.id;
    record('debug level created', { id: dl.id, name, levels: dl.levels });
    st = { ...id, debugLevelId: dl.id, debugLevelName: name, levels: dl.levels, setupAt: new Date().toISOString() };
    const tf = await createTraceFlag(st, Number(minutes));
    created.traceFlagId = tf.id;
    record('trace flag created', { id: tf.id, user: id.username, until: tf.expiresAt });
    step('✓ Logging added');
    Object.assign(st, { traceFlagId: tf.id, expiresAt: tf.expiresAt, startedAt: new Date().toISOString() });
  } catch (e) { return rollback(`Setup failed: ${e.message}`); }

  // controlled test
  const code = crypto.randomBytes(4).toString('hex');
  const file = path.join(os.tmpdir(), `sftb-check-${code}.apex`);
  fs.writeFileSync(file, `System.debug('SF Test Bridge setup check ${code}');\n`);
  try {
    const since = Date.now() - 5000;
    await sf(['apex', 'run', '--file', file], { org: id.username, write: false, what: 'controlled test: one System.debug line' });
    let found = null;
    for (let i = 0; i < 10 && !found; i++) {
      for (const l of await listLogs(st, since)) {
        if ((await getLog(st, l.Id)).includes(`SF Test Bridge setup check ${code}`)) { found = l; break; }
      }
      if (!found) await new Promise((r) => setTimeout(r, 2000));
    }
    if (!found) return rollback('The check failed: no log arrived');
    record('check log read back', { id: found.Id });
    step('✓ Check passed');
  } catch (e) { return rollback(`The check failed: ${e.message}`); } finally { fs.rmSync(file, { force: true }); }

  st.testedAt = new Date().toISOString();
  writeState(st);
  step(`On until ${new Date(st.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
  return { ...stateView(st), lines };
}

// The terminal version of the same steps (cli.js debuglog setup).
export async function setup({ ask, say, minutes: fixedMinutes } = {}) {
  say('Debug logs: one-time setup. Nothing is created until you confirm.\n');
  const existing = readState();
  if (existing) throw new Error(`Debug logs are already set up for ${existing.username} in ${existing.myDomain}. Run "debuglog remove" first to set up another org or user.`);
  const orgs = await listOrgs();
  say('Orgs the Salesforce CLI is logged into:');
  orgs.forEach((o, i) => say(`  ${i + 1}. ${o.alias ? `${o.alias}  ` : ''}${o.username}  (${o.host})`));
  const chosen = orgs[Number(await ask(`Which org? Type its number (1-${orgs.length}): `)) - 1];
  if (!chosen) throw new Error('No org chosen. Nothing was created.');
  const p = await plan(chosen.username);
  say(`\n${p.org} (${p.organizationType}), user ${p.userName}`);
  if (p.refused) throw new Error(`${p.refused} Nothing was created.`);
  say(`${p.summary.map((x) => `- ${x}`).join('\n')}\n${p.note}`);
  let minutes = fixedMinutes;
  if (!minutes) {
    const m = String(await ask('How long: 15, 30 or 60 minutes? [30]: ')).trim() || '30';
    minutes = [15, 30, 60].includes(Number(m)) ? Number(m) : 30;
  }
  const yes = String(await ask('Create? (y/N): ')).trim().toLowerCase();
  if (yes !== 'y' && yes !== 'yes') throw new Error('Not confirmed. Nothing was created.');
  const r = await create({ username: chosen.username, minutes, say: (t) => say(`  ${t}`) });
  say('Start, stop or remove them any time in the extension popup.');
  return r;
}

// ---- start / stop / remove ----
export async function start(minutes = 30) {
  const st = readState();
  if (!st) throw new Error('Debug logs are not set up. Only the developer can set them up: node mcp-server/src/cli.js debuglog setup');
  if (![15, 30, 60].includes(Number(minutes))) minutes = 30;
  if (st.traceFlagId) await toolingDelete('TraceFlag', st.traceFlagId, st.username, 'replace the previous trace flag').catch(() => {});
  const tf = await createTraceFlag(st, Number(minutes));
  writeState({ ...st, traceFlagId: tf.id, expiresAt: tf.expiresAt, startedAt: new Date().toISOString() });
  return stateView();
}
export async function stop() {
  const st = readState();
  if (!st) return stateView(null);
  if (st.traceFlagId) await toolingDelete('TraceFlag', st.traceFlagId, st.username, 'stop debug logs').catch((e) => { if (!/not found|INVALID_CROSS_REFERENCE|ENTITY_IS_DELETED|entity is deleted/i.test(e.message)) throw e; });
  // the other users the developer added in a capture: only the trace flags this setup created
  for (const x of st.extraFlags || []) if (x.traceFlagId) await toolingDelete('TraceFlag', x.traceFlagId, st.username, `stop debug logs for ${x.name}`).catch(() => {});
  writeState({ ...st, traceFlagId: null, expiresAt: null, extraFlags: [] });
  return stateView();
}
export async function remove() {
  const st = readState();
  if (!st) return { ...stateView(null), note: 'Nothing to remove: debug logs were not set up.' };
  await stop();
  // only the debug level this setup created, and only if it still carries our name
  const dl = await toolingGet('DebugLevel', st.debugLevelId, st.username).catch(() => null);
  if (dl && String(dl.DeveloperName || '').startsWith(PREFIX)) await toolingDelete('DebugLevel', st.debugLevelId, st.username, 'remove the debug level');
  writeState(null);
  if (LOG_CACHE !== 'off') fs.rmSync(LOG_CACHE, { recursive: true, force: true });
  return { state: 'not set up', removed: { org: st.myDomain, debugLevel: dl ? st.debugLevelId : '(already gone)' }, note: 'Removed. Nothing is left in the org.' };
}

// ---- analysing a check window ----
// Preconditions (spec): logging is on, and the org being tested is the
// configured org. Full logs go to saveDir (the developer's machine);
// the result (masked) goes to Claude.
// Many logs in a window (a busy page can write dozens): list them all (cheap:
// id, time, operation, status, size), then read only the ones that matter:
// every log whose status is not "Success" (Salesforce stores the error
// there), else the few largest near the failing step. The rest are counted.
// Logs are written a few seconds after the request: wait for them briefly.
const MAX_READ = 5;
export function pickLogs(logs, { aroundMs } = {}) {
  const failed = logs.filter((l) => l.Status && l.Status !== 'Success');
  if (failed.length) return { pick: failed.slice(-MAX_READ), why: 'failed' };
  const near = (l) => (aroundMs ? Math.abs(Date.parse(l.StartTime) - aroundMs) : 0);
  const big = logs.filter((l) => (l.LogLength || 0) > 2000).sort((x, y) => near(x) - near(y) || (y.LogLength || 0) - (x.LogLength || 0)).slice(0, 3);
  return { pick: big, why: big.length ? 'largest near the step' : 'none worth reading (all short and successful)' };
}
export async function analyzeWindow({ sinceMs, untilMs, orgHost, projectRoot, saveDir, waitMs = 0, aroundMs } = {}) {
  const { analyzeLog, rootCause } = await import('./apexlog.js');
  const st = readState();
  const view = stateView(st);
  if (view.state !== 'on') return { used: false, note: view.state === 'ready' ? `debug logs not used: logging is off for ${st.myDomain}. The developer can start it in the popup.` : view.note };
  const configured = st.myDomain.replace(/\.my\.salesforce\.com$/, '.lightning.force.com');
  if (orgHost && orgHost !== configured && !SitePolicy.sameOrg(`https://${orgHost}`, st.instanceUrl)) {
    return { used: false, note: `debug logs not used: they are set up for ${st.myDomain}, this check ran in ${orgHost}.` };
  }
  const until = untilMs || Date.now() + 5000;
  let logs = [];
  for (const t0 = Date.now(); ;) {
    logs = (await listLogs(st, sinceMs)).filter((l) => Date.parse(l.StartTime) <= until + waitMs);
    if (logs.length || Date.now() - t0 >= waitMs) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!logs.length) return { used: true, logs: 0, note: `no debug logs for ${st.userName || st.username} in that window. Salesforce writes none for some requests (e.g. a UI save stopped by a validation rule, which the step result already explains).` };
  const { pick, why } = pickLogs(logs, { aroundMs });
  const analyses = [];
  for (const l of pick) {
    const text = await getLog(st, l.Id);
    if (saveDir) { fs.mkdirSync(saveDir, { recursive: true }); fs.writeFileSync(path.join(saveDir, `${l.Id}.log`), text); }
    analyses.push({ id: l.Id, operation: l.Operation, status: l.Status, ...analyzeLog(text, { source: projectRoot }) });
  }
  const failedStatus = logs.filter((l) => l.Status && l.Status !== 'Success');
  return {
    used: true, logs: logs.length, read: pick.length, readWhy: why,
    ...(logs.length > pick.length ? { notRead: `${logs.length - pick.length} other log(s)${failedStatus.length > pick.length ? '' : ', all successful'}` } : {}),
    rootCause: rootCause(analyses) || (failedStatus.length ? `Request failed: ${failedStatus[failedStatus.length - 1].Status}` : null),
    failures: analyses.flatMap((a) => a.failures.map((f) => ({ log: a.id, ...f }))).slice(0, 10),
    debug: analyses.flatMap((a) => a.debug).slice(-30),
    dml: analyses.flatMap((a) => a.dml).slice(-20),
    ...(analyses.some((a) => a.truncated) ? { truncated: 'a log was cut at 20 MB (MAXIMUM DEBUG LOG SIZE REACHED): the developer may lower the noisiest category for the next window' } : {}),
    ...(saveDir && pick.length ? { savedTo: saveDir } : {}),
  };
}

// ---- reading logs (configured user only, a time window) ----
export async function listLogs(st, sinceMs, { allUsers = false } = {}) {
  const since = new Date(sinceMs).toISOString().replace(/\.\d+Z$/, 'Z');
  const who = allUsers ? '' : `LogUserId = '${st.userId}' AND `;
  const r = await readQuery(st.username, `SELECT Id, StartTime, Operation, Status, LogLength, DurationMilliseconds, Request, LogUserId, LogUser.Name FROM ApexLog WHERE ${who}StartTime >= ${since} ORDER BY StartTime ASC LIMIT 200`, { tooling: true, what: `list debug logs of the window (${allUsers ? 'all users' : 'the configured user'})` });
  return (r.records || []).map((l) => ({ ...l, userName: l.LogUser?.Name || null }));
}
// A log never changes once written: keep a local copy, so a second search or
// trace does not download it again (each CLI call takes seconds). Kept until the
// developer clears it: Remove clears it, or delete the folder. Only on the
// developer's machine.
export const LOG_CACHE = process.env.BROWSER_BRIDGE_LOG_CACHE || path.join(STATE_DIR, 'log-cache');
export async function getLog(st, id) {
  const file = path.join(LOG_CACHE, `${String(id).replace(/\W/g, '')}.log`);
  const useCache = LOG_CACHE !== 'off';
  try { if (useCache) return fs.readFileSync(file, 'utf8'); } catch { /* not cached */ }
  let text = '';
  if (D.enabled()) { try { text = await D.logBody(st.username, id); } catch { /* the CLI below */ } }
  if (!text) {
    const r = await sf(['apex', 'get', 'log', '--log-id', id], { org: st.username, what: 'read one debug log' });
    const one = Array.isArray(r) ? r[0] : r;
    text = typeof one === 'string' ? one : one?.log || '';
  }
  cachePut(id, text);
  return text;
}
const cacheFile = (id) => path.join(LOG_CACHE, `${String(id).replace(/\W/g, '')}.log`);
function cachePut(id, text) { if (text && LOG_CACHE !== 'off') { try { fs.mkdirSync(LOG_CACHE, { recursive: true }); fs.writeFileSync(cacheFile(id), text); } catch { /* cache is optional */ } } }
// Many logs: cached ones from disk, the rest direct (6 at a time); what still
// fails comes from the CLI in one batch (sf apex get log --number: the newest
// logs of every user in the org, matched by id), then one by one.
export async function getLogs(st, ids) {
  const out = new Map(); const todo = [];
  for (const id of ids) { try { if (LOG_CACHE !== 'off') { out.set(id, fs.readFileSync(cacheFile(id), 'utf8')); continue; } } catch { /* not cached */ } todo.push(id); }
  const failed = [];
  if (D.enabled()) {
    for (let i = 0; i < todo.length; i += 6) {
      const batch = todo.slice(i, i + 6);
      const got = await Promise.all(batch.map((id) => D.logBody(st.username, id).catch(() => '')));
      batch.forEach((id, k) => { if (got[k]) { out.set(id, got[k]); cachePut(id, got[k]); } else failed.push(id); });
    }
  } else failed.push(...todo);
  if (failed.length > 1) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sftb-logs-'));
    try {
      await sf(['apex', 'get', 'log', '--number', String(Math.min(25, failed.length + 5)), '--output-dir', dir], { org: st.username, what: `read ${failed.length} debug logs in one call` });
      for (const id of failed) { try { const t = fs.readFileSync(path.join(dir, `${id}.log`), 'utf8'); out.set(id, t); cachePut(id, t); } catch { /* not in the batch */ } }
    } catch { /* one by one below */ } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  for (const id of failed) if (!out.has(id)) out.set(id, await getLog(st, id).catch(() => ''));
  return out;
}


// ---- change trace: find the correct log(s), then "what changed and why" ----
// Window: from the action (or from when logging started) up to when the trace
// is asked for. A named record's LastModifiedDate (one date field, read with
// the developer's CLI) pins the save; a regex search of the logs in the window
// (record id, object, data changes, the developer's search terms) picks the
// log(s). Async work (Queueable, flow async paths) has its own log: it is
// chosen too when it touches the record.
const MAX_SCAN = 25;
export async function recordModified(st, object, recordId) {
  if (!/^\w+$/.test(object || '') || !/^[a-zA-Z0-9]{15,18}$/.test(recordId || '')) return null;
  const r = await readQuery(st.username, `SELECT LastModifiedDate FROM ${object} WHERE Id = '${recordId}'`, { what: `last modified time of the traced ${object} record` });
  return r.records?.[0]?.LastModifiedDate || null;
}
export async function traceWindow({ fromMs, toMs, aroundMs, recordId, object, terms, orgHost, projectRoot, saveDir, waitMs = 0 } = {}) {
  const T = await loadTrace();
  const st = readState();
  if (!st) return { used: false, note: stateView(null).note };
  const configured = st.myDomain.replace(/\.my\.salesforce\.com$/, '.lightning.force.com');
  if (orgHost && orgHost !== configured && !SitePolicy.sameOrg(`https://${orgHost}`, st.instanceUrl)) {
    return { used: false, note: `debug logs not used: they are set up for ${st.myDomain}, this check ran in ${orgHost}.` };
  }
  if (recordId && !T.validId(recordId)) throw new Error('recordId must be a 15 or 18 character Salesforce id');
  terms = T.parseTerms(terms);
  object = object || T.objectOf(recordId) || undefined;
  const started = Date.parse(st.startedAt || '') || (st.expiresAt ? Date.parse(st.expiresAt) - 60 * 60_000 : Date.now() - 60 * 60_000);
  // a time range asked for wins (logs from an earlier logging window are still in the org); at most a day back
  const to = toMs || Date.now();
  const from = fromMs != null ? Math.max(fromMs, to - 24 * 60 * 60_000) : started;
  const iso = (ms) => new Date(ms).toISOString();
  const record = recordId ? { object, recordId } : null;
  let modifiedMs = null;
  if (record && object) {
    const lm = await recordModified(st, object, recordId).catch(() => null);
    if (lm) { record.lastModified = lm; modifiedMs = Date.parse(lm); }
    if (modifiedMs && modifiedMs < from - 2000 && !terms.length) {
      return { used: true, record, changed: false, note: `The record was not changed in the window: last modified ${lm}, before ${iso(from)}. If a save failed, Salesforce often writes no log for it; the error on the page is the evidence.` };
    }
  }
  // logs arrive a few seconds after the request: wait for them briefly
  let win;
  for (const t0 = Date.now(); ;) {
    const all = await listLogs(st, from - 2000, { allUsers: true }); // the change may come from any user
    win = T.filterByTime(all, { fromMs: from, toMs: to, modifiedMs });
    if ((modifiedMs ? win.covers.length : win.logs.length) || Date.now() - t0 >= waitMs) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  const window = { from: iso(from), to: iso(to), logs: win.logs.length };
  if (!win.logs.length) return { used: true, record, window, note: 'No debug logs in the window. Salesforce writes none for some requests (e.g. a save stopped by a validation rule): the error on the page is the evidence.' };
  const order = T.scanOrder(win.logs, { covers: win.covers, aroundMs: aroundMs ?? modifiedMs });
  const toScan = order.slice(0, MAX_SCAN);
  const coverIds = win.covers.map((l) => l.Id);
  const texts = new Map(); const scored = [];
  for (let i = 0; i < toScan.length; i += 4) {
    const batch = toScan.slice(i, i + 4);
    const got = await Promise.all(batch.map((l) => getLog(st, l.Id).catch(() => '')));
    batch.forEach((l, k) => { texts.set(l.Id, got[k]); scored.push({ ...l, ...T.scoreLog(got[k], { recordId, object, terms }) }); });
  }
  window.searched = scored.length;
  if (win.logs.length > scored.length) window.skipped = win.logs.length - scored.length;
  const chosen = T.chooseLogs(scored, { recordId, coverIds, terms });
  if (!chosen.length) {
    return { used: true, record, window, ...(terms.length ? { terms } : {}), note: terms.length ? `None of the ${scored.length} logs searched contains ${terms.map((t) => `"${t}"`).join(', ')}.` : recordId ? 'No log in the window changes data or mentions the record.' : 'No log in the window changes data.' };
  }
  return explainLogs(T, chosen, texts, { recordId, terms, projectRoot, saveDir, coverIds, window, record });
}

// What changed and why, from the given logs (in time order): records and fields
// with their writers, the timeline, term lines; trace.md / trace.json and the
// logs saved to saveDir. Shared by the trace and the capture.
function explainLogs(T, chosen, texts, { recordId, terms = [], projectRoot, saveDir, coverIds = [], window, record = null } = {}) {
  const idx = T.sourceIndex(projectRoot);
  const notes = [];
  const logs = []; const steps = []; const records = new Map(); const counts = { soql: 0, dml: 0, debug: 0 }; const termLines = {};
  let stepsTotal = 0; let truncated = false;
  for (const l of chosen) {
    const kind = T.logKind(l.Operation, texts.get(l.Id));
    const why = [...(coverIds.includes(l.Id) ? ['running when the record was saved'] : []), ...l.hits].join(', ');
    logs.push({ Id: l.Id, Operation: l.Operation, kind, StartTime: l.StartTime, Status: l.Status, ...(l.userName ? { user: l.userName } : {}), why });
    const t = T.traceLog(texts.get(l.Id), { recordId, idx });
    steps.push({ depth: 0, time: '', kind: 'log', text: `Log ${l.Id}: ${kind}${l.Status && l.Status !== 'Success' ? `, ${l.Status}` : ''}` }, ...t.steps.map((s) => ({ ...s, depth: s.depth + 1 })));
    // later logs win: a field changed again later (async) shows its last value
    for (const r of t.records) {
      const prev = records.get(r.id.slice(0, 15));
      if (!prev) { records.set(r.id.slice(0, 15), { ...r, fields: r.fields.map((f) => ({ ...f, log: l.Id })) }); continue; }
      for (const f of r.fields) {
        const i = prev.fields.findIndex((x) => x.field === f.field);
        if (i >= 0 && f.unchanged) continue; // a later same-value write must not hide the real change
        // the save log only shows the result; the before-save flow that set it may be logged
        // only in the pre-save check log (seen in a real UI save): keep the writer found there
        if (i >= 0 && !f.source && /^the save itself/.test(f.by) && prev.fields[i].source && prev.fields[i].after === f.after) continue;
        const nf = { ...f, log: l.Id, ...(i >= 0 && prev.fields[i].before !== undefined ? { before: prev.fields[i].before } : {}) };
        if (i >= 0) {
          // keep what the earlier log(s) set, or a change and a change back reads as "A -> A"
          const p = prev.fields[i];
          const earlier = [...(p.earlier || []), ...(p.unchanged || p.after === f.after ? [] : [`${p.after} (${p.by})`]), ...(f.earlier || [])];
          if (earlier.length) nf.earlier = earlier; else delete nf.earlier;
          if (nf.before !== undefined && nf.before === nf.after && earlier.length) nf.note = 'changed, then set back to the value before';
          prev.fields[i] = nf;
        } else prev.fields.push(nf);
      }
      prev.investigated ||= r.investigated;
      if (r.notSaved) prev.notSaved = r.notSaved;
    }
    if (t.failed) notes.push(`${l.Id}: the transaction failed (${t.failed}); its changes were rolled back.`);
    if (t.lowDetail) notes.push(`${l.Id}: ${t.lowDetail}.`);
    const tl = T.termLines(texts.get(l.Id), l.terms || []);
    for (const [term, lines] of Object.entries(tl)) (termLines[term] ||= {})[l.Id] = lines;
    for (const k of Object.keys(counts)) counts[k] += t.counts[k];
    stepsTotal += t.stepsTotal + 1; truncated ||= t.truncated;
  }
  const recs = [...records.values()].sort((a, b) => b.investigated - a.investigated);
  const files = [...new Set(steps.flatMap((s) => [s.source?.file, ...(s.calledBy || []).map((c) => c.file)]).filter(Boolean))];
  if (logs.some((l) => /pre-save check/.test(l.kind))) notes.push('Lightning runs before-save flows once more in a separate pre-save check (DirectSoap log); the save itself is the page request log.');
  if (recordId && !recs.some((r) => r.investigated)) notes.push('No field change of the record you asked about was found in the chosen logs.');
  if (!idx.root) notes.push('No local project found: source files and lines are not shown.');
  const trace = { window, record, ...(terms.length ? { terms } : {}), logs, records: recs, termLines, steps, stepsTotal, counts, files, truncated, notes };
  let saved = {};
  if (saveDir) {
    fs.mkdirSync(saveDir, { recursive: true });
    for (const l of chosen) fs.writeFileSync(path.join(saveDir, `${l.Id}.log`), texts.get(l.Id));
    fs.writeFileSync(path.join(saveDir, 'trace.md'), T.renderTrace(trace));
    fs.writeFileSync(path.join(saveDir, 'trace.json'), JSON.stringify(trace, null, 1));
    saved = { traceMd: path.join(saveDir, 'trace.md'), traceJson: path.join(saveDir, 'trace.json') };
  }
  return {
    used: true, record, window, ...(terms.length ? { terms } : {}),
    logs: logs.map((l) => `${l.Id} ${l.kind} ${l.StartTime}`),
    changes: recs.flatMap((r) => r.fields.filter((c) => !c.unchanged).map((c) => T.changeLine(r, c))).slice(0, 25),
    // fields written with the value they already had (a save that changed nothing still runs the automation)
    sameValue: recs.flatMap((r) => r.fields.filter((c) => c.unchanged).map((c) => `${r.object || "record"} ${c.field}`)).slice(0, 10),
    errors: steps.filter((s) => s.kind === 'error').map((s) => `${s.text}${s.source?.file ? ` (${s.source.file}${s.source.line ? `:${s.source.line}` : ''})` : ''}`).slice(0, 5),
    ...(Object.keys(termLines).length ? { found: Object.fromEntries(Object.entries(termLines).map(([t, byLog]) => [t, Object.entries(byLog).map(([id, ls]) => `${id}: ${ls[0]}`)])) } : {}),
    files, notes, ...saved,
  };
}

// ---- the developer's own search (popup "Find in logs") ----
// Comma-separated terms (a record id, a value, an API name, a flow / element
// or class name...) over the logs of the last N minutes. The result (trace.md /
// trace.json) is saved and remembered, so Claude can read what the developer found.
export const LAST_SEARCH_FILE = path.join(STATE_DIR, 'debuglog-last-search.json');
export async function searchLogs({ terms, minutes = 30, projectRoot } = {}) {
  const { parseTerms } = await loadTrace();
  const list = parseTerms(terms);
  if (!list.length) throw new Error('Type one or more words to look for, separated by commas.');
  const { EVIDENCE_ROOT } = await import('./evidence.js');
  const saveDir = path.join(EVIDENCE_ROOT, 'debug-logs', `${new Date().toISOString().replace(/[:.]/g, '-')}_search`);
  const m = Math.min(60, Math.max(5, Number(minutes) || 30));
  const r = await traceWindow({ fromMs: Date.now() - m * 60_000, toMs: Date.now(), terms: list, projectRoot, saveDir });
  const out = {
    at: new Date().toISOString(), terms: list, minutes: m,
    logsInWindow: r.window?.logs ?? 0, searched: r.window?.searched ?? 0, matched: r.logs?.length || 0,
    logs: r.logs || [], found: r.found || {}, changes: (r.changes || []).slice(0, 10), errors: r.errors || [],
    ...(r.note ? { note: r.note } : {}), ...(r.traceMd ? { traceMd: r.traceMd, traceJson: r.traceJson } : {}),
  };
  try { fs.writeFileSync(LAST_SEARCH_FILE, JSON.stringify(out, null, 1)); } catch { /* state dir missing */ }
  return out;
}
export function lastSearch() {
  try { return JSON.parse(fs.readFileSync(LAST_SEARCH_FILE, 'utf8')); } catch { return null; }
}

// ---- capture my action (popup) ----
// The developer presses Capture, names the record and what should change, then
// does the action (or waits for the API call, the scheduled flow...). Logs of
// every user from that moment are listed with hints; the developer ticks the
// right ones (or downloads them) and sends them to Claude. The record itself is
// watched too: when it changed but no log has it, the user who changed it has
// no logging, and the developer can add logging for that user.
export const CAPTURE_FILE = process.env.BROWSER_BRIDGE_CAPTURE_STATE || path.join(STATE_DIR, 'debuglog-capture.json');
export function readCapture() { try { return JSON.parse(fs.readFileSync(CAPTURE_FILE, 'utf8')); } catch { return null; } }
function writeCapture(c) { fs.mkdirSync(path.dirname(CAPTURE_FILE), { recursive: true }); fs.writeFileSync(CAPTURE_FILE, JSON.stringify(c, null, 1)); return c; }
const CAPTURE_SCAN = 25;
// the developer's own clock (the hub runs on their machine), like the popup
const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');

// object of an id: the standard prefixes, else the org's own (custom objects)
async function objectFor(st, T, recordId) {
  const known = T.objectOf(recordId);
  if (known) return known;
  const r = await readQuery(st.username, `SELECT QualifiedApiName FROM EntityDefinition WHERE KeyPrefix = '${String(recordId).slice(0, 3).replace(/\W/g, '')}'`, { what: 'object of the captured record id' }).catch(() => null);
  return r?.records?.[0]?.QualifiedApiName || null;
}
// when the record was last changed, and by whom (one record, three fields)
async function recordInfo(st, object, recordId) {
  if (!/^\w+$/.test(object || '') || !/^[a-zA-Z0-9]{15,18}$/.test(recordId || '')) return null;
  const r = await readQuery(st.username, `SELECT LastModifiedDate, LastModifiedById, LastModifiedBy.Name FROM ${object} WHERE Id = '${recordId}'`, { what: `last change of the captured ${object} record` }).catch(() => null);
  const x = r?.records?.[0];
  return x ? { at: x.LastModifiedDate, byId: x.LastModifiedById, by: x.LastModifiedBy?.Name || null } : null;
}
// the org's Automated Process user (platform-event flows run as it), looked up once
async function automatedProcess(st) {
  if (st.automatedProcessId) return { Id: st.automatedProcessId };
  const r = await readQuery(st.username, "SELECT Id FROM User WHERE UserType = 'AutomatedProcess' AND Name = 'Automated Process' LIMIT 1", { what: 'the Automated Process user' }).catch(() => null);
  const x = r?.records?.[0];
  if (x) writeState({ ...readState(), automatedProcessId: x.Id });
  return x || null;
}
// Logging for another user (an API / integration user, the user a scheduled flow
// runs as), asked for by the developer: a trace flag with this setup's debug
// level, ending with the developer's own logging. Removed by Stop / Remove.
export async function addUser({ user } = {}) {
  const st = readState();
  if (!st) throw new Error('Debug logs are not set up.');
  if (stateView(st).state !== 'on') throw new Error('Start debug logs first.');
  const u = String(user || '').trim();
  const by = /^005[a-zA-Z0-9]{12}([a-zA-Z0-9]{3})?$/.test(u) ? `Id = '${u}'` : /^[\w.+-]+@[\w.-]+$/.test(u) ? `Username = '${u}'` : null;
  if (!by) throw new Error('Give a user id (005...) or a username.');
  const q = await readQuery(st.username, `SELECT Id, Name, Username, IsActive FROM User WHERE ${by} LIMIT 1`, { what: 'user to add logging for' });
  const x = q.records?.[0];
  if (!x) throw new Error('No such user in this org.');
  if (x.Id.slice(0, 15) === String(st.userId).slice(0, 15)) return { user: x.Name, note: 'That is you: already logged.' };
  const extra = st.extraFlags || [];
  if (extra.some((e) => e.userId === x.Id && Date.parse(e.expiresAt) > Date.now())) return { user: x.Name, note: `Already logging ${x.Name}.` };
  try {
    const r = await tooling('TraceFlag', `TracedEntityId=${x.Id} DebugLevelId=${st.debugLevelId} LogType=USER_DEBUG StartDate=${new Date(Date.now() - 60_000).toISOString()} ExpirationDate=${st.expiresAt}`, st.username, `start debug logs for another user (${x.Name})`);
    writeState({ ...st, extraFlags: [...extra.filter((e) => e.userId !== x.Id), { userId: x.Id, name: x.Name, traceFlagId: r.id, expiresAt: st.expiresAt }] });
    return { user: x.Name, note: `Now logging ${x.Name} too, until your logging ends.` };
  } catch (e) {
    // someone else already logs this user: their logs are written anyway
    if (/already|more than one|DUPLICATE/i.test(e.message)) return { user: x.Name, note: `${x.Name} already has logging on (set by someone else).` };
    throw e;
  }
}

// One shared capture (the popup and Claude): Start marks the time (the popup also
// turns logging on; Claude never does), Stop is optional. Every search and every
// question from Claude adds a time mark, with who made it. The window's logs (all
// users) are downloaded once and kept; search is a text search over them: it
// highlights and never hides. Order: has the record, has an error, changes data;
// the rest folded. The full "what changed and why" only on Explain / Send.
const mark = (c, kind, by, extra = {}) => { c.marks = [...(c.marks || []), { at: new Date().toISOString(), kind, by, ...extra }]; };
const idTerms = (T, terms) => terms.filter((t) => T.validId(t) && /\d/.test(t) && /[a-zA-Z]/.test(t));
const ERR_LINE = /\|(FATAL_ERROR|EXCEPTION_THROWN|FLOW_ELEMENT_ERROR|VALIDATION_FAIL)\|([^\r\n]*)/;
function firstError(text) {
  const m = ERR_LINE.exec(text);
  if (!m) return null;
  const line = /^\[(\d+)\]\|/.exec(m[2])?.[1];
  const body = m[2].replace(/^\[\d+\]\|/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return mask(`${m[1] === 'VALIDATION_FAIL' ? 'Validation rule failed' : body}${line ? ` (line ${line})` : ''}`).slice(0, 220);
}
// light hints from the text alone (no full analysis): fast
function hintOf(T, l, text, terms) {
  const ids = idTerms(T, terms);
  const errorText = firstError(text) || (l.Status && l.Status !== 'Success' ? l.Status : null);
  return {
    id: l.Id, at: l.StartTime, user: l.userName, op: l.Operation, kind: T.logKind(l.Operation, text), status: l.Status, size: l.LogLength,
    record: ids.some((id) => text.includes(id.slice(0, 15))), error: !!errorText, ...(errorText ? { errorText } : {}),
    changes: T.scoreLog(text, {}).changes,
    matches: Object.fromEntries(Object.entries(T.termLines(text, terms, 2)).map(([t, ls]) => [t, ls.map((x) => x.replace(/^\d\d:\d\d:\d\d /, ''))])),
  };
}
const group = (h) => (h.record ? 0 : h.error ? 1 : h.changes ? 2 : 3);
function order(logs) {
  return [...logs].sort((a, b) => group(a) - group(b) || Object.keys(b.matches || {}).length - Object.keys(a.matches || {}).length || Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id))
    .map((h) => ({ ...h, folded: group(h) === 3 && !Object.keys(h.matches || {}).length }));
}

export async function captureStart({ by = 'popup', recordId, terms, minutes = 30, projectRoot } = {}) {
  const T = await loadTrace();
  const st = readState();
  if (!st) throw new Error('Debug logs are not set up.');
  const view = stateView(st);
  if (view.state !== 'on') {
    // Claude never turns logging on: the developer does, in the popup
    if (by !== 'popup') return { status: 'none', note: 'Debug logs are off. Start them in the extension popup (Debug logs > Start); Claude cannot turn logging on. Then start the capture.' };
    await start(minutes);
  } else if (by === 'popup' && view.minutesLeft < 10) await start(minutes);
  const list = T.parseTerms([recordId, ...[].concat(terms ?? [])].filter(Boolean).join(','));
  const c = { at: new Date().toISOString(), status: 'capturing', terms: list, marks: [], logs: [], baseline: {}, projectRoot: projectRoot || null };
  mark(c, 'start', by);
  await watchIds(st, T, c);
  writeCapture(c);
  return captureView(c);
}
// the record ids among the terms: when each was last changed (the baseline)
async function watchIds(st, T, c) {
  for (const id of idTerms(T, c.terms).slice(0, 3)) {
    if (c.baseline[id] !== undefined) continue;
    const object = await objectFor(st, T, id);
    c.baseline[id] = object ? { object, ...(await recordInfo(st, object, id)) } : null;
  }
}

// Download the window's logs not downloaded yet (all users; cached), and the hints.
async function sync(st, T, c) {
  const until = c.stoppedAt ? Date.parse(c.stoppedAt) + 5000 : Date.now();
  const all = (await listLogs(st, Date.parse(c.at) - 3000, { allUsers: true })).filter((l) => Date.parse(l.StartTime) <= until);
  const recent = all.slice(-CAPTURE_SCAN);
  const texts = await getLogs(st, recent.map((l) => l.Id));
  c.logs = recent.map((l) => hintOf(T, l, texts.get(l.Id) || '', c.terms));
  c.total = all.length; c.notDownloaded = all.length - recent.length;
  c.syncedAt = new Date().toISOString();
  await watchIds(st, T, c);
  await sayAbout(st, c);
}
// re-read the hints for new terms from the downloaded logs only (instant)
async function rehint(st, T, c) {
  const texts = await getLogs(st, c.logs.map((h) => h.id)); // all cached: no network
  c.logs = c.logs.map((h) => hintOf(T, { Id: h.id, StartTime: h.at, userName: h.user, Operation: h.op, Status: h.status, LogLength: h.size }, texts.get(h.id) || '', c.terms));
}
// What to tell the developer: counts, and the record watch (a change with no log).
async function sayAbout(st, c) {
  const logs = c.logs;
  const n = (f) => logs.filter(f).length;
  const found = logs.length
    ? `${c.total} log(s)${c.notDownloaded ? ` (the ${CAPTURE_SCAN} newest downloaded)` : ''}: ${n((h) => h.record)} with the record, ${n((h) => h.error)} with an error, ${n((h) => h.changes)} change data.`
    : '';
  c.addUser = null;
  const [id, base] = Object.entries(c.baseline || {}).find(([, b]) => b?.object) || [];
  const now = id ? await recordInfo(st, base.object, id) : null;
  const changed = !!now && (!base.at || Date.parse(now.at) > Date.parse(base.at));
  c.record = now ? { id, object: base.object, ...now, changed } : null;
  const logged = new Set([st.userId, ...(st.extraFlags || []).filter((e) => Date.parse(e.expiresAt) > Date.now()).map((e) => e.userId)].map((x) => String(x).slice(0, 15)));
  const byUnlogged = changed && !!now.byId && !logged.has(String(now.byId).slice(0, 15));
  const lastWithRecord = Math.max(0, ...logs.filter((h) => h.record).map((h) => Date.parse(h.at)));
  const latestUnlogged = changed && Date.parse(now.at) > lastWithRecord + 5000;
  const stale = latestUnlogged && !byUnlogged && Date.now() - Date.parse(now.at) > 45_000;
  const ap = stale ? await automatedProcess(st) : null;
  const pre = found ? `${found} ` : '';
  let say;
  if (latestUnlogged && byUnlogged) { say = `${pre}The record changed at ${hhmm(now.at)} by ${now.by}, and no log has it: ${now.by} has no logging. Add logging for ${now.by}, then run it again.`; c.addUser = { id: now.byId, name: now.by }; }
  else if (stale && ap && !logged.has(ap.Id.slice(0, 15))) { say = `${pre}No log came for the change at ${hhmm(now.at)}. Platform-event flows and some other background work are logged under the Automated Process user, even when the record shows ${now.by}. Add logging for Automated Process, then run it again.`; c.addUser = { id: ap.Id, name: 'Automated Process' }; }
  else if (stale) say = `${pre}No log came for the change at ${hhmm(now.at)}, although its user is logged. Salesforce writes a log only when automation runs (Apex, a flow, a validation or workflow rule): this change ran none.`;
  else if (latestUnlogged) say = `${pre}The record changed at ${hhmm(now.at)}; its log has not arrived yet. Check again in a few seconds.`;
  else if (id && !changed && !logs.some((h) => h.record) && Date.now() - Date.parse(c.at) > 60_000) say = `${pre}No log has the record, and it has not changed. If the change was refused (for example by a validation rule), Salesforce writes no log: the error the user or the calling system got is the evidence.`;
  else if (!found && Date.now() - Date.parse(c.at) > 60_000) say = `No log yet. Salesforce writes a log only when automation runs (Apex, a flow, a validation or workflow rule); a change without automation leaves none.${id ? '' : ' Add the record id so the capture can watch the record itself.'}`;
  else say = found || 'No logs yet. Do the action now; logs arrive a few seconds after it.';
  c.say = say;
}

// Catch up: new logs since the last look (popup open, Check, Claude asking).
export async function captureCheck({ by = 'popup', projectRoot } = {}) {
  const T = await loadTrace();
  const c = readCapture();
  if (!c || c.status === 'ended') return { status: 'none' };
  const st = readState();
  if (!st) throw new Error('Debug logs are not set up.');
  if (by === 'claude') mark(c, 'ask', by);
  if (projectRoot) c.projectRoot = projectRoot;
  await sync(st, T, c);
  writeCapture(c);
  return captureView(c);
}
// Search: new terms (record ids, values, names...), any time. Instant over the
// downloaded logs; sync: true also fetches the logs that arrived since.
export async function captureSearch({ terms, by = 'popup', sync: fetchNew = false } = {}) {
  const T = await loadTrace();
  const c = readCapture();
  if (!c || c.status === 'ended') return { status: 'none' };
  const st = readState();
  if (!st) throw new Error('Debug logs are not set up.');
  if (terms !== undefined) {
    const list = T.parseTerms(terms);
    if (list.join('\n') !== (c.terms || []).join('\n')) { c.terms = list; mark(c, 'search', by, { terms: list }); }
  }
  if (fetchNew || !c.syncedAt) await sync(st, T, c);
  else { await rehint(st, T, c); if (idTerms(T, c.terms).some((id) => c.baseline?.[id] === undefined)) { await watchIds(st, T, c); await sayAbout(st, c); } }
  writeCapture(c);
  return captureView(c);
}
export async function captureStop({ by = 'popup' } = {}) {
  const T = await loadTrace();
  const c = readCapture();
  if (!c || c.status === 'ended') return { status: 'none' };
  if (c.status === 'stopped') return captureView(c);
  const st = readState();
  c.status = 'stopped'; c.stoppedAt = new Date().toISOString();
  mark(c, 'stop', by);
  await sync(st, T, c);
  writeCapture(c);
  return captureView(c);
}
// The full "what changed and why" of one log (popup Explain, Claude).
export async function captureExplain({ id, projectRoot } = {}) {
  const T = await loadTrace();
  const c = readCapture();
  const h = c?.logs?.find((x) => x.id === id);
  if (!h) throw new Error('Not a log of this capture.');
  const text = await getLog(readState(), id);
  const t = T.traceLog(text, { recordId: idTerms(T, c.terms)[0], idx: T.sourceIndex(projectRoot || c.projectRoot) });
  const recs = [...t.records.filter((r) => r.investigated), ...t.records.filter((r) => !r.investigated)];
  return {
    id, kind: h.kind, user: h.user, at: h.at,
    changes: recs.flatMap((r) => r.fields.filter((f) => !f.unchanged).map((f) => T.changeLine(r, f))).slice(0, 15),
    sameValue: recs.flatMap((r) => r.fields.filter((f) => f.unchanged).map((f) => `${r.object || 'record'} ${f.field}`)).slice(0, 5),
    errors: t.steps.filter((s) => s.kind === 'error').map((s) => `${s.text}${s.source?.file ? ` (${s.source.file}${s.source.line ? `:${s.source.line}` : ''})` : ''}`).slice(0, 5),
    ...(t.failed ? { notSaved: `the transaction failed (${t.failed}); its changes were rolled back` } : {}),
    ...(t.lowDetail ? { note: t.lowDetail } : {}),
  };
}

// Send to Claude: the ticked logs explained, every log of the window, an index
// with the time marks; an agent reads the trace first and can open any log.
export async function captureSend({ ids = [], by = 'popup', projectRoot } = {}) {
  const T = await loadTrace();
  const c = readCapture();
  if (!c?.logs?.length) throw new Error('No captured logs yet.');
  const want = new Set((Array.isArray(ids) ? ids : String(ids).split(',')).map((x) => String(x).trim()));
  const pick = c.logs.filter((h) => want.has(h.id)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
  if (!pick.length) throw new Error('Tick at least one log.');
  mark(c, 'ask', by, { logs: pick.length });
  const st = readState();
  const texts = await getLogs(st, c.logs.map((h) => h.id));
  const { EVIDENCE_ROOT } = await import('./evidence.js');
  const saveDir = path.join(EVIDENCE_ROOT, 'debug-logs', `${new Date().toISOString().replace(/[:.]/g, '-')}_capture`);
  const ids0 = idTerms(T, c.terms);
  const chosen = pick.map((h) => ({ Id: h.id, Operation: h.op, StartTime: h.at, Status: h.status, userName: h.user, hits: [...(h.record ? ['has the record'] : []), ...(h.error ? ['has an error'] : []), ...(h.changes ? ['changes data'] : [])], terms: Object.keys(h.matches || {}) }));
  const window = { from: c.at, to: c.stoppedAt || new Date().toISOString(), logs: c.total ?? c.logs.length, searched: c.logs.length };
  const record = ids0[0] ? { object: c.baseline?.[ids0[0]]?.object, recordId: ids0[0], ...(c.record?.at ? { lastModified: c.record.at } : {}) } : null;
  const r = explainLogs(T, chosen, texts, { recordId: ids0[0], terms: c.terms, projectRoot: projectRoot || c.projectRoot, saveDir, window, record });
  const allDir = path.join(saveDir, 'all');
  fs.mkdirSync(allDir, { recursive: true });
  const cell = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\r?\n/g, ' ');
  const rows = [];
  for (const h of [...c.logs].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const t = texts.get(h.id);
    if (t) fs.writeFileSync(path.join(allDir, `${h.id}.log`), t);
    const flags = [h.record && 'has the record', h.error && `error: ${h.errorText}`, h.changes && 'changes data', ...Object.keys(h.matches || {}).map((x) => `"${x}"`)].filter(Boolean).join(', ');
    rows.push(`| ${pick.some((x) => x.id === h.id) ? 'yes' : ''} | ${h.at} | ${cell(h.kind)} | ${cell(h.user)} | ${cell(flags || '-')} | all/${h.id}.log |`);
  }
  const index = path.join(saveDir, 'logs.md');
  fs.writeFileSync(index, [
    '# Captured logs', '',
    `- Window: ${c.at} to ${c.stoppedAt || `${new Date().toISOString()} (still capturing)`}`,
    ...(c.terms.length ? [`- Search words: ${c.terms.join(', ')}`] : []),
    ...(c.record ? [`- Record ${c.record.object} ${c.record.id}: last changed ${c.record.at} by ${c.record.by}`] : []),
    `- Logs: ${c.total ?? c.logs.length}${c.notDownloaded ? ` (the ${CAPTURE_SCAN} newest downloaded)` : ''}; ticked by the developer: ${pick.length}; their trace: trace.md`,
    ...(c.say ? [`- Popup said: ${c.say}`] : []), '',
    '## Time marks', '', ...(c.marks || []).map((m) => `- ${m.at} ${m.kind} (by ${m.by === 'claude' ? 'Claude' : 'the developer'})${m.terms ? `: ${m.terms.join(', ')}` : ''}`), '',
    '## Logs', '', '| Ticked | Time | Kind | User | Hints | File |', '|---|---|---|---|---|---|', ...rows, '',
  ].join('\n'));
  Object.assign(c, { sentAt: new Date().toISOString(), selected: pick.map((h) => h.id), result: { changes: r.changes, sameValue: r.sameValue, errors: r.errors, notes: r.notes, traceMd: r.traceMd, traceJson: r.traceJson, allLogs: index, folder: saveDir } });
  writeCapture(c);
  return captureView(c);
}
export const captureSelect = captureSend; // earlier name

// One captured log's text, for the popup's Download.
export async function captureLog({ id } = {}) {
  const c = readCapture();
  if (!c?.logs?.some((h) => h.id === id)) throw new Error('Not a log of this capture.');
  return { id, file: `${id}.log`, text: await getLog(readState(), id) };
}
export function captureEnd() {
  const c = readCapture();
  if (c && c.status !== 'ended') writeCapture({ ...c, status: 'ended', endedAt: new Date().toISOString() });
  return { status: 'none' };
}
// what the popup and Claude see: ordered, the rest folded (no log text, no local project path)
export function captureView(c = readCapture()) {
  if (!c || c.status === 'ended') return { status: 'none' };
  const { projectRoot: _p, logs = [], ...v } = c;
  const by = (k) => [...(c.marks || [])].reverse().find((m) => m.kind === k)?.by;
  return { ...v, startedBy: by('start'), ...(c.stoppedAt ? { stoppedBy: by('stop') } : {}), logs: order(logs) };
}
