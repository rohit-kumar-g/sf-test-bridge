#!/usr/bin/env node
// Change trace (mcp-server/src/trace.js + debuglog.traceWindow) checked against
// REAL debug logs (tests/fixtures/real-trace: captured in a dev org from UI
// saves, an LWC calling Apex, a Queueable, flow async paths, addError, a flow
// fault, anonymous Apex; org, user and namespace scrubbed). The fake CLI only
// serves those logs; the parsing and the choice of logs see real data.
//   node tests/trace.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cbb-trace-'));
process.env.BROWSER_BRIDGE_DIRECT = 'off'; // the fake CLI has no session for direct reads
process.env.BROWSER_BRIDGE_SF_BIN = fileURLToPath(new URL('./fixtures/fake-sf.mjs', import.meta.url));
process.env.FAKE_SF_STATE = path.join(tmp, 'fake.json');
process.env.BROWSER_BRIDGE_DEBUGLOG_STATE = path.join(tmp, 'debuglog.json');
process.env.BROWSER_BRIDGE_ACTION_LOG = 'off';
process.env.BROWSER_BRIDGE_LOG_CACHE = path.join(tmp, 'log-cache');
const dl = await import('../mcp-server/src/debuglog.js');
const T = await import('../mcp-server/src/trace.js');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

const FIX = fileURLToPath(new URL('./fixtures/real-trace/', import.meta.url));
const PROJECT = path.join(FIX, 'project');
const list = JSON.parse(fs.readFileSync(path.join(FIX, 'loglist.json'), 'utf8'));
const text = (id) => fs.readFileSync(path.join(FIX, 'logs', `${id}.log`), 'utf8');
const ACC = '001jV00000L8HHJQA3'; const FAULT = '001jV00000L8A6AQAV';
const idx = T.sourceIndex(PROJECT);
const trace = (id, recordId = ACC) => T.traceLog(text(id), { recordId, idx });
const field = (t, rid, f) => t.records.find((r) => r.id.startsWith(rid.slice(0, 15)))?.fields.find((x) => x.field === f || x.field.endsWith(`__${f}`));

// ---- small pure checks ----
ok(T.objectOf(ACC) === 'Account' && T.objectOf('a0X000000000001') === null, 'object from the key prefix (standard only)');
ok(JSON.stringify(T.recordFromUrl('https://x.lightning.force.com/lightning/r/Bridge_Contact__c/a0X000000000001AAA/view')) === '{"object":"Bridge_Contact__c","recordId":"a0X000000000001AAA"}', 'record and object from the record page URL');
ok(T.validId(ACC) && !T.validId("001' OR Id != '") && !T.validId('001'), 'record ids validated (no query injection)');
ok(JSON.stringify(T.parseTerms(' Update_Opp, x, ,Gold ,Gold')) === '["Update_Opp","Gold"]', 'search terms: comma separated, trimmed, short ones and repeats dropped');
ok(T.logKind('common.api.soap.DirectSoap').startsWith('pre-save check') && T.logKind('QueueableHandler') === 'async job (Queueable)' && T.logKind('/aura') === 'page request (Lightning)', 'log kinds in plain words');
// real async logs carry a DurationMilliseconds of hundreds of millions: it must not widen the window
const asyncLog = list.find((l) => l.Id === '07LjV000003OV49UAG');
ok(asyncLog.DurationMilliseconds > 1e8 && T.filterByTime([asyncLog], { fromMs: 0, toMs: Date.parse('2030-01-01'), modifiedMs: Date.parse('2026-11-15T00:30:00Z') }).covers.length === 0, 'async log duration capped (no false "running at the save")');

