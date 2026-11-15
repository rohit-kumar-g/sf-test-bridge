#!/usr/bin/env node
// Command-line access to the browser bridge (testing without an MCP client).
//
//   node src/cli.js serve                      run a standalone hub (keeps the extension connected)
//   node src/cli.js <command> ['<json>']       send one command, print the JSON result
//   node src/cli.js screenshot '{}' --out a.png
//   node src/cli.js charter [reset|diff]       the agent instructions file (path, default/customised)
//   node src/cli.js doctor                     check the setup and say what to fix
//   node src/cli.js debuglog [setup|start [15|30|60]|stop|remove|status|analyze [min]]   debug logs (setup: interactive)
//
// Commands are the extension commands: status, tabs, open, navigate, close,
// snapshot, click, fill, recordAction, options, type, select, key, hover,
// scroll, screenshot, getText, waitFor, evaluate, console, network, dialog,
// upload, reload, path, plus hub.status and steps (runs a browser_steps list:
// '{"steps":[{"action":"navigate","url":"..."}, ...]}').
import fs from 'node:fs';
import { Bridge, makeSession } from './hub.js';
import { logAction } from './actionlog.js';
import { runSteps } from './steps.js';

const PORT = Number(process.env.BROWSER_BRIDGE_PORT || 17345);
const [cmd, json, ...rest] = process.argv.slice(2);

if (!cmd || cmd === '-h' || cmd === '--help') {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 15).join('\n'));
  process.exit(0);
}

// Debug logs (no browser needed). setup is interactive: run it yourself.
if (cmd === 'debuglog') {
  const dl = await import('./debuglog.js');
  const action = json || 'status';
  try {
    if (action === 'setup') {
      const readline = await import('node:readline/promises');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try { await dl.setup({ ask: (q) => rl.question(q), say: (t) => console.log(t) }); } finally { rl.close(); }
    } else if (action === 'start') console.log(JSON.stringify(await dl.start(Number(rest[0]) || 30), null, 1));
    else if (action === 'stop') console.log(JSON.stringify(await dl.stop(), null, 1));
    else if (action === 'remove') console.log(JSON.stringify(await dl.remove(), null, 1));
    else if (action === 'analyze') {
      const minutes = Number(rest[0]) || 10;
      console.log(JSON.stringify(await dl.analyzeWindow({ sinceMs: Date.now() - minutes * 60_000, projectRoot: process.cwd() }), null, 1));
    } else console.log(JSON.stringify(dl.stateView(), null, 1));
    process.exit(0);
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
}

// Instructions for AI agents: the user's own file (no browser needed).
if (cmd === 'charter') {
  const { loadCharter, resetCharter, charterDiff } = await import('./charter.js');
  if (json === 'reset') {
    const c = resetCharter();
    console.log(`Restored the default instructions: ${c.file}\nSessions read them again on their next tool call.`);
  } else if (json === 'diff') {
    console.log(charterDiff());
  } else {
    const c = loadCharter();
    console.log(`Agent instructions: ${c.customised ? `customised (edited ${c.edited})` : 'default'}\nFile: ${c.file}\nEdit it with any editor; every session reads the new text on its next tool call.\n'charter diff' shows your changes, 'charter reset' restores the default.`);
  }
  process.exit(0);
}

// Each CLI call is a new process, so the CLI uses one fixed session (lane)
// that outlives the process: 'open' in one call and 'snapshot' in the next
// act on the same tab. BROWSER_BRIDGE_SESSION gives a separate lane.
const name = process.env.BROWSER_BRIDGE_SESSION || 'cli';
const bridge = new Bridge({ port: PORT, session: makeSession({ id: `cli:${name}`, label: name, keep: true }) }).start();

if (cmd === 'doctor') {
  const { runDoctor } = await import('./doctor.js');
  const r = await runDoctor((m, p, t) => bridge.request(m, p, t));
  const mark = { ok: 'OK  ', problem: 'FIX ', info: 'info' };
  for (const c of r.checks) console.log(`${mark[c.result]}  ${c.check}: ${c.detail}${c.fix ? `\n        -> ${c.fix}` : ''}`);
  console.log(`\n${r.summary}`);
  bridge.close();
  process.exit(r.checks.some((c) => c.result === 'problem') ? 1 : 0);
}

if (cmd === 'serve') {
  bridge.on('role', (r) => process.stderr.write(`[cli] role=${r}\n`));
  process.on('SIGINT', () => { bridge.close(); process.exit(0); });
} else {
  let params = {};
  if (json) params = JSON.parse(json.startsWith('@') ? fs.readFileSync(json.slice(1), 'utf8') : json);
  const outIdx = rest.indexOf('--out');
  const out = outIdx >= 0 ? rest[outIdx + 1] : null;
  const timeout = cmd === 'fill' ? 180_000 : 120_000;
  try {
    let result = cmd === 'steps'
      ? await runSteps((m, p, t) => bridge.request(m, p, t), params, (a, p, ok, r) => logAction('sf-test-bridge-cli (steps)', `browser_${a}`, p, ok, r))
      : await bridge.request(cmd, params, cmd === 'path' ? 180_000 : timeout);
    logAction('sf-test-bridge-cli', cmd, params, true, result);
    if (result?.image) {
      const file = out || `screenshot-${Date.now()}.${result.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`;
      fs.writeFileSync(file, Buffer.from(result.image, 'base64'));
      const { image, ...meta } = result;
      result = { ...meta, savedTo: file };
    }
    process.stdout.write((typeof result?.text === 'string' && (cmd === 'snapshot' || cmd === 'steps') ? result.text : JSON.stringify(result, null, 1)) + '\n');
    bridge.close();
    process.exit(0);
  } catch (e) {
    logAction('sf-test-bridge-cli', cmd, params, false, e.message);
    process.stderr.write(`ERROR: ${e.message}\n`);
    bridge.close();
    process.exit(1);
  }
}
