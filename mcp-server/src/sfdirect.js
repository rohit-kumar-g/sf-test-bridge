// Fast reads for the debug logs: GET requests made in this process with the
// Salesforce CLI's own library (@salesforce/core, from the developer's CLI
// install) and the login the CLI already has, instead of one CLI process per
// read (6-7 s each on Windows; measured: 12 logs 53 s -> 4 s).
//
// Rules (decided with the developer):
// - GET only: any other method is refused here, in code, before anything is
//   sent. Writes (trace flags, the debug level, apex run) stay on the CLI.
// - The session stays inside the CLI's library, in memory: this file never
//   reads, logs, saves or returns it; error texts are scrubbed anyway.
// - Every request writes an action-log line (without the session).
// - A caller falls back to the CLI when a read fails.
// BROWSER_BRIDGE_DIRECT=off turns it off (tests with a fake CLI);
// BROWSER_BRIDGE_SF_CORE points at a library to use instead (tests).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { logAction } from './actionlog.js';

export const enabled = () => process.env.BROWSER_BRIDGE_DIRECT !== 'off';
const SESSION = /00D\w{12,15}![\w.]+/g; // a Salesforce session id, should one ever show up in a message
const scrub = (s) => String(s).replace(SESSION, '<session>').replace(/Bearer\s+\S+/gi, 'Bearer <session>');

// @salesforce/core from the CLI that is on the PATH (npm install, or the installer's client folder)
let core = null;
function loadCore() {
  if (core) return core;
  const own = process.env.BROWSER_BRIDGE_SF_CORE;
  if (own) { core = createRequire(import.meta.url)(own); return core; }
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    if (!['sf', 'sf.cmd', 'sf.exe'].some((b) => fs.existsSync(path.join(d, b)))) continue;
    const roots = [path.join(d, 'node_modules/@salesforce/cli'), path.join(d, '../lib/node_modules/@salesforce/cli'), path.join(d, '..'), path.join(d, '../client')];
    for (const r of roots) {
      try { if (fs.existsSync(path.join(r, 'package.json'))) { core = createRequire(path.join(r, 'package.json'))('@salesforce/core'); return core; } } catch { /* next */ }
    }
  }
  throw new Error('the Salesforce CLI library was not found');
}
const conns = new Map(); // CLI username -> connection (the library keeps and refreshes the session)
async function connection(username) {
  if (!conns.has(username)) {
    const org = await loadCore().Org.create({ aliasOrUsername: username });
    conns.set(username, org.getConnection());
  }
  return conns.get(username);
}
export function forget(username) { if (username) conns.delete(username); else conns.clear(); }

// The only way out: GET, to the REST API of the org.
export async function request(method, username, apiPath, { what = 'read' } = {}) {
  if (String(method).toUpperCase() !== 'GET') throw new Error(`direct calls are read-only: ${method} refused`);
  if (!enabled()) throw new Error('direct reads are off');
  if (!/^\/services\/data\/v(\d+\.\d+|\{v\})\//.test(apiPath)) throw new Error('direct calls only read the REST API');
  const shown = `GET ${apiPath.split('?')[0].replace('{v}', 'N')}`;
  try {
    const conn = await connection(username);
    const url = `${conn.instanceUrl}${apiPath.replace('{v}', conn.getApiVersion())}`;
    const body = await conn.request({ method: 'GET', url });
    logAction('sf-test-bridge (direct read)', shown, { org: username, what, write: false }, true, 'ok');
    return body;
  } catch (e) {
    const msg = scrub(e?.errorCode ? `${e.errorCode}: ${e.message}` : e?.message || e);
    logAction('sf-test-bridge (direct read)', shown, { org: username, what, write: false }, false, msg);
    throw new Error(`direct read failed: ${msg}`);
  }
}
export const get = (username, apiPath, opts) => request('GET', username, apiPath, opts);

// SOQL, with paging (records only)
export async function query(username, soql, { tooling = false, what = 'query' } = {}) {
  let r = await get(username, `/services/data/v{v}/${tooling ? 'tooling/' : ''}query?q=${encodeURIComponent(soql)}`, { what });
  const records = [...(r.records || [])];
  while (r.nextRecordsUrl && records.length < 2000) { r = await get(username, r.nextRecordsUrl.replace(/^\/services\/data\/v[\d.]+/, '/services/data/v{v}'), { what }); records.push(...(r.records || [])); }
  return { records, totalSize: r.totalSize ?? records.length };
}
// one debug log's text
export const logBody = async (username, id) => String(await get(username, `/services/data/v{v}/sobjects/ApexLog/${String(id).replace(/\W/g, '')}/Body`, { what: 'read one debug log' }) ?? '');
