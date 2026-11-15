#!/usr/bin/env node
// The shared capture (debuglog.capture*: the popup and Claude) checked against
// REAL logs from a dev org (tests/fixtures/real-trace): a REST update, an
// autolaunched flow called through REST, a scheduled flow that ran as another
// user, a Batch finish that failed. The fake CLI serves the logs and answers who
// last changed the record; marks, search, order, messages and traces see real data.
//   node tests/capture.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cbb-capture-'));
process.env.BROWSER_BRIDGE_DIRECT = 'off'; // the fake CLI has no session for direct reads
process.env.BROWSER_BRIDGE_SF_BIN = fileURLToPath(new URL('./fixtures/fake-sf.mjs', import.meta.url));
process.env.FAKE_SF_STATE = path.join(tmp, 'fake.json');
process.env.BROWSER_BRIDGE_DEBUGLOG_STATE = path.join(tmp, 'debuglog.json');
process.env.BROWSER_BRIDGE_CAPTURE_STATE = path.join(tmp, 'capture.json');
process.env.BROWSER_BRIDGE_ACTION_LOG = path.join(tmp, 'actions.jsonl');
process.env.BROWSER_BRIDGE_LOG_CACHE = path.join(tmp, 'log-cache');
process.env.BROWSER_BRIDGE_EVIDENCE_DIR = path.join(tmp, 'evidence');
const dl = await import('../mcp-server/src/debuglog.js');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const FIX = fileURLToPath(new URL('./fixtures/real-trace/', import.meta.url));
const PROJECT = path.join(FIX, 'project');
const list = JSON.parse(fs.readFileSync(path.join(FIX, 'loglist.json'), 'utf8'));
const text = (id) => fs.readFileSync(path.join(FIX, 'logs', `${id}.log`), 'utf8');
const ACC = '001jV00000L8HHJQA3';
const DEV = '005000000000001AAA'; const AUTO = '005000000000002AAA'; const APU = '005000000000003AAA'; const GUEST = '005000000000004AAA'; const GONE = '005000000000005AAA';
const PRE = '07LjV000003Oza5UAC'; const SAVE = '07LjV000003Oza6UAC'; const ASYNC = '07LjV000003OyKgUAK';
const FLOW = '07LjV000003OzbhUAC'; const NOISE = '07LjV000003OzdJUAS'; const SCHED = '07LjV000003P0W9UAK'; const BATCH_ERR = '07LjV000003P1TpUAK';

const fake = () => JSON.parse(fs.readFileSync(process.env.FAKE_SF_STATE, 'utf8'));
const setFake = (ids, extra = {}) => fs.writeFileSync(process.env.FAKE_SF_STATE, JSON.stringify({
  records: fs.existsSync(process.env.FAKE_SF_STATE) ? fake().records : {}, calls: fs.existsSync(process.env.FAKE_SF_STATE) ? fake().calls : [], seq: fs.existsSync(process.env.FAKE_SF_STATE) ? fake().seq : 0,
  users: [
    { Id: AUTO, Name: 'Automation User', Username: 'automation.user@example.com', IsActive: true, UserType: 'Standard', Profile: { Name: 'Minimum Access - API Only Integrations', UserLicense: { Name: 'Salesforce Integration' } } },
    { Id: DEV, Name: 'Dev User', Username: 'dev@acme.test', IsActive: true, UserType: 'Standard', Profile: { Name: 'System Administrator', UserLicense: { Name: 'Salesforce' } } },
    { Id: APU, Name: 'Automated Process', Username: 'autoproc@example', IsActive: true, UserType: 'AutomatedProcess', Profile: null },
    { Id: GUEST, Name: 'Site Guest User', Username: 'guest@site.example', IsActive: true, UserType: 'Guest', Profile: { Name: 'Site Profile', UserLicense: { Name: 'Guest User License' } } },
    { Id: GONE, Name: 'Old Integration', Username: 'old_int@example.com', IsActive: false, UserType: 'Standard', Profile: { Name: 'API Only', UserLicense: { Name: 'Salesforce Integration' } } },
  ],
  logs: list.filter((l) => ids.includes(l.Id)).map((l) => ({ id: l.Id, start: l.StartTime.replace('+0000', 'Z'), operation: l.Operation, status: l.Status, duration: l.DurationMilliseconds, text: text(l.Id), ...(l.Id === SCHED ? { user: 'Automation User', userId: AUTO } : {}) })),
  ...extra,
}));
const state = (extra = {}) => fs.writeFileSync(process.env.BROWSER_BRIDGE_DEBUGLOG_STATE, JSON.stringify({ username: 'dev@acme.test', userId: DEV, myDomain: 'acme--dev.sandbox.my.salesforce.com', instanceUrl: 'https://acme--dev.sandbox.my.salesforce.com', debugLevelId: '7dl000000000001', traceFlagId: null, expiresAt: null, ...extra }));
const listCalls = () => (fs.existsSync(process.env.BROWSER_BRIDGE_ACTION_LOG) ? fs.readFileSync(process.env.BROWSER_BRIDGE_ACTION_LOG, 'utf8').split('\n').filter((l) => /list debug logs/.test(l)).length : 0);
const traceFlags = () => fake().calls.filter((c) => /--sobject TraceFlag/.test(c) && /data create/.test(c));

