#!/usr/bin/env node
// Command-line access to the browser bridge (testing without an MCP client).
//
//   node src/cli.js serve                      run a standalone hub (keeps the extension connected)
//   node src/cli.js <command> ['<json>']       send one command, print the JSON result
//   node src/cli.js screenshot '{}' --out a.png
//
// Commands are the extension commands: status, tabs, open, navigate, close,
// snapshot, click, fill, recordAction, options, type, select, key, hover,
// scroll, screenshot, getText, waitFor, evaluate, console, network, dialog,
// upload, reload, path, plus hub.status and steps (runs a browser_steps list:
// '{"steps":[{"action":"navigate","url":"..."}, ...]}').
import fs from 'node:fs';
import { Bridge } from './hub.js';
import { logAction } from './actionlog.js';
import { runSteps } from './steps.js';

const PORT = Number(process.env.BROWSER_BRIDGE_PORT || 17345);
const [cmd, json, ...rest] = process.argv.slice(2);

if (!cmd || cmd === '-h' || cmd === '--help') {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 12).join('\n'));
  process.exit(0);
}

const bridge = new Bridge({ port: PORT }).start();

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