// ---- the correct log: regex search of real logs ----
const sc = (id, o = {}) => T.scoreLog(text(id), { recordId: ACC, object: 'Account', ...o });
ok(sc('07LjV000003OUrFUAW').score === 0, 'profiling-only async log: never chosen');
ok(sc('07LjV000003OUsrUAG').hits.includes('record id') && sc('07LjV000003OUsrUAG').changes, 'UI save log: mentions the record (15-character id in the log) and changes data');
ok(!sc('07LjV000003OVH4UAO').hits.includes('record id'), 'another record\'s save does not match this record');
ok(sc('07LjV000003OVDqUAO').hits.includes('failure'), 'addError counts as a failure (there is no exception line)');
ok(sc('07LjV000003OVAbUAO', { terms: ['update_opp_next_step', 'nothing-like-this'] }).terms.join() === 'update_opp_next_step', 'search terms: case-insensitive, only the ones found');
ok(T.termLines(text('07LjV000003OVH4UAO'), ['REQUIRED_FIELD_MISSING']).REQUIRED_FIELD_MISSING.some((x) => x.includes('LastName') && !x.includes('<phone>')), 'search term: the line where it occurs');

// ---- S1b: UI save, Rating Cold -> Hot ----
let t = trace('07LjV000003OUsrUAG');
ok(field(t, ACC, 'Rating').before === 'Cold' && field(t, ACC, 'Rating').after === 'Hot' && /the save itself/.test(field(t, ACC, 'Rating').by), 'user input: Rating Cold -> Hot, by the save itself');
let f = field(t, ACC, 'Bridge_Trace_Tier__c');
ok(f.before === '(empty)' && f.after === 'Gold' && /flow "Bridge Trace Account Before Save" element "Set_Tier_Gold"/.test(f.by) && f.source.file.endsWith('Bridge_Trace_Account_Before_Save.flow-meta.xml') && f.source.line === 18, 'before-save flow: element and its line in the flow file; before value from the flow\'s $Record');
f = field(t, ACC, 'Bridge_Trace_Note__c');
ok(f.after === 'Bridge Trace Acme / Hot' && /element "Update_Account_Label"/.test(f.by), 'after-save flow update of the same record: value from the flow variable (the log has no values for record updates), full value although the snapshot was cut');
const con = t.records.filter((r) => r.object === 'Contact');
ok(con.length === 2, `cascade: the 2 Contacts found, as Contacts (${t.records.map((r) => r.object)})`);
f = field(t, con[0].id, 'Bridge_Trace_Note__c');
ok(f.after === 'Tier Gold' && /Apex BridgeTraceAccountHandler line 44/.test(f.by) && f.source.file.endsWith('classes/BridgeTraceAccountHandler.cls') && /c\.Bridge_Trace_Note__c = 'Tier '/.test(f.source.code), 'Apex write: the handler class (not the trigger), line and the code');
f = field(t, con[0].id, 'Description');
ok(/trigger BridgeTraceContactTrigger line 4/.test(f.by) && /cut in the log/.test(f.note) && !f.unchanged, 'Contact trigger write: cut value noted, never called "no change"');
const stepText = t.steps.map((s) => s.text);
ok(stepText.filter((s) => s.startsWith('Decision "Tier_By_Rating"')).length === 1 && stepText.some((s) => /Decision "Tier_By_Rating" -> outcome "Is_Hot"/.test(s)), 'flow element once (deferred placeholder dropped), with the outcome taken');
ok(stepText.some((s) => /Record Update "Update_Opp_Next_Step" \(1 record\): sets NextStep = /.test(s)) && stepText.some((s) => /Action Call "Call_Invocable" -> calls Apex BridgeTraceInvocable/.test(s)), 'flow record update (rows, fields from the flow file) and the Apex it calls');
ok(stepText.some((s) => s === 'calls BridgeTraceAccountHandler.afterUpdate') && !stepText.some((s) => !s.trim()), 'trigger -> handler method; no blank steps (DuplicateDetector is not an id)');
ok(t.steps.some((s) => s.text === 'Duplicate rules'), 'duplicate rules step named');

