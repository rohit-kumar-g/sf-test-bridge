#!/usr/bin/env node
// Test evidence dashboard (TestRail-style test runs) for the evidence that
// browser_steps and the regression suite store on disk.
//
//   node dashboard/server.js            http://127.0.0.1:17380
//
// BROWSER_BRIDGE_EVIDENCE_DIR  evidence root (default <repo>/evidence)
// BROWSER_BRIDGE_DASHBOARD_PORT  port (default 17380)
//
// Local only: binds 127.0.0.1, checks the Host header, and accepts writes
// (a reviewer's result + comment) only from its own page (Origin check).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.BROWSER_BRIDGE_EVIDENCE_DIR || path.join(HERE, '..', 'evidence'));
const PORT = Number(process.env.BROWSER_BRIDGE_DASHBOARD_PORT || 17380);
const PUBLIC = path.join(HERE, 'public');
const STATUSES = ['passed', 'failed', 'blocked', 'retest', 'untested'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, o) => { const t = `${f}.tmp`; fs.writeFileSync(t, JSON.stringify(o, null, 1)); fs.renameSync(t, f); };
const dirs = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; } };
const SAFE = /^[\w.-]+$/;
// Resolve a path below ROOT from URL segments; null if it escapes or is odd.
function inRoot(...segs) {
  if (!segs.every((s) => SAFE.test(s) && s !== '..' && s !== '.')) return null;
  const p = path.resolve(ROOT, ...segs);
  return p.startsWith(ROOT + path.sep) ? p : null;
}
const effective = (c) => c?.review?.status || c?.status || 'untested';

function runSummary(project, id) {
  const dir = inRoot(project, id);
  const run = dir && readJson(path.join(dir, 'run.json'));
  if (!run) return null;
  const totals = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  let durationMs = 0;
  let lastAt = run.startedAt;
  for (const cid of run.cases || []) {
    const c = readJson(path.join(dir, cid, 'case.json'));
    totals[effective(c)]++;
    durationMs += c?.durationMs || 0;
    if (c?.finishedAt && c.finishedAt > lastAt) lastAt = c.finishedAt;
  }
  return { project, id, title: run.title, description: run.description, startedAt: run.startedAt, finishedAt: run.finishedAt, lastAt, env: run.env, totals, cases: (run.cases || []).length, durationMs };
}

function api(req, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent); // after "api"
  const [what, project, run, kase] = parts;
  if (what === 'health') return { ok: true, root: ROOT };
  if (what === 'runs') {
    // all runs of all projects, newest first
    const out = [];
    for (const p of dirs(ROOT)) for (const r of dirs(path.join(ROOT, p))) { const s = runSummary(p, r); if (s) out.push(s); }
    out.sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
    return { root: ROOT, runs: out };
  }
  if (what === 'run' && project && run) {
    const dir = inRoot(project, run);
    const s = dir && runSummary(project, run);
    if (!s) return null;
    const runJson = readJson(path.join(dir, 'run.json'));
    s.caseList = (runJson.cases || []).map((cid) => {
      const c = readJson(path.join(dir, cid, 'case.json'), { id: cid, title: cid, status: 'untested', steps: [] });
      const failed = (c.steps || []).find((x) => x.status === 'failed');
      return { id: cid, n: c.n, title: c.title, status: effective(c), autoStatus: c.status, reviewed: !!c.review, durationMs: c.durationMs, steps: (c.steps || []).length, failure: failed ? (failed.error || failed.line) : c.note || null, startedAt: c.startedAt };
    });
    return s;
  }
  if (what === 'case' && project && run && kase) {
    const dir = inRoot(project, run, kase);
    const c = dir && readJson(path.join(dir, 'case.json'));
    if (!c) return null;
    return { ...c, effectiveStatus: effective(c), project, run };
  }
  return undefined;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 64 * 1024) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const host = (req.headers.host || '').toLowerCase();
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) { res.writeHead(403).end('forbidden host'); return; }
  const url = new URL(req.url, `http://${host}`);
  const send = (code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  try {
    // reviewer result: POST /api/review/<project>/<run>/<case> {status, comment}
    if (req.method === 'POST') {
      const origin = req.headers.origin || '';
      if (origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) return send(403, { error: 'cross-origin write refused' });
      if (!/application\/json/.test(req.headers['content-type'] || '')) return send(415, { error: 'json only' });
      const [, what, project, run, kase] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (what !== 'review') return send(404, { error: 'not found' });
      const dir = inRoot(project, run, kase);
      const file = dir && path.join(dir, 'case.json');
      const c = file && readJson(file);
      if (!c) return send(404, { error: 'case not found' });
      const body = JSON.parse(await readBody(req) || '{}');
      if (body.status && !STATUSES.includes(body.status)) return send(400, { error: `status must be one of ${STATUSES.join(', ')}` });
      const comment = String(body.comment || '').slice(0, 4000);
      c.reviews = [...(c.reviews || []), { status: body.status || null, comment, at: new Date().toISOString() }];
      if (body.status) c.review = { status: body.status, comment, at: new Date().toISOString() };
      if (body.clear) delete c.review;
      writeJson(file, c);
      return send(200, { ok: true, effectiveStatus: effective(c) });
    }
    if (req.method !== 'GET') return send(405, { error: 'method not allowed' });
    if (url.pathname.startsWith('/api/')) {
      const r = api(req, url);
      return r ? send(200, r) : send(404, { error: 'not found' });
    }
    // evidence files: /files/<project>/<run>/<case>/<file>
    if (url.pathname.startsWith('/files/')) {
      const segs = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent);
      const f = inRoot(...segs);
      if (!f || !/\.(jpe?g|png|json)$/i.test(f) || !fs.existsSync(f)) return send(404, { error: 'not found' });
      return send(200, fs.readFileSync(f), TYPES[path.extname(f).toLowerCase()]);
    }
    // the app
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!SAFE.test(name)) return send(404, 'not found', 'text/plain');
    const f = path.join(PUBLIC, name);
    if (!fs.existsSync(f)) return send(404, 'not found', 'text/plain');
    return send(200, fs.readFileSync(f), TYPES[path.extname(f)] || 'application/octet-stream');
  } catch (e) {
    return send(500, { error: e.message });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.error(`port ${PORT} is in use (dashboard already running?) - open http://127.0.0.1:${PORT}`); process.exit(2); }
  throw e;
});
server.listen(PORT, '127.0.0.1', () => console.log(`evidence dashboard: http://127.0.0.1:${PORT}  (evidence root ${ROOT})`));
