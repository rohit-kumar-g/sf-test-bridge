#!/usr/bin/env node
// Fast reads (mcp-server/src/sfdirect.js) and their use in debuglog.js:
// GET only, nothing else ever sent; the session never in the action log or an
// error; a failed read falls back to the CLI; writes stay on the CLI.
//   node tests/sfdirect.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cbb-direct-'));
const CORE = fileURLToPath(new URL('./fixtures/fake-sf-core.cjs', import.meta.url));
process.env.BROWSER_BRIDGE_SF_CORE = CORE;
process.env.BROWSER_BRIDGE_SF_BIN = fileURLToPath(new URL('./fixtures/fake-sf.mjs', import.meta.url));
process.env.FAKE_SF_STATE = path.join(tmp, 'fake.json');
process.env.BROWSER_BRIDGE_DEBUGLOG_STATE = path.join(tmp, 'debuglog.json');
process.env.BROWSER_BRIDGE_ACTION_LOG = path.join(tmp, 'actions.jsonl');
process.env.BROWSER_BRIDGE_LOG_CACHE = 'off';
const D = await import('../mcp-server/src/sfdirect.js');
const dl = await import('../mcp-server/src/debuglog.js');
const { calls } = createRequire(import.meta.url)(CORE);

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const actions = () => (fs.existsSync(process.env.BROWSER_BRIDGE_ACTION_LOG) ? fs.readFileSync(process.env.BROWSER_BRIDGE_ACTION_LOG, 'utf8') : '');

// ---- GET only ----
for (const m of ['POST', 'PATCH', 'DELETE', 'PUT']) await assert.rejects(() => D.request(m, 'dev@acme.test', '/services/data/v{v}/sobjects/Account/001'), /read-only/);
n++;
ok(calls.length === 0, 'a non-GET request is refused before anything is sent');
await assert.rejects(() => D.get('dev@acme.test', '/secur/frontdoor.jsp'), /only read the REST API/); n++;
ok(calls.length === 0, 'only the REST API is read');

// ---- reads ----
const q = await D.query('dev@acme.test', "SELECT Id FROM ApexLog WHERE StartTime >= 2026-11-15T00:00:00Z", { tooling: true, what: 'list logs' });
ok(q.records.length === 1 && calls.every((c) => c.method === 'GET') && /\/tooling\/query\?q=SELECT/.test(calls[0].url), 'a Tooling query is a GET');
ok(/direct body/.test(await D.logBody('dev@acme.test', '07L000000000001AAA')), 'a log\'s text');
const lines = actions().trim().split('\n').map((l) => JSON.parse(l));
ok(lines.length === 2 && lines.every((l) => l.write === false && /^GET \/services\/data\/vN\//.test(l.action)), 'each read is in the action log, as a read');

// ---- errors: the session never shows ----
process.env.FAKE_CORE_FAIL = '1';
let msg = '';
try { await D.logBody('dev@acme.test', '07L000000000002AAA'); } catch (e) { msg = e.message; }
ok(/INVALID_SESSION_ID/.test(msg) && !/00D000000000001!/.test(msg) && /<session>/.test(msg), `the session text is scrubbed from errors (${msg})`);
ok(!/00D000000000001!/.test(actions()), 'and from the action log');

// ---- debuglog: a failed direct read falls back to the CLI; writes stay on the CLI ----
fs.writeFileSync(process.env.FAKE_SF_STATE, JSON.stringify({ records: {}, calls: [], seq: 0, logs: [{ id: '07L000000000009AAA', start: '2026-11-15T07:00:00Z', text: '12:00:00.0 (1)|USER_DEBUG|[1]|DEBUG|from the CLI\n' }] }));
fs.writeFileSync(process.env.BROWSER_BRIDGE_DEBUGLOG_STATE, JSON.stringify({ username: 'dev@acme.test', userId: '005000000000001AAA', myDomain: 'acme--dev.sandbox.my.salesforce.com', instanceUrl: 'https://acme--dev.sandbox.my.salesforce.com', debugLevelId: '7dl000000000001', traceFlagId: null, expiresAt: null }));
const st = dl.readState();
const before = calls.length;
const logs = await dl.listLogs(st, 0, { allUsers: true });
ok(logs.length === 1 && logs[0].Id === '07L000000000009AAA' && calls.length > before, 'direct list failed -> the CLI answered');
const text = (await dl.getLogs(st, ['07L000000000009AAA'])).get('07L000000000009AAA');
ok(/from the CLI/.test(text), 'direct log read failed -> the CLI');
delete process.env.FAKE_CORE_FAIL;
const fromDirect = (await dl.getLogs(st, ['07L000000000003AAA'])).get('07L000000000003AAA');
ok(/direct body/.test(fromDirect), 'direct read works again: used first');
const fakeCalls = () => JSON.parse(fs.readFileSync(process.env.FAKE_SF_STATE, 'utf8')).calls;
await dl.start(15);
ok(fakeCalls().some((c) => /^data create record --use-tooling-api --sobject TraceFlag/.test(c)) && calls.every((c) => c.method === 'GET'), 'a write (trace flag) goes through the CLI; the direct client only ever sent GETs');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`sfdirect: ${n} checks passed`);
