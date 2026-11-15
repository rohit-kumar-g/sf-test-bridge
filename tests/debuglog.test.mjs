#!/usr/bin/env node
// Offline check of debug logs (mcp-server/src/debuglog.js + apexlog.js) with a
// fake Salesforce CLI (tests/fixtures/fake-sf.mjs): setup with confirmation and
// controlled test, production refused, rollback, explicit org on every call,
// start / stop / remove touching only our records, and the log analysis.
//   node tests/debuglog.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cbb-debuglog-'));
process.env.BROWSER_BRIDGE_DIRECT = 'off'; // the fake CLI has no session for direct reads
process.env.BROWSER_BRIDGE_SF_BIN = fileURLToPath(new URL('./fixtures/fake-sf.mjs', import.meta.url));
process.env.FAKE_SF_STATE = path.join(tmp, 'fake.json');
process.env.BROWSER_BRIDGE_DEBUGLOG_STATE = path.join(tmp, 'debuglog.json');
process.env.BROWSER_BRIDGE_ACTION_LOG = 'off';
process.env.BROWSER_BRIDGE_LOG_CACHE = 'off'; // the fake CLI reuses log ids after a reset
const dl = await import('../mcp-server/src/debuglog.js');
const { analyzeLog, rootCause, mask } = await import('../mcp-server/src/apexlog.js');
const fake = () => (fs.existsSync(process.env.FAKE_SF_STATE) ? JSON.parse(fs.readFileSync(process.env.FAKE_SF_STATE, 'utf8')) : { records: {}, logs: [], calls: [] });
const reset = (mode) => { fs.rmSync(process.env.FAKE_SF_STATE, { force: true }); fs.rmSync(process.env.BROWSER_BRIDGE_DEBUGLOG_STATE, { force: true }); if (mode) process.env.FAKE_SF_MODE = mode; else delete process.env.FAKE_SF_MODE; };
const run = (answers) => { const said = []; const q = [...answers]; return dl.setup({ ask: async () => q.shift(), say: (t) => said.push(t) }).then((r) => ({ r, said }), (e) => ({ e, said })); };

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

// 1. not confirmed: nothing created
reset();
let x = await run(['1', '15', 'n']);
ok(/Not confirmed. Nothing was created/.test(x.e?.message) && !Object.keys(fake().records).length, 'not confirmed: nothing created');
ok(x.said.join('\n').includes('1. acme-dev  dev@acme.test') && !/default/i.test(x.said.join('\n')), 'orgs listed by number, no default preselected');

// 2. production refused
reset();
x = await run(['2', '30', 'y']);
ok(/production org.*Nothing was created/i.test(x.e?.message) && !Object.keys(fake().records).length, 'production refused before anything is created');

// 3. no org chosen
reset();
x = await run(['9']);
ok(/No org chosen/.test(x.e?.message), 'invalid choice: stops');

// 4. controlled test fails -> rollback
reset('nolog');
x = await run(['1', '15', 'y']);
ok(/check failed: no log arrived.*Nothing was left behind/.test(x.e?.message) && !Object.keys(fake().records).length && !fs.existsSync(process.env.BROWSER_BRIDGE_DEBUGLOG_STATE), 'check failed: everything created is removed again, no state saved');

// 5. full setup
reset();
x = await run(['1', '15', 'y']);
ok(!x.e && x.r.state === 'on' && x.r.user === 'dev@acme.test', `setup ok, logging on (${x.e?.message || ''})`);
const s = dl.readState();
ok(s.levels.Validation === 'INFO' && s.levels.ApexCode === 'FINEST' && s.levels.Database === 'FINEST' && s.levels.System === 'FINE' && s.levels.Wave === 'NONE', 'full detail in one try (best-known maxima accepted)');
ok(fake().calls.filter((c) => c.startsWith('data create record --use-tooling-api --sobject DebugLevel')).length === 1, 'one create call when the maxima are accepted');
const calls = fake().calls;
ok(calls.filter((c) => !c.startsWith('org list')).every((c) => c.includes('--target-org dev@acme.test')), 'every org call names the org explicitly');
ok(x.said.join(' ').includes('✓ Logging added') && x.said.join(' ').includes('✓ Check passed') && /On until \d/.test(x.said.join(' ')), 'short confirmation lines');
ok(!/7dl|7tf|07L|FINEST/.test(x.said.join(' ')), 'no ids or levels shown to the user (action log only)');

