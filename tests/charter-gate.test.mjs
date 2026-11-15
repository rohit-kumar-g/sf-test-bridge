#!/usr/bin/env node
// Offline check of the agent instructions gate (no browser needed): starts the
// real MCP server (own port, no extension) and talks to it as an MCP client.
//  - every browser tool is refused until browser_guide has been read
//  - browser_status / browser_doctor / browser_end_session are not gated
//  - after the user edits the instructions file, tools ask for a re-read
//  - the guided-start prompt and the new tools are listed
//   node tests/charter-gate.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SDK = '../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client';
const { Client } = await import(new URL(`${SDK}/index.js`, import.meta.url));
const { StdioClientTransport } = await import(new URL(`${SDK}/stdio.js`, import.meta.url));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cbb-charter-'));
const CHARTER = path.join(tmp, 'charter.md');
const env = {
  ...process.env,
  BROWSER_BRIDGE_PORT: '17396',
  BROWSER_BRIDGE_CHARTER: CHARTER,
  BROWSER_BRIDGE_ACTION_LOG: 'off',
  BROWSER_BRIDGE_RAW_LOG_DIR: tmp,
  BROWSER_BRIDGE_EXT_WAIT_MS: '200',
  BROWSER_BRIDGE_SESSION: 'gate-test',
};
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL('../mcp-server/src/index.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')],
  env, stderr: 'ignore',
});
const client = new Client({ name: 'gate-test', version: '1' });
await client.connect(transport);

let failed = 0;
let n = 0;
const check = (ok, what) => { n++; if (!ok) failed++; console.log(`${ok ? 'ok ' : 'FAIL'} ${n} ${what}`); };
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { error: !!r.isError, text: r.content?.map((c) => c.text || '').join('') || '' };
};
const GATE = /Read the SF Test Bridge instructions first/;
const CHANGED = /instructions changed/;

const info = client.getInstructions?.() || '';
check(/browser_guide/.test(info) && /REQUIRED/.test(info), 'server instructions point to browser_guide as required');

const tools = (await client.listTools()).tools.map((t) => t.name);
check(['browser_guide', 'browser_brief', 'browser_doctor', 'browser_end_session'].every((t) => tools.includes(t)), 'guide, brief, doctor and end_session tools listed');

const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
check(prompts.includes('start-test'), 'guided-start prompt listed');
const pr = await client.getPrompt({ name: 'start-test', arguments: { org: 'acme--uat', target: 'Discount rule' } });
const prText = pr.messages[0].content.text;
check(/org: acme--uat/.test(prText) && /expected: \(not given\)/.test(prText) && /browser_guide/.test(prText), 'prompt carries what was given and marks what is missing');

let r = await call('browser_snapshot');
check(r.error && GATE.test(r.text), `browser_snapshot refused before reading (${r.text.slice(0, 60)})`);
r = await call('browser_brief', { org: 'https://acme--uat.sandbox.lightning.force.com', target: 'x', expected: 'y', data: 'write' });
check(r.error && GATE.test(r.text), 'browser_brief refused before reading');
r = await call('browser_status');
check(!GATE.test(r.text), 'browser_status not gated');
check(/"read": false/.test(r.text), 'status says the instructions are not read yet');

r = await call('browser_guide');
check(!r.error && /instructions for the AI agent/.test(r.text) && /Current state/.test(r.text), 'browser_guide returns the instructions and the state');
check(fs.existsSync(CHARTER), 'the user file was created from the default');

r = await call('browser_tabs');
check(!GATE.test(r.text) && !CHANGED.test(r.text), `browser_tabs passes the gate after reading (${r.text.slice(0, 60)})`);

fs.appendFileSync(CHARTER, '\n\n## 7. Team rule\n\nAlways test in the UAT sandbox.\n');
r = await call('browser_tabs');
check(r.error && CHANGED.test(r.text), 'after an edit the next tool asks for a re-read');
r = await call('browser_guide');
check(/Always test in the UAT sandbox/.test(r.text), 'the re-read shows the user\'s new text');
r = await call('browser_tabs');
check(!CHANGED.test(r.text) && !GATE.test(r.text), 'tools work again after the re-read');
r = await call('browser_status');
check(/customised/.test(r.text), 'status reports customised instructions');

process.env.BROWSER_BRIDGE_CHARTER = CHARTER;
const { charterDiff, resetCharter } = await import('../mcp-server/src/charter.js');
check(/\+ Always test in the UAT sandbox/.test(charterDiff()), 'charter diff shows the user\'s addition');
resetCharter();
r = await call('browser_tabs');
check(CHANGED.test(r.text), 'charter reset also asks sessions to re-read');

await client.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