// ---- Claude never turns logging on ----
state();
setFake([], { modified: { [ACC]: { at: '2026-11-15T06:48:10.000Z', byId: AUTO, by: 'Automation User' } } });
let v = await dl.captureStart({ by: 'claude', recordId: ACC });
ok(v.status === 'none' && /extension popup/.test(v.note) && /cannot turn logging on/.test(v.note), 'Claude\'s start with logging off: says to start it in the popup');
ok(!traceFlags().length && dl.stateView().state === 'ready' && dl.captureView().status === 'none', 'and creates nothing in the org, no capture');

// ---- the popup starts: logging on, the record watched ----
v = await dl.captureStart({ by: 'popup', recordId: ACC, projectRoot: PROJECT });
ok(v.status === 'capturing' && v.startedBy === 'popup' && v.terms.includes(ACC) && v.baseline[ACC].object === 'Account', 'popup start: the record id is a search word and watched');
ok(dl.stateView().state === 'on' && traceFlags().length === 1, 'popup start: logging was off, so it was started');
v = await dl.captureCheck();
ok(!v.logs.length && /No logs yet/.test(v.say), 'no logs yet: "do the action now"');

// ---- logs arrive: every one listed, ordered, the rest folded ----
setFake([PRE, SAVE, ASYNC, FLOW, NOISE, BATCH_ERR], { modified: { [ACC]: { at: '2026-11-15T06:55:46.000Z', byId: DEV, by: 'Dev User' } } });
v = await dl.captureCheck();
const h = (id) => v.logs.find((x) => x.id === id);
ok(v.logs.length === 6, 'every log of the window is listed (none hidden)');
const g = v.logs.map((x) => (x.record ? 'R' : x.error ? 'E' : x.changes ? 'C' : '-')).join('');
ok(/^R+E+C*-*$/.test(g), `order: has the record, has an error, changes data, the rest (${g})`);
ok(h(NOISE).folded && !h(SAVE).folded, 'a log with nothing is folded away');
ok(h(BATCH_ERR).error && /Too many future calls/.test(h(BATCH_ERR).errorText) && /line 13/.test(h(BATCH_ERR).errorText), `the error and its line, without a full analysis (${h(BATCH_ERR).errorText})`);
ok(/^API call: runs flow \w*Bridge_Trace_Autolaunched$/.test(h(FLOW).kind) && h(FLOW).user === 'Dev User', 'each log named, with its user');
ok(/6 log\(s\): \d+ with the record, 1 with an error/.test(v.say), `counts said (${v.say})`);

// ---- search: instant over the downloaded logs, highlights, never hides ----
const before = listCalls();
v = await dl.captureSearch({ by: 'popup', terms: `${ACC}, Set by autolaunched flow` });
ok(listCalls() === before, 'a search does not go to the org (instant)');
ok(v.logs.length === 6 && v.logs.find((x) => x.id === FLOW).matches['Set by autolaunched flow']?.length, 'the word is found and shown where; no log hidden');
ok(v.logs.findIndex((x) => x.id === FLOW) < v.logs.findIndex((x) => x.id === PRE), 'within a group, logs with the words come first');
ok(v.marks.some((m) => m.kind === 'search' && m.by === 'popup' && m.terms.includes('Set by autolaunched flow')), 'the search is a time mark, by the popup');

// ---- Claude searches and stops the popup's capture ----
v = await dl.captureSearch({ by: 'claude', terms: 'Rating, Cold', sync: true });
ok(v.marks.some((m) => m.kind === 'search' && m.by === 'claude') && v.logs.find((x) => x.id === SAVE).matches.Cold, 'Claude searches the popup\'s capture (marked by Claude)');
v = await dl.captureStop({ by: 'claude' });
ok(v.status === 'stopped' && v.stoppedBy === 'claude' && v.startedBy === 'popup', 'Claude stops it: started by the popup, stopped by Claude');
// the window ends at Stop: logs after it are not part of the capture
fs.writeFileSync(process.env.BROWSER_BRIDGE_CAPTURE_STATE, JSON.stringify({ ...dl.readCapture(), stoppedAt: '2026-11-15T06:55:39.000Z' }));
v = await dl.captureCheck();
ok(v.logs.length && !v.logs.some((x) => Date.parse(x.at) > Date.parse('2026-11-15T06:55:44Z')), 'after Stop, later logs are outside the window');

