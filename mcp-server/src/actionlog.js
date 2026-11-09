// JSONL action log (one line per browser action). Typed values and values of
// sensitive-looking fields are redacted; tokens/passwords are never logged.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR } from './hub.js';

export const ACTION_LOG = process.env.BROWSER_BRIDGE_ACTION_LOG || path.join(STATE_DIR, 'actions.jsonl');
export const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, '-')}_${crypto.randomBytes(3).toString('hex')}`;

const READ_ONLY = /^(browser_)?(status|tabs|snapshot|get_?text|screenshot|evidence|evidenceShot|console|network|options|wait_?for|hover|scroll|hub\.status)$/i;
const SENSITIVE = /pass|secret|token|otp|pin|ssn|card|cvv/i;

function redact(action, args) {
  const a = { ...args };
  if (/type$/.test(action)) { for (const k of ['value']) if (k in a) a[k] = `[${String(a[k]).length} chars]`; }
  if (a.label && SENSITIVE.test(a.label)) a.value = '[redacted]';
  if (Array.isArray(a.fields)) a.fields = a.fields.map((f) => (SENSITIVE.test(f.label || '') ? { ...f, value: '[redacted]' } : f));
  if (a.promptText) a.promptText = '[redacted]';
  if (a.expression && a.expression.length > 500) a.expression = a.expression.slice(0, 500) + '…';
  return a;
}

export function logAction(source, action, args, ok, result) {
  if (process.env.BROWSER_BRIDGE_ACTION_LOG === 'off') return;
  try {
    fs.mkdirSync(path.dirname(ACTION_LOG), { recursive: true });
    let host = null;
    try { host = new URL(result?.url || args?.url).host; } catch { /* none */ }
    fs.appendFileSync(ACTION_LOG, JSON.stringify({
      time: new Date().toISOString(), target: host, username: null, source, runId: RUN_ID,
      action, write: !READ_ONLY.test(action), details: redact(action, args || {}),
      result: ok ? 'ok' : `error: ${String(result).slice(0, 300)}`,
    }) + '\n');
  } catch { /* logging must never break a tool call */ }
}