// ---- S4: LWC quick action -> Apex ----
t = trace('07LjV000003OVAbUAO');
const act = t.steps.find((s) => s.kind === 'action');
ok(act.name === 'BridgeTraceController' && act.method === 'setRating' && act.calledBy?.[0].lwc === 'bridgeTraceRating' && act.calledBy[0].file.endsWith('lwc/bridgeTraceRating/bridgeTraceRating.js'), 'namespaced apex:// action traced back to the LWC that imports it');
f = field(t, ACC, 'Rating');
ok(f.before === 'Hot' && f.after === 'Warm' && /Apex BridgeTraceController line 6/.test(f.by) && f.source.code === 'a.Rating = rating;', 'Rating set by the LWC\'s Apex: line and code');
ok(field(t, ACC, 'Bridge_Trace_Tier__c').before === 'Gold' && field(t, ACC, 'Bridge_Trace_Tier__c').after === 'Silver', 'before-save flow took the Warm outcome: Gold -> Silver');

// ---- S2: Queueable in its own log ----
t = trace('07LjV000003OV49UAG');
ok(t.steps[0].text === 'Apex BridgeTraceQueueable (async job)', 'Queueable unit named');
f = field(t, ACC, 'Bridge_Trace_Async__c');
ok(/Apex BridgeTraceQueueable line 12/.test(f.by) && f.before === 'Async flow path ran', 'async change: the queueable line, the value it replaced');
ok(field(t, ACC, 'Bridge_Trace_Tier__c').unchanged, 'a flow writing the same value: "no change"');
ok(trace('07LjV000003OV2YUAW').steps.some((s) => s.kind === 'async' && s.source?.line === 49), 'the save that queued it: "queues an async job" at the handler line');