// ---- the other way round: Claude starts (logging on), the popup stops ----
dl.captureEnd();
v = await dl.captureStart({ by: 'claude', terms: 'Set by scheduled flow' });
ok(v.status === 'capturing' && v.startedBy === 'claude' && traceFlags().length === 1, 'Claude starts a capture while logging is on: no org change');
v = await dl.captureStop({ by: 'popup' });
ok(v.stoppedBy === 'popup' && v.startedBy === 'claude', 'the popup stops Claude\'s capture');
dl.captureEnd();

// ---- the record watch: a change with no log, by a user without logging ----
setFake([PRE, SAVE, ASYNC, FLOW, NOISE], { modified: { [ACC]: { at: '2026-11-15T06:48:10.000Z', byId: AUTO, by: 'Automation User' } } });
await dl.captureStart({ by: 'popup', recordId: ACC, projectRoot: PROJECT });
setFake([PRE, SAVE, ASYNC, FLOW, NOISE], { modified: { [ACC]: { at: '2026-11-15T06:59:03.000Z', byId: AUTO, by: 'Automation User' } } });
v = await dl.captureCheck();
ok(/by Automation User, and no log has it: Automation User has no logging/.test(v.say) && v.addUser?.id === AUTO, `the unlogged change is said, with the user to add (${v.say})`);
ok(/Now logging Automation User/.test((await dl.addUser({ user: AUTO })).note) && dl.stateView().alsoLogging.includes('Automation User'), 'logging added for that user (popup button)');
ok(/Already logging/.test((await dl.addUser({ user: 'automation.user@example.com' })).note) && /That is you/.test((await dl.addUser({ user: DEV })).note), 'adding again / yourself: said');
setFake([PRE, SAVE, ASYNC, FLOW, NOISE], { modified: { [ACC]: { at: new Date(Date.now() - 10_000).toISOString(), byId: AUTO, by: 'Automation User' } } });
v = await dl.captureCheck();
ok(/has not arrived yet/.test(v.say) && !v.addUser, 'once logged, a fresh change without a log yet: "not arrived yet"');
setFake([PRE, SAVE, ASYNC, FLOW, NOISE], { modified: { [ACC]: { at: new Date(Date.now() - 120_000).toISOString(), byId: DEV, by: 'Dev User' } } });
v = await dl.captureCheck();
ok(/logged under the Automated Process user/.test(v.say) && v.addUser?.id === APU, 'no log long after the change by a logged user: Automated Process suggested');
setFake([PRE, SAVE, ASYNC, FLOW, NOISE, SCHED], { modified: { [ACC]: { at: '2026-11-15T07:03:00.000Z', byId: AUTO, by: 'Automation User' } } });
v = await dl.captureCheck();
ok(v.logs.find((x) => x.id === SCHED)?.record && v.logs.find((x) => x.id === SCHED).user === 'Automation User' && !v.addUser, 'the next run is logged: the other user\'s log has the record');