// 5b. an org that rejects one of the maxima: baseline, then each category raised on its own
{
  const keep = fs.readFileSync(process.env.BROWSER_BRIDGE_DEBUGLOG_STATE, 'utf8');
  const keepFake = fs.readFileSync(process.env.FAKE_SF_STATE, 'utf8');
  reset(); process.env.FAKE_SF_STRICT = '1';
  const y = await run(['1', '15', 'y']);
  const lv = dl.readState()?.levels || {};
  ok(!y.e && lv.Callout === 'FINER' && lv.ApexCode === 'FINEST' && lv.Database === 'FINEST' && lv.System === 'FINE' && lv.Workflow === 'FINER', `fallback pinpoints the rejected category only (${JSON.stringify(lv)})`);
  delete process.env.FAKE_SF_STRICT;
  fs.writeFileSync(process.env.BROWSER_BRIDGE_DEBUGLOG_STATE, keep); fs.writeFileSync(process.env.FAKE_SF_STATE, keepFake);
}

// 5c. the popup's steps (listOrgs -> plan -> create)
{
  const keep = fs.readFileSync(process.env.BROWSER_BRIDGE_DEBUGLOG_STATE, 'utf8');
  const keepFake = fs.readFileSync(process.env.FAKE_SF_STATE, 'utf8');
  reset();
  const orgs = await dl.listOrgs();
  ok(orgs.length === 2 && orgs[0].host === 'acme--dev.sandbox.my.salesforce.com' && orgs[0].alias === 'acme-dev', 'popup: org list with alias and host');
  const pp = await dl.plan('prod@acme.test');
  ok(pp.production && /Production org/.test(pp.refused) && !pp.summary, 'popup plan: production refused, nothing offered');
  await assert.rejects(dl.create({ username: 'prod@acme.test', minutes: 30 }), /production org.*Nothing was created/i); n++;
  ok(!Object.keys(fake().records).length, 'create re-checks production itself (no trust in an earlier answer)');
  const pd = await dl.plan('dev@acme.test');
  ok(!pd.refused && pd.summary.length === 2 && pd.summary.join(' ').length < 120 && /same user/.test(pd.note), 'popup plan: two short lines and the same-user note');
  const c = await dl.create({ username: 'dev@acme.test', minutes: 60 });
  ok(c.state === 'on' && c.minutesLeft > 55 && c.lines.join() .includes('✓ Check passed') && !c.details, 'popup create: on, short lines, no technical details');
  await assert.rejects(dl.plan('dev@acme.test'), /already set up/); n++;
  fs.writeFileSync(process.env.BROWSER_BRIDGE_DEBUGLOG_STATE, keep); fs.writeFileSync(process.env.FAKE_SF_STATE, keepFake);
}

// 6. setup again: refused while set up
x = await run(['1', '15', 'y']);
ok(/already set up/.test(x.e?.message), 'a second setup is refused (remove first)');

// 7. stop / start / remove
let v = await dl.stop();
ok(v.state === 'ready' && Object.keys(fake().records).length === 1, 'stop: trace flag deleted, debug level kept');
v = await dl.start(30);
ok(v.state === 'on' && v.minutesLeft > 25 && Object.keys(fake().records).length === 2, 'start: new trace flag for 30 min');
const someoneElse = 'x'; const f0 = fake(); f0.records['7dlOTHER'] = { sobject: 'DebugLevel', DeveloperName: 'Someone_Elses' }; fs.writeFileSync(process.env.FAKE_SF_STATE, JSON.stringify(f0)); void someoneElse;
v = await dl.remove();
ok(v.state === 'not set up' && /Nothing is left in the org/.test(v.note), 'remove: confirms nothing is left');
ok(Object.keys(fake().records).join() === '7dlOTHER', 'remove deleted only our records (another debug level untouched)');
ok(dl.stateView().state === 'not set up', 'state cleared');

// 8. analysis window when not on
ok((await dl.analyzeWindow({ sinceMs: Date.now() - 60_000 })).used === false, 'analysis refused when not set up');

// 8b. Windows: sf.cmd runs through cmd.exe, so one argument with spaces must
// stay one argument (the SOQL query that broke the first live setup)
ok(dl.winQuote('SELECT Id, IsSandbox FROM Organization') === '"SELECT Id, IsSandbox FROM Organization"', 'query with spaces quoted as one argument');
ok(dl.winQuote('--target-org') === '--target-org' && dl.winQuote('p2') === 'p2', 'plain arguments unchanged');
ok(dl.winQuote("SELECT Id FROM User WHERE Username = 'a@b.c'") === "\"SELECT Id FROM User WHERE Username = 'a@b.c'\"", 'single quotes kept inside');
ok(dl.winQuote('say "hi"') === '"say \\"hi\\""', 'inner double quotes escaped');
ok(dl.winQuote('DeveloperName=X MasterLabel=X ApexCode=FINEST') === '"DeveloperName=X MasterLabel=X ApexCode=FINEST"', 'tooling --values quoted');

