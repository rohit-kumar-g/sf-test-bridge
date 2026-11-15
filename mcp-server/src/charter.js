// The agent charter: the instructions every AI agent session must read once
// (browser_guide) before it can use the browser tools.
//
// The text belongs to the user who installed SF Test Bridge:
//   ~/.sf-test-bridge/charter.md   created from charter.default.md on first
//                                  use; never overwritten afterwards.
// Sessions remember the hash of the version they read; when the file
// changes, the next tool call asks them to read it again.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { STATE_DIR } from './hub.js';

export const CHARTER_FILE = process.env.BROWSER_BRIDGE_CHARTER || path.join(STATE_DIR, 'charter.md');
export const DEFAULT_FILE = fileURLToPath(new URL('./charter.default.md', import.meta.url));

const norm = (t) => String(t).replace(/\r\n/g, '\n').trim();
const hash = (t) => crypto.createHash('sha256').update(norm(t)).digest('hex').slice(0, 16);

export function defaultText() {
  return fs.readFileSync(DEFAULT_FILE, 'utf8');
}

// Create the user's file from the default if it doesn't exist.
export function ensureCharter() {
  if (!fs.existsSync(CHARTER_FILE)) {
    fs.mkdirSync(path.dirname(CHARTER_FILE), { recursive: true });
    fs.writeFileSync(CHARTER_FILE, defaultText(), { flag: 'wx' });
  }
  return CHARTER_FILE;
}

let cache = null; // { mtimeMs, size, text, hash }
// The current charter: { text, hash, customised, file, edited }.
export function loadCharter() {
  ensureCharter();
  const st = fs.statSync(CHARTER_FILE);
  if (!cache || cache.mtimeMs !== st.mtimeMs || cache.size !== st.size) {
    let text = fs.readFileSync(CHARTER_FILE, 'utf8');
    if (!norm(text)) text = defaultText(); // an emptied file falls back to the default
    cache = { mtimeMs: st.mtimeMs, size: st.size, text, hash: hash(text) };
  }
  const customised = norm(cache.text) !== norm(defaultText());
  return { text: cache.text, hash: cache.hash, customised, file: CHARTER_FILE, edited: new Date(cache.mtimeMs).toISOString() };
}

export function resetCharter() {
  fs.mkdirSync(path.dirname(CHARTER_FILE), { recursive: true });
  fs.writeFileSync(CHARTER_FILE, defaultText());
  cache = null;
  return loadCharter();
}

// Line diff of the user's file against the default (- default, + user's).
export function charterDiff() {
  const a = norm(defaultText()).split('\n');
  const b = norm(loadCharter().text).split('\n');
  // longest common subsequence, enough for files of a few hundred lines
  const n = a.length; const m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push(`- ${a[i++]}`); else out.push(`+ ${b[j++]}`);
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out.length ? out.join('\n') : '(no differences: the instructions are the default)';
}

// Tools an agent may call before reading the charter.
export const GATE_FREE = new Set(['browser_guide', 'browser_status', 'browser_end_session', 'browser_doctor']);

// The per-session gate. readHash: the hash this session read (or null).
// Returns null when the tool may run, or the refusal text.
export function gate(toolName, readHash) {
  if (GATE_FREE.has(toolName)) return null;
  const { hash: current } = loadCharter();
  if (!readHash) return 'Read the SF Test Bridge instructions first: call browser_guide (once per session). Browser tools stay refused until then.';
  if (readHash !== current) return 'The SF Test Bridge instructions changed since you read them: call browser_guide again, then continue.';
  return null;
}