// ---- S5: addError ----
t = trace('07LjV000003OVDqUAO');
const err = t.steps.find((s) => s.kind === 'error');
ok(/addError/.test(err.text) && err.source.file.endsWith('BridgeTraceAccountHandler.cls') && err.source.line === 9 && /addError\('Name must not contain BLOCK/.test(err.source.code), 'addError: class, line and the code with the message');
ok(/addError/.test(t.failed), 'transaction marked failed');

// ---- S6: after-save flow fault ----
t = trace('07LjV000003OVH4UAO', FAULT);
ok(t.steps.some((s) => s.kind === 'error' && /REQUIRED_FIELD_MISSING: Required fields are missing: \[LastName\]/.test(s.text) && !/<a /.test(s.text)), 'flow fault message, without the HTML link');
ok(t.records[0].notSaved && field(t, FAULT, 'Rating').after === 'Hot', 'changes of a failed save marked NOT SAVED');
ok(T.changeLine(t.records[0], field(t, FAULT, 'Rating')).startsWith('NOT SAVED (rolled back)'), 'change line says not saved');

// ---- S8: anonymous Apex from the CLI ----
ok(/lower detail/.test(trace('07LjV000003OVKHUA4').lowDetail), 'CLI-run Apex log: lower detail noted');
// S1: the failing before-save flow (field not found) wrote no error line: known limit
ok(!trace('07LjV000003OUjBUAW').steps.some((s) => s.kind === 'error'), 'known limit: a before-save flow failure has no error line in the log');

// ---- search words: whole words; ids by their first 15 characters (seen live: "Hot" matched "PhotoUrl") ----
ok(!T.termRe('Hot').test('PhotoUrl=null') && T.termRe('Hot').test('Rating=Hot,') && T.termRe('Set_Tier_Gold').test('|FlowAssignment|Set_Tier_Gold') && T.termRe('Set by future').test('Note=Set by future}'), 'a word matches whole, not inside another word');
ok(T.termRe('001jV00000L8HHJQA3').test('Id=001jV00000L8HHJ,') && !T.termRe('001jV00000L8HHJQA3').test('x001jV00000L8HHJQA3'), 'a record id matches its 15- and 18-character forms');
const { mask } = await import('../mcp-server/src/apexlog.js');
ok(mask('AnnualRevenue=2500000.0, Phone=+1 415 555 0100') === 'AnnualRevenue=2500000.0, Phone=<phone>', 'a decimal number is not masked as a phone number');

// a field set from empty (Trigger.old leaves it out), whatever order Trigger.new / old are printed in (seen live from the popup)
const parent = field(trace('07LjV000003PPmIUAW'), ACC, 'ParentId');
ok(parent && parent.before === '(empty)' && parent.after === '001jV00000L8A6AQAV' && /the save itself/.test(parent.by), `empty -> value: Parent Account set by the user (${parent?.before} -> ${parent?.after})`);

// two cut values that differ but read the same: told apart by their length (seen live)
const desc = field(trace('07LjV000003OxA6UAK'), '003jV00000Gg5GbQAJ', 'Description');
ok(desc && /\(32 characters\)$/.test(desc.before) && /\(30 characters\)$/.test(desc.after) && /only the start and the length/.test(desc.cut), `cut values that read the same show their lengths (${desc?.before} -> ${desc?.after})`);

// ---- background work, named from the real logs (operation + content) ----
const kind = (id) => T.logKind(list.find((l) => l.Id === id).Operation, text(id));
ok(/^API call: Apex REST \/acmens\/bridgetrace \(BridgeTraceRest\.setRating\)$/.test(kind('07LjV000003P1IXUA0')), `Apex REST endpoint (${kind('07LjV000003P1IXUA0')})`);
ok(kind('07LjV000003P1QbUAK') === 'async job (Batch BridgeTraceBatch: start)' && kind('07LjV000003P1TpUAK') === 'async job (Batch BridgeTraceBatch: finish)' && kind('07LjV000003P1SEUA0') === 'async job (Batch BridgeTraceBatch: execute (one chunk))', 'Batch Apex: start / execute chunk / finish');
ok(/^scheduled Apex job "Bridge Trace Matrix \d+"$/.test(kind('07LjV000003P2jFUAS')), `scheduled Apex (${kind('07LjV000003P2jFUAS')})`);
ok(/^platform event: .*Automated Process/.test(kind('07LjV000003P1f7UAC')) && kind('07LjV000003P205UAC') === 'async job (@future)', 'platform event flow, @future');
ok(/^scheduled flow Bridge_Trace_Scheduled: picks the records \(1\)/.test(kind('07LjV000003P0UXUA0')) && kind('07LjV000003P0W9UAK') === 'scheduled or batch run: flow "Bridge Trace Scheduled"', 'scheduled flow: the job and the run');
ok(kind('07LjV000003P1wsUAC') === 'API call (composite)' && /^pre-save check \(before-save flows only/.test(kind('07LjV000003P1wrUAC')), 'composite API call and its pre-save check');
const fin = trace('07LjV000003P1TpUAK');
ok(fin.failed && fin.steps.some((s) => s.kind === 'error' && /Too many future calls/.test(s.text) && s.source?.line === 13), 'batch finish: the LimitException and its line');
const pe = field(trace('07LjV000003P1f7UAC'), ACC, 'Bridge_Trace_Note__c');
ok(pe && /Set by platform event flow/.test(pe.after) && /element "Set_Note_From_Event"/.test(pe.by), 'platform-event flow: update by filter credited to its element');
ok(!JSON.stringify(T.termLines(text('07LjV000003P1IXUA0'), ['remoteAddress'])).match(/\d+\.\d+\.\d+\.\d+/), 'Apex REST log: the caller\'s IP address is masked in what Claude sees');

// ---- traceWindow: choose among the real logs ----
const setFake = (extra) => fs.writeFileSync(process.env.FAKE_SF_STATE, JSON.stringify({ records: {}, calls: [], seq: 0, logs: list.map((l) => ({ id: l.Id, start: l.StartTime.replace('+0000', 'Z'), operation: l.Operation, status: l.Status, duration: l.DurationMilliseconds, text: text(l.Id) })), ...extra }));
fs.writeFileSync(process.env.BROWSER_BRIDGE_DEBUGLOG_STATE, JSON.stringify({ username: 'dev@acme.test', userId: '005000000000001AAA', myDomain: 'acme-dev-ed.develop.my.salesforce.com', instanceUrl: 'https://acme-dev-ed.develop.my.salesforce.com', traceFlagId: '7tf1', expiresAt: '2030-01-01T00:00:00.000Z', startedAt: '2026-11-14T23:06:00.000Z' }));
const W = (a, b) => ({ fromMs: Date.parse(a), toMs: Date.parse(b) });
const save = path.join(tmp, 'out');

setFake({ modified: { [ACC]: '2026-11-14T23:13:58.000Z' } });
let r = await dl.traceWindow({ ...W('2026-11-14T23:13:42Z', '2026-11-14T23:14:11Z'), recordId: ACC, projectRoot: PROJECT, saveDir: save });
ok(r.logs.length === 2 && /07LjV000003OVAbUAO page request/.test(r.logs[0]) && /07LjV000003OVCDUA4 async/.test(r.logs[1]), `LWC action window: the save and its async flow path, in order (${r.logs})`);
ok(r.changes.some((c) => /Bridge_Trace_Tier__c: Gold -> Silver/.test(c)) && r.changes.some((c) => /Account 001jV00000L8HHJQA3 Rating: Hot -> Warm, by Apex BridgeTraceController line 6/.test(c)) && r.changes.some((c) => /Contact 003/.test(c)), 'changes: the record and the cascaded Contacts');
ok(!r.changes.some((c) => /no change/.test(c)), 'summary leaves out same-value writes');
const md = fs.readFileSync(r.traceMd, 'utf8');
ok(/### Account 001jV00000L8HHJQA3 \(the record you asked about\)/.test(md) && /called by LWC bridgeTraceRating/.test(md) && /`a\.Rating = rating;`/.test(md), 'trace.md: record section first, LWC caller, code lines');
ok(JSON.parse(fs.readFileSync(r.traceJson, 'utf8')).records.length >= 3 && fs.existsSync(path.join(save, '07LjV000003OVAbUAO.log')), 'trace.json and the chosen logs saved');

setFake({ modified: { [ACC]: '2026-11-14T23:13:03.000Z' } });
r = await dl.traceWindow({ ...W('2026-11-14T23:12:45Z', '2026-11-14T23:13:14Z'), recordId: ACC, projectRoot: PROJECT });
ok(r.logs.length === 3 && /pre-save check/.test(r.logs[0]) && /Queueable/.test(r.logs[2]), `revenue window: pre-save check, save, Queueable (${r.logs})`);
ok(r.changes.some((c) => /Bridge_Trace_Score__c: \(empty\) -> 25, by Apex BridgeTraceAccountHandler line 13/.test(c)) && r.changes.some((c) => /Bridge_Trace_Async__c: .*BridgeTraceQueueable line 12/.test(c)), 'the trigger\'s change and the later async change');
ok(r.notes.some((x) => /pre-save check/.test(x)), 'note explains the pre-save check log');

setFake({ modified: { [ACC]: '2026-11-14T23:13:58.000Z' } });
r = await dl.traceWindow({ ...W('2026-11-14T23:14:11Z', '2026-11-14T23:14:40Z'), recordId: ACC, projectRoot: PROJECT });
ok(r.changed === false && /not changed in the window/.test(r.note) && /no log/.test(r.note), 'blocked save (addError): the record was not changed; said plainly');
r = await dl.traceWindow({ ...W('2026-11-14T23:14:11Z', '2026-11-14T23:14:40Z'), projectRoot: PROJECT });
ok(r.errors.some((e) => /addError/.test(e) && /BridgeTraceAccountHandler\.cls:9/.test(e)) && r.notes.some((x) => /rolled back/.test(x)), 'same window without a record: the addError and its line');

r = await dl.traceWindow({ ...W('2026-11-14T23:15:38Z', '2026-11-14T23:16:43Z'), projectRoot: PROJECT });
ok(/No debug logs in the window/.test(r.note) && /validation rule/.test(r.note), 'validation-rule failure: no log at all, said plainly');

r = await dl.traceWindow({ ...W('2026-11-14T23:06:00Z', '2026-11-14T23:17:00Z'), terms: 'REQUIRED_FIELD_MISSING', projectRoot: PROJECT });
ok(r.logs.length === 1 && /07LjV000003OVH4UAO/.test(r.logs[0]) && r.found.REQUIRED_FIELD_MISSING.length >= 1, `search term finds the one log among ${r.window.logs} (${r.logs})`);
r = await dl.traceWindow({ ...W('2026-11-14T23:06:00Z', '2026-11-14T23:17:00Z'), terms: 'no-such-thing-xyz', projectRoot: PROJECT });
ok(/None of the \d+ logs searched contains "no-such-thing-xyz"/.test(r.note), 'search term not found: said plainly');

// the popup search the developer ran: several saves, one term in snapshots printed many times
r = await dl.traceWindow({ ...W('2026-11-14T23:06:00Z', '2026-11-14T23:17:00Z'), terms: 'Revenue reviewed', projectRoot: PROJECT });
const asy = r.changes.find((c) => /Account 001jV00000L8HHJQA3 \w+__Bridge_Trace_Async__c/.test(c));
ok(asy && /earlier: Revenue reviewed: 2500000 \(Apex BridgeTraceQueueable line 12\)/.test(asy), `a value changed by an earlier save is kept, not lost in the merge (${asy})`);
ok(Object.values(r.found['Revenue reviewed']).every(Boolean) && r.found['Revenue reviewed'].every((x) => !/^\S+: \d\d:\d\d:\d\d [a-z]/.test(x)), 'found lines start at a field boundary, not mid-word');
const perLog = {}; for (const x of r.found['Revenue reviewed']) { const k = x.replace(/ \d\d:\d\d:\d\d /, ' '); ok(!perLog[k], `found line shown once: ${k.slice(0, 60)}`); perLog[k] = 1; }
// B2, a real UI inline edit: the before-save flow is logged only in the pre-save check log
setFake({ modified: { [ACC]: '2026-11-15T06:30:11.000Z' } });
r = await dl.traceWindow({ ...W('2026-11-15T06:30:03Z', '2026-11-15T06:30:17Z'), recordId: ACC, projectRoot: PROJECT });
ok(r.logs.length === 3 && r.changes.some((c) => /Bridge_Trace_Tier__c: Bronze -> Gold, by flow "Bridge Trace Account Before Save" element "Set_Tier_Gold"/.test(c)), `before-save flow seen only in the pre-save check log keeps the credit (${r.changes[0]})`);
ok(r.changes.some((c) => /Rating: Cold -> Hot, by the save itself/.test(c)) && r.changes.filter((c) => /^Contact/.test(c)).length === 4, 'the user\'s own change and the Contact cascade');
// B1: the same value saved again: Salesforce saves and runs the automation, nothing changes
setFake({ modified: { [ACC]: '2026-11-15T06:29:03.000Z' } });
r = await dl.traceWindow({ ...W('2026-11-15T06:28:31Z', '2026-11-15T06:29:14Z'), recordId: ACC, projectRoot: PROJECT });
ok(r.logs.length === 1 && !r.changes.length && r.sameValue.some((x) => /Bridge_Trace_Tier__c/.test(x)), 'save without a change: no changes, the same-value write named');
// logging started again later: an asked-for time range still reaches the earlier logs
fs.writeFileSync(process.env.BROWSER_BRIDGE_DEBUGLOG_STATE, JSON.stringify({ ...JSON.parse(fs.readFileSync(process.env.BROWSER_BRIDGE_DEBUGLOG_STATE, 'utf8')), startedAt: '2026-11-15T06:14:00.000Z' }));
r = await dl.traceWindow({ ...W('2026-11-14T23:06:00Z', '2026-11-14T23:17:00Z'), terms: 'REQUIRED_FIELD_MISSING', projectRoot: PROJECT });
ok(r.logs?.length === 1, 'logging restarted later: logs of the earlier logging window are still searched');
fs.writeFileSync(process.env.BROWSER_BRIDGE_DEBUGLOG_STATE, JSON.stringify({ ...JSON.parse(fs.readFileSync(process.env.BROWSER_BRIDGE_DEBUGLOG_STATE, 'utf8')), startedAt: '2026-11-14T23:06:00.000Z' }));

r = await dl.traceWindow({ recordId: ACC, orgHost: 'other.lightning.force.com' });
ok(r.used === false && /set up for/.test(r.note), 'another org: not used');
await assert.rejects(() => dl.traceWindow({ recordId: "001' OR Name != '" }), /15 or 18/); n++;

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`trace: ${n} checks passed (real logs)`);