// 8c. many logs in a window: read only what matters
{
  const mk = (i, status = 'Success', len = 500) => ({ Id: `07L${i}`, StartTime: new Date(Date.UTC(2026, 10, 14, 22, 0, i)).toISOString(), Status: status, LogLength: len });
  const fifty = Array.from({ length: 50 }, (_, i) => mk(i));
  let p = dl.pickLogs(fifty);
  ok(p.pick.length === 0 && /none worth reading/.test(p.why), '50 short successful logs: none downloaded');
  const withFails = [...fifty.slice(0, 20), mk(20, 'Attempt to de-reference a null object', 90_000), ...fifty.slice(21, 40), mk(40, 'FIELD_CUSTOM_VALIDATION_EXCEPTION', 4000), ...fifty.slice(41)];
  p = dl.pickLogs(withFails);
  ok(p.pick.length === 2 && p.pick.every((l) => l.Status !== 'Success') && p.why === 'failed', '50 logs, 2 failed: only those 2 read');
  const manyFails = Array.from({ length: 12 }, (_, i) => mk(i, 'error', 1000));
  ok(dl.pickLogs(manyFails).pick.length === 5 && dl.pickLogs(manyFails).pick[4].Id === '07L11', 'many failures: the latest 5');
  const big = [...fifty, mk(50, 'Success', 300_000), mk(51, 'Success', 9000)];
  p = dl.pickLogs(big, { aroundMs: Date.UTC(2026, 10, 14, 22, 0, 51) });
  ok(p.pick[0].Id === '07L51' && p.pick.length === 2, 'no failure: the large logs nearest the step first');
}

// 9. log parser
const LOG = [
  '12:00:00.000 (1)|CODE_UNIT_STARTED|[EXTERNAL]|01q000000000001|OppTrigger on Opportunity trigger event BeforeInsert|__sfdc_trigger/OppTrigger',
  '12:00:00.001 (2)|USER_DEBUG|[3]|DEBUG|owner jane.doe@acme.test phone +1 415 555 0100',
  '12:00:00.002 (3)|SOQL_EXECUTE_BEGIN|[4]|Aggregations:0|SELECT Id FROM Account WHERE Name = \'X\'',
  '12:00:00.003 (4)|VARIABLE_ASSIGNMENT|[5]|discount|0.35',
  '12:00:00.004 (5)|DML_BEGIN|[6]|Op:Update|Type:Account|Rows:1',
  '12:00:00.005 (6)|EXCEPTION_THROWN|[7]|System.NullPointerException: Attempt to de-reference a null object',
  '12:00:00.006 (7)|FATAL_ERROR|System.NullPointerException: Attempt to de-reference a null object Trigger.OppTrigger: line 7, column 1',
  '12:00:00.007 (8)|CODE_UNIT_FINISHED|OppTrigger on Opportunity trigger event BeforeInsert',
].join('\n');
const src = path.join(tmp, 'proj');
fs.mkdirSync(path.join(src, 'force-app/main/default/triggers'), { recursive: true });
fs.writeFileSync(path.join(src, 'force-app/main/default/triggers/OppTrigger.trigger'), 'trigger OppTrigger on Opportunity (before insert) {\n  // 2\n  System.debug(owner);\n  List<Account> a = [SELECT Id FROM Account];\n  Decimal discount = 0.35;\n  update a;\n  String s = o.Name.trim();\n}\n');
const a = analyzeLog(LOG, { source: src });
ok(a.units[0].kind === 'trigger' && a.units[0].name === 'OppTrigger' && a.units[0].object === 'Opportunity', 'code unit: trigger, object');
ok(a.debug[0].line === 3 && /<email>/.test(a.debug[0].message) && /<phone>/.test(a.debug[0].message) && !/jane/.test(a.debug[0].message), 'USER_DEBUG line, email and phone masked');
ok(a.queries === 1 && a.dml[0].op === 'Update' && a.dml[0].type === 'Account', 'SOQL counted, DML read');
const exc = a.failures.find((f) => f.kind === 'exception');
ok(exc.line === 7 && exc.source.file.endsWith('triggers/OppTrigger.trigger') && exc.source.code === 'String s = o.Name.trim();', 'exception matched to the local source line');
ok(exc.before.some((b) => /var \[5\] discount = 0.35/.test(b)) && exc.before.some((b) => /DML \[6\] Update Account/.test(b)), 'what happened just before the failure');
ok(/^Apex error: System.NullPointerException/.test(rootCause([a])) || /Apex error/.test(rootCause([a])), `root cause line (${rootCause([a])})`);
ok(analyzeLog('12:00:00.000 (1)|VALIDATION_FAIL\n').failures[0].kind === 'validation', 'validation failure recognised');
ok(analyzeLog('x\n*** Skipped 123 bytes of detailed log\nMAXIMUM DEBUG LOG SIZE REACHED\n').truncated, 'truncated log detected');
ok(mask('call 0044 20 7946 0958 or a@b.co') === 'call <phone> or <email>' && mask('Rows:1 at 12:00:00') === 'Rows:1 at 12:00:00', 'masking leaves ordinary numbers alone');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`debuglog: ${n} checks passed`);
