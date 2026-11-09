#!/usr/bin/env node
// Offline check of the hub's timeout handling (no browser needed): a request
// carries __budgetMs, and when the hub stops waiting it sends the extension a
// cancel for that request id. Also: an evidence image is kept out of the raw
// traffic log (placeholder instead of base64).
//   node tests/hub-cancel.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// raw log into a temp folder (set before hub.js reads it)
process.env.BROWSER_BRIDGE_RAW_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cbb-rawlog-'));
const { Bridge, EXTENSION_ID } = await import('../mcp-server/src/hub.js');

const { WebSocket } = createRequire(new URL('../mcp-server/package.json', import.meta.url))('ws');

const PORT = 17399;
const hub = new Bridge({ port: PORT, token: 'test' }).start();
await new Promise((r) => hub.once('role', r));
const seen = [];
const ext = new WebSocket(`ws://127.0.0.1:${PORT}/ext`, { headers: { origin: `chrome-extension://${EXTENSION_ID}` } });
await new Promise((r) => ext.once('open', r));
ext.on('message', (d) => seen.push(JSON.parse(d)));
ext.send(JSON.stringify({ type: 'hello', role: 'extension', browser: 'Fake', version: 'test' }));
await new Promise((r) => setTimeout(r, 200));

let err = null;
await hub.request('click', { text: 'X' }, 1000).catch((e) => { err = e.message; });
await new Promise((r) => setTimeout(r, 200));
const req = seen.find((m) => m.type === 'request' && m.method === 'click');
const cancel = seen.find((m) => m.type === 'cancel');
// evidence image: the fake extension answers with ~60 KB of base64
const IMG = Buffer.alloc(45_000, 7).toString('base64');
ext.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.type === 'request' && m.method === 'evidenceShot') ext.send(JSON.stringify({ type: 'response', id: m.id, result: { image: IMG, mimeType: 'image/jpeg' } }));
});
const shot = await hub.request('evidenceShot', {}, 3000).catch((e) => ({ error: e.message }));
await new Promise((r) => setTimeout(r, 200));
const raw = fs.readdirSync(process.env.BROWSER_BRIDGE_RAW_LOG_DIR).map((f) => fs.readFileSync(path.join(process.env.BROWSER_BRIDGE_RAW_LOG_DIR, f), 'utf8')).join('');
const checks = [
  ['request has __budgetMs = timeout', req?.params?.__budgetMs === 1000],
  ['hub timed out with a clear message', /did not answer "click" within 1000ms \(the command was cancelled/.test(err || '')],
  ['cancel sent for the same request id', cancel && cancel.id === req?.id],
  ['evidence image reaches the caller in full', shot?.image === IMG],
  ['raw log has a placeholder, not the image', /\[evidence image omitted: \d+ base64 chars, sha256 [0-9a-f]{16}\]/.test(raw) && !raw.includes(IMG.slice(0, 200))],
];
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
ext.close(); hub.close();
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