// ---- explain one, download, send to Claude ----
const ex = await dl.captureExplain({ id: FLOW, projectRoot: PROJECT });
ok(ex.changes.some((c) => /Set by autolaunched flow, by flow "Bridge Trace Autolaunched" element "Set_Note_From_Api"/.test(c)), 'Explain: the full "what changed and why" of one log');
const lg = await dl.captureLog({ id: FLOW });
ok(lg.file === `${FLOW}.log` && lg.text.includes('Set_Note_From_Api'), 'download: the log text');
await assert.rejects(() => dl.captureLog({ id: '07L000000000999' }), /Not a log of this capture/); n++;
await assert.rejects(() => dl.captureSend({ ids: [] }), /Tick at least one/); n++;
v = await dl.captureSend({ by: 'popup', ids: [SAVE, FLOW, SCHED], projectRoot: PROJECT });
ok(v.selected.length === 3 && fs.existsSync(v.result.traceMd) && /element "Set_Note_From_Api"/.test(fs.readFileSync(v.result.traceMd, 'utf8')), 'send: the ticked logs explained in trace.md');
const idx = fs.readFileSync(v.result.allLogs, 'utf8');
ok(fs.readdirSync(path.join(v.result.folder, 'all')).length === v.logs.length && idx.includes(NOISE) && /\| yes \|/.test(idx), 'send: every log of the window saved, with an index');
ok(/## Time marks/.test(idx) && /start \(by the developer\)/.test(idx) && /ask \(by the developer\)/.test(idx), 'the index has the time marks and who made them');
v = await dl.captureCheck({ by: 'claude' });
ok(v.marks.some((m) => m.kind === 'ask' && m.by === 'claude'), 'Claude reading the capture is a time mark');

// ---- refused change / no automation; Claude cannot add users; end ----
dl.captureEnd();
state({ traceFlagId: '7tf1', expiresAt: '2030-01-01T00:00:00.000Z' });
setFake([], { modified: { [ACC]: { at: '2026-11-15T06:48:10.000Z', byId: DEV, by: 'Dev User' } } });
await dl.captureStart({ by: 'popup', recordId: ACC });
fs.writeFileSync(process.env.BROWSER_BRIDGE_CAPTURE_STATE, JSON.stringify({ ...dl.readCapture(), at: new Date(Date.now() - 90_000).toISOString() }));
v = await dl.captureCheck();
ok(/No log has the record, and it has not changed\. If the change was refused/.test(v.say), 'refused change: said, no log expected');
dl.captureEnd();
await dl.captureStart({ by: 'popup', terms: 'Bridge Capture Test' });
fs.writeFileSync(process.env.BROWSER_BRIDGE_CAPTURE_STATE, JSON.stringify({ ...dl.readCapture(), at: new Date(Date.now() - 90_000).toISOString() }));
v = await dl.captureCheck();
ok(/a log only when automation runs/.test(v.say) && /Add the record id/.test(v.say), 'no record id, no log after a minute: no automation ran');
const indexSrc = fs.readFileSync(fileURLToPath(new URL('../mcp-server/src/index.js', import.meta.url)), 'utf8');
ok(!/addUser\(/.test(indexSrc) && !/adduser/i.test(indexSrc.match(/name: 'browser_debuglog'[\s\S]*?run: async/)[0]), 'Claude has no action that adds logging for another user');
// ---- "Log a user" (popup): any active user, any licence ----
setFake([]);
let fu = await dl.findUsers({ text: '' });
const names = fu.users.map((u) => u.name);
ok(names.includes('Automation User') && names.includes('Automated Process') && names.includes('Site Guest User') && !names.includes('Dev User') && !names.includes('Old Integration'), `no text: the integration / API / background users, active only (${names})`);
ok(fu.users.find((u) => u.id === AUTO).license === 'Salesforce Integration' && fu.users.find((u) => u.id === APU).license === 'Automated Process', 'each with its licence (or kind)');
fu = await dl.findUsers({ text: 'dev' });
ok(fu.users.length === 1 && fu.users[0].you, 'by name: yourself marked "you"');
fu = await dl.findUsers({ text: "old_int'; DELETE" });
ok(!fu.users.length, 'quotes stripped, inactive users not offered');
await assert.rejects(() => dl.addUser({ user: GONE }), /inactive/); n++;
ok(/Now logging Site Guest User/.test((await dl.addUser({ user: GUEST })).note) && (await dl.findUsers({ text: 'guest' })).users[0].logged, 'a guest user added; shown as logging');
ok(dl.stateView().addedUsers.some((u) => u.id === GUEST), 'status lists the added users with ids (popup chips)');
await dl.start(60);
ok(dl.readState().extraFlags.find((e) => e.userId === GUEST).expiresAt === dl.readState().expiresAt && fake().calls.some((c) => /data update record.*TraceFlag.*ExpirationDate=/.test(c)), 'logging renewed: the added user keeps logging as long as yours');
ok(/Stopped logging Site Guest User/.test((await dl.removeUser({ user: GUEST })).note) && !dl.readState().extraFlags.length, 'one added user stopped (×)');
await assert.rejects(() => dl.removeUser({ user: AUTO }), /not added here/); n++;
setFake([], { tracedElsewhere: [AUTO] });
ok(/already has logging on/.test((await dl.addUser({ user: AUTO })).note), 'a user logged by someone else: said, not an error');
await dl.stop();
ok(!dl.readState().extraFlags.length, 'stop: the other users\' logging removed too');
ok(dl.captureEnd().status === 'none' && (await dl.captureCheck()).status === 'none' && dl.captureView().status === 'none', 'end: no capture');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`capture: ${n} checks passed (real logs)`);
