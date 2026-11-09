// Test evidence store: annotated screenshots + step results on disk, for the
// dashboard (dashboard/server.js). Claude only ever gets file paths back.
//
// <root>/<project>/<run>/run.json
//                       /<NN>_<case-slug>/case.json
//                       /<NN>_<case-slug>/<SS>_<status>.jpg   (and <SS>_<status>_detail.jpg on failure)
//
// root:    BROWSER_BRIDGE_EVIDENCE_DIR, default <repo>/evidence
// project: who/what is tested (default "default"); run: one test run (many cases)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EVIDENCE_ROOT = path.resolve(process.env.BROWSER_BRIDGE_EVIDENCE_DIR || path.join(REPO, 'evidence'));
// steps (default): capture after every step + a detail shot on failure;
// failures: only failing steps (and steps with evidence: true); off: nothing.
export const EVIDENCE_MODE = (process.env.BROWSER_BRIDGE_EVIDENCE || 'steps').toLowerCase();

export const slug = (s, max = 60) => String(s || '').normalize('NFKD').replace(/[^\w\s-]/g, '').trim()
  .replace(/[\s_]+/g, '-').replace(/-+/g, '-').toLowerCase().slice(0, max).replace(/-$/, '') || 'x';
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15); // 20261106_083015
const pad = (n, w = 2) => String(n).padStart(w, '0');

function writeJson(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, file);
}
const readJson = (file, dflt = null) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; } };

// Effective status of a case: a reviewer's manual result wins over the automatic one.
export const caseStatus = (c) => c.review?.status || c.status;

export class EvidenceRun {
  // Open (or continue) a run. `run` is a name or id; the same name within a
  // project continues the same folder, so several browser_steps calls (one per
  // test case) build up one test run. No name: one ad-hoc run per day.
  static open({ root = EVIDENCE_ROOT, project = 'default', run, title, description, env } = {}) {
    const projDir = path.join(root, slug(project));
    fs.mkdirSync(projDir, { recursive: true });
    const id = run ? slug(run, 80) : `adhoc-${stamp().slice(0, 8)}`;
    const dir = path.join(projDir, id);
    const file = path.join(dir, 'run.json');
    let data = readJson(file);
    if (!data) {
      fs.mkdirSync(dir, { recursive: true });
      data = {
        id, project: slug(project), title: title || run || `Ad-hoc run ${stamp().slice(0, 8)}`, description: description || '',
        startedAt: new Date().toISOString(), finishedAt: null, env: env || {}, cases: [], totals: {},
      };
      writeJson(file, data);
    }
    return new EvidenceRun(dir, file, data);
  }

  constructor(dir, file, data) { this.dir = dir; this.file = file; this.data = data; }

  save() {
    // totals from the cases' effective status
    const totals = { passed: 0, failed: 0, blocked: 0, retest: 0, untested: 0 };
    for (const cid of this.data.cases) {
      const c = readJson(path.join(this.dir, cid, 'case.json'));
      const st = c ? caseStatus(c) : 'untested';
      totals[st] = (totals[st] || 0) + 1;
    }
    this.data.totals = totals;
    writeJson(this.file, this.data);
  }

  startCase(title, extra = {}) {
    this.data = readJson(this.file, this.data); // another process may have added cases
    const n = this.data.cases.length + 1;
    const id = `${pad(n, 3)}_${slug(title)}`;
    const dir = path.join(this.dir, id);
    fs.mkdirSync(dir, { recursive: true });
    this.data.cases.push(id);
    const c = new EvidenceCase(this, id, dir, { id, n, title, status: 'untested', startedAt: new Date().toISOString(), durationMs: null, steps: [], ...extra });
    c.save();
    this.save();
    return c;
  }

  // The case with this title in the run (created if missing): for ad-hoc
  // captures that should land in the same case across several tool calls.
  caseNamed(title) {
    this.data = readJson(this.file, this.data);
    for (const id of this.data.cases) {
      const dir = path.join(this.dir, id);
      const c = readJson(path.join(dir, 'case.json'));
      if (c && c.title === title) return new EvidenceCase(this, id, dir, c);
    }
    return this.startCase(title);
  }

  finish() {
    this.data = readJson(this.file, this.data);
    this.data.finishedAt = new Date().toISOString();
    this.save();
  }
}

export class EvidenceCase {
  constructor(run, id, dir, data) { this.run = run; this.id = id; this.dir = dir; this.data = data; this.t0 = Date.now(); }

  save() { writeJson(path.join(this.dir, 'case.json'), this.data); }

  // Ask the extension for an annotated screenshot and store it. Returns the
  // path relative to the run folder, or null (never throws: evidence must not
  // fail a test).
  async capture(request, { n, status, caption, detail = false, tabId }) {
    try {
      const r = await request('evidenceShot', { tabId, caption, status, detail }, 30_000);
      if (!r?.image) return null;
      const ext = r.mimeType === 'image/png' ? 'png' : 'jpg';
      const name = `${pad(n)}_${slug(status || 'step', 10)}${detail ? '_detail' : ''}.${ext}`;
      fs.writeFileSync(path.join(this.dir, name), Buffer.from(r.image, 'base64'));
      return { file: name, url: r.url, marked: r.marked };
    } catch (e) {
      return { error: e.message };
    }
  }

  addStep(step) {
    this.data.steps.push(step);
    this.save();
  }

  finish(status, note) {
    this.data.status = status;
    if (note) this.data.note = note;
    this.data.finishedAt = new Date().toISOString();
    this.data.durationMs = Date.now() - this.t0;
    this.save();
    this.run.save();
  }
}

// All runs (newest first) with their totals, for a short text listing.
export function listRuns(root = EVIDENCE_ROOT, limit = 20) {
  const out = [];
  const sub = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; } };
  for (const p of sub(root)) {
    for (const r of sub(path.join(root, p))) {
      const run = readJson(path.join(root, p, r, 'run.json'));
      if (run) out.push({ project: p, id: r, title: run.title, startedAt: run.startedAt, finishedAt: run.finishedAt, totals: run.totals, cases: run.cases.length });
    }
  }
  return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, limit);
}

// Relative path of a stored file, from the evidence root (for messages).
export const shown = (c, file = '') => path.join(EVIDENCE_ROOT, path.relative(EVIDENCE_ROOT, c.dir), file).replace(/\\/g, '/');
