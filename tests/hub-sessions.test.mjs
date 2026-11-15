#!/usr/bin/env node
// Offline check of sessions in the hub (no browser needed): every request
// carries its process's session, the hub tells the extension which sessions
// are alive after it connects, and sends "session-end" when a peer session
// disconnects (not for a session marked keep, like the CLI's).
//   node tests/hub-sessions.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.BROWSER_BRIDGE_RAW_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cbb-rawlog-'));
process.env.BROWSER_BRIDGE_SESSIONS_GRACE_MS = '300';
const { Bridge, EXTENSION_ID, makeSession } = await import('../mcp-server/src/hub.js');
const { WebSocket } = createRequire(new URL('../mcp-server/package.json', import.meta.url))('ws');

const PORT = 17398;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
let n = 0;
const check = (ok, what) => { n++; if (!ok) failed++; console.log(`${ok ? 'ok ' : 'FAIL'} ${n} ${what}`); };

const A = makeSession({ label: 'project-a' });
const B = makeSession({ label: 'project-b' });
const C = makeSession({ id: 'cli:cli', label: 'cli', keep: true });
check(A.id !== B.id && A.id.startsWith('project-a-'), `session ids are distinct (${A.id}, ${B.id})`);

const hub = new Bridge({ port: PORT, token: 'test', session: A }).start();
await new Promise((r) => hub.once('role', r));

// fake extension: answers every request with the session it carried
const seen = [];
const ext = new WebSocket(`ws://127.0.0.1:${PORT}/ext`, { headers: { origin: `chrome-extension://${EXTENSION_ID}` } });
await new Promise((r) => ext.once('open', r));
ext.on('message', (d) => {
  const m = JSON.parse(d);
  seen.push(m);
  if (m.type === 'request') ext.send(JSON.stringify({ type: 'response', id: m.id, result: { session: m.params.__session } }));
});
ext.send(JSON.stringify({ type: 'hello', role: 'extension', browser: 'Fake', version: 'test' }));

const peerB = new Bridge({ port: PORT, token: 'test', session: B }).start();
const peerC = new Bridge({ port: PORT, token: 'test', session: C }).start();
await Promise.all([new Promise((r) => peerB.once('role', r)), new Promise((r) => peerC.once('role', r))]);
check(peerB.role === 'peer' && peerC.role === 'peer', 'second and third process join as peers');

const [ra, rb] = await Promise.all([hub.request('status', {}, 3000), peerB.request('status', {}, 3000)]);
check(ra.session?.id === A.id, 'hub request carries session A');
check(rb.session?.id === B.id && rb.session?.label === 'project-b', 'peer request carries session B');

await sleep(500);
const live = seen.find((m) => m.type === 'sessions');
check(live && [A.id, B.id, C.id].every((id) => live.live.includes(id)), `extension is told the live sessions (${live?.live?.join(', ')})`);
const st = hub.hubStatus();
check(st.sessions.length === 3 && st.sessions.find((s) => s.you)?.id === A.id, 'hub status lists the 3 sessions');

peerB.close();
await sleep(300);
const end = seen.find((m) => m.type === 'session-end');
check(end?.session === B.id, 'peer B closing sends session-end for B');

peerC.close();
await sleep(300);
check(!seen.some((m) => m.type === 'session-end' && m.session === C.id), 'no session-end for the kept CLI session');
check(!hub.hubStatus().sessions.some((s) => s.id === B.id), 'B is gone from the hub status');

ext.close();
hub.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
