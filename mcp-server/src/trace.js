// Change trace from debug logs only: "what changed, and why".
// Built from real logs of a dev org (runs/20261115_trace): namespaced names,
// before-save flows logged before EXECUTION_STARTED, flow elements logged as
// BEGIN + DEFERRED and then run in bulk, Apex field writes as `this.Field`
// with the record's object address, Trigger.old / new as JSON, the flow's
// $Record as {Field=value, ...}, flow record updates without their values,
// addError without an exception, async work in its own log.
// 1. Find the correct log(s): time window (from the action, or from when
//    logging started, up to when the trace is asked for); a named record's
//    LastModifiedDate pins the save; then a regex search of each log (record
//    id, object, data changes, the developer's own search terms).
// 2. Read them into a timeline and, per record, the fields that changed:
//    old -> new and what set it (flow element, Apex line, workflow rule, or
//    the save itself).
// 3. Point to the correct source file for each step (trigger / class and
//    line with the code, flow and element, validation rule, the LWC that
//    calls the Apex method).
import fs from 'node:fs';
import path from 'node:path';
import { mask } from './apexlog.js';

// ---- 1. the correct log ----

// Standard key prefixes; custom objects need the object name (the record page URL has it).
const KEY_PREFIX = { '001': 'Account', '003': 'Contact', '006': 'Opportunity', '00Q': 'Lead', '500': 'Case', '00T': 'Task', '00U': 'Event', '701': 'Campaign', '800': 'Contract', '801': 'Order', '02i': 'Asset', '005': 'User', '00k': 'OpportunityLineItem' };
export const objectOf = (recordId) => KEY_PREFIX[String(recordId || '').slice(0, 3)] || null;
export const validId = (id) => /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(String(id || ''));
// "/lightning/r/Account/001xx/view" -> { object, recordId }
export function recordFromUrl(url) {
  const m = /\/lightning\/r\/(\w+)\/([a-zA-Z0-9]{15,18})\//.exec(String(url || ''));
  return m ? { object: m[1], recordId: m[2] } : null;
}
// "a, b ,c" or ["a","b"] -> ["a","b","c"] (at most 10, each 2..100 characters)
export function parseTerms(t) {
  const list = Array.isArray(t) ? t : String(t || '').split(',');
  return [...new Set(list.map((x) => String(x).trim()).filter((x) => x.length >= 2 && x.length <= 100))].slice(0, 10);
}

// What kind of request a log is (ApexLog.Operation), in plain words.
export function logKind(op, text) {
  const o = String(op || '');
  if (/DirectSoap/i.test(o)) return 'pre-save check (Lightning runs before-save flows; nothing saved)';
  // an API save writes one log with only the before-save flows, then the save's log (seen in a real org)
  if (text && !/\|CODE_UNIT_STARTED\|/.test(text) && /\|FLOW_START_INTERVIEW_BEGIN\|/.test(text) && !/^N\/A$|Handler|Batch/.test(o)) return 'pre-save check (before-save flows only; the save is in the next log)';
  if (/^\/aura/.test(o)) return 'page request (Lightning)';
  if (/QueueableHandler/.test(o)) return 'async job (Queueable)';
  if (/FutureHandler/.test(o)) return 'async job (@future)';
  if (/Batch/i.test(o)) {
    // seen in a real org: "Batch Apex" for start() and finish(), "SerialBatchApexRangeChunkHandler" per execute() chunk
    const cls = text && /\|CODE_UNIT_STARTED\|\[EXTERNAL\]\|01p\w+\|([\w.]+)/.exec(text)?.[1]?.split('.').pop();
    const step = /RangeChunk/i.test(o) ? 'execute (one chunk)' : text && /Class\.[\w.]*?\.(start|finish):/.exec(text)?.[1] || 'start or finish';
    return `async job (Batch${cls ? ` ${cls}` : ''}: ${step})`;
  }
  if (/^N\/A$/.test(o)) return 'async (flow async path or platform work)';
  // a scheduled flow writes two logs (seen in a real org): the job that picks the records
  // (operation "<flow>-<n>"), then the run (operation "ApexContextImpl") with the flow itself
  if (text && /ProcessType: \w+, Trigger: Scheduled/.test(text)) { const k = /Number of records retrieved in this schedule: (\d+)/.exec(text)?.[1]; return `scheduled flow ${o.replace(/^\w+?__(?=\w+-\d+$)/, '').replace(/-\d+$/, '')}: picks the records${k ? ` (${k})` : ''}; the run is in the next log`; }
  // scheduled Apex: the operation is the job's name; the log sets up a SchedulableContext (seen in a real org)
  if (text && /SchedulableContextImpl\.SchedulableContextImpl\(\)/.test(text)) return `scheduled Apex job "${o.replace(/^\w+\./, '')}"`;
  if (/^Platform Event Process$/i.test(o)) return 'platform event: its flow or trigger (runs as Automated Process)';
  if (/^ApexContextImpl$/.test(o)) { const f = text && /\|FLOW_CREATE_INTERVIEW_END\|[^|]+\|([^\r\n|]+)/.exec(text)?.[1]; return f ? `scheduled or batch run: flow "${f}"` : 'scheduled or batch run'; }
  // REST calls (seen in a real org): /services/data/v68.0/sobjects/Account/<id>, .../actions/custom/flow/<name>
  const flow = /\/actions\/custom\/flow\/(\w+)/.exec(o);
  if (flow) return `API call: runs flow ${flow[1]}`;
  const sob = /\/sobjects\/(\w+)(\/[a-zA-Z0-9]{15,18})?/.exec(o);
  if (sob) return `API call: ${sob[2] ? 'changes' : 'creates'} ${sob[1]}${sob[2] ? ` ${sob[2].slice(1)}` : ''}`;
  if (/\/composite/.test(o)) return 'API call (composite)';
  if (/\/services\/apexrest\//.test(o)) return `API call: Apex REST ${o.replace(/^.*\/services\/apexrest/, '')}`;
  // an Apex REST endpoint logs its URL mapping as the operation ("/ns/bridgetrace"), and sets up a RestRequest
  if (/^\/(?!aura|apex\/|services\/)/.test(o) && text && /RestRequest\.RestRequest\(\)/.test(text)) { const m = /\|CODE_UNIT_STARTED\|\[EXTERNAL\]\|\w+\|(?:\w+\.)?(\w+\.\w+)\(/.exec(text)?.[1]; return `API call: Apex REST ${o}${m ? ` (${m})` : ''}`; }
  if (/^\/apex\//.test(o)) return `Visualforce page ${o.replace(/^\/apex\//, '')}`;
  if (/\/services\/Soap\//i.test(o)) return 'API call (SOAP)';
  if (/^Api$/.test(o)) return 'API call (CLI, anonymous Apex or a tool)';
  if (/services\/data/.test(o)) return 'API call';
  return o || 'request';
}

const SLACK = 2000;
// DurationMilliseconds of async logs is not a duration (hundreds of millions): cap it.
const span = (l) => { const s = Date.parse(l.StartTime); return [s, s + Math.min(Number(l.DurationMilliseconds) || 0, 120_000)]; };
// Logs of the window [fromMs, toMs]. With the record's LastModifiedDate, the
// logs whose request was running at that moment come first ("covers").
export function filterByTime(logs, { fromMs, toMs, modifiedMs }) {
  const inWin = logs.filter((l) => { const [s] = span(l); return s >= fromMs - SLACK && s <= toMs + SLACK; });
  if (!modifiedMs) return { logs: inWin, covers: [] };
  // StartTime has whole seconds; LastModifiedDate too
  const covers = inWin.filter((l) => { const [s, e] = span(l); return modifiedMs >= s - SLACK && modifiedMs <= e + SLACK; });
  return { logs: inWin, covers };
}
// Order to download in: covering logs, then nearest to the action, larger first.
export function scanOrder(logs, { covers = [], aroundMs } = {}) {
  const c = new Set(covers.map((l) => l.Id));
  const near = (l) => (aroundMs ? Math.abs(Date.parse(l.StartTime) - aroundMs) : 0);
  return [...logs].sort((x, y) => (c.has(y.Id) - c.has(x.Id)) || near(x) - near(y) || (y.LogLength || 0) - (x.LogLength || 0));
}

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A search word as a whole word ("Hot" must not match "PhotoUrl"), any case; a
// record id by its first 15 characters (logs show 15 or 18).
export function termRe(t) {
  const s = String(t);
  if (/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(s) && /\d/.test(s) && /[a-zA-Z]/.test(s)) return new RegExp(`(?<![A-Za-z0-9])${esc(s.slice(0, 15))}`, 'i');
  return new RegExp(`${/^\w/.test(s) ? '(?<![A-Za-z0-9_])' : ''}${esc(s)}${/\w$/.test(s) ? '(?![A-Za-z0-9_])' : ''}`, 'i');
}
const CHANGE_EVENTS = {
  dml: /\|DML_BEGIN\|/,
  trigger: / trigger event /,
  flow: /\|FLOW_ASSIGNMENT_DETAIL\||\|FLOW_BULK_ELEMENT_DETAIL\|FlowRecord(Update|Create|Delete)\||\|FLOW_ELEMENT_BEGIN\|/,
  apexWrite: /\|VARIABLE_ASSIGNMENT\|\[\d+\]\|this\.\w+\|/,
  workflow: /\|WF_FIELD_UPDATE\|/,
  validation: /\|VALIDATION_RULE\|/,
  failure: /\|EXCEPTION_THROWN\||\|FATAL_ERROR\||\|VALIDATION_FAIL\||\|FLOW_ELEMENT_ERROR\||SObject\.addError\(/,
};
// Regex search of one log: does it touch the record / object, does it change
// data, does it contain the developer's search terms?
export function scoreLog(text, { recordId, object, terms = [] } = {}) {
  const hits = [];
  let score = 0;
  if (recordId && new RegExp(esc(String(recordId).slice(0, 15))).test(text)) { score += 100; hits.push('record id'); }
  if (object && new RegExp(`Validation:${esc(object)}:|on ${esc(object)} trigger event|Type:${esc(object)}\\b|Flow:${esc(object)}\\b|\\[${esc(object)}: `).test(text)) { score += 30; hits.push(object); }
  for (const [k, re] of Object.entries(CHANGE_EVENTS)) if (re.test(text)) { score += k === 'failure' ? 20 : 10; hits.push(k); }
  const found = [];
  for (const t of terms) {
    const re = termRe(t);
    if (!re.test(text)) continue;
    score += 50; found.push(t);
  }
  const changes = hits.some((h) => h in CHANGE_EVENTS);
  return { score: changes || found.length ? score : 0, hits: [...hits, ...found.map((t) => `"${t}"`)], changes, terms: found };
}
// Where each search term occurs in a log: up to `max` short lines per term.
export function termLines(text, terms, max = 3) {
  const out = {};
  if (!terms?.length) return out;
  const lines = String(text).split(/\r?\n/);
  for (const t of terms) {
    const re = termRe(t);
    const hit = []; const seen = new Set();
    for (const raw of lines) {
      if (!re.test(raw)) continue;
      // "15:15:08.0 (507516839)|EVENT|..." -> "15:15:08 EVENT|...": the nanoseconds look like a phone number to the mask
      const pre = /^(\d\d:\d\d:\d\d)\.\d+ \(\d+\)\|/.exec(raw);
      const l = pre ? raw.slice(pre[0].length) : raw;
      const i = l.search(re);
      // start and end at a separator, not in the middle of a field name or value
      let a = Math.max(0, i - 120); let b = Math.min(l.length, i + t.length + 120);
      if (a > 0) { const m = /[,|{] ?/.exec(l.slice(a, i)); if (m && m.index < 60) a += m.index + m[0].length; }
      if (b < l.length) { const tail = l.slice(i + t.length, b); const k = Math.max(tail.lastIndexOf(', '), tail.lastIndexOf(',"'), tail.lastIndexOf('|')); if (k > tail.length - 60) b = i + t.length + k; }
      const body = `${a > 0 ? '…' : ''}${mask(l.slice(a, b))}${b < l.length ? '…' : ''}`;
      // Salesforce prints the same record snapshot several times: show each text once
      if (seen.has(body)) continue;
      seen.add(body);
      hit.push(`${pre ? `${pre[1]} ` : ''}${body}`);
      if (hit.length >= max) break;
    }
    if (hit.length) out[t] = hit;
  }
  return out;
}
// The chosen log(s): with search terms, the logs that contain them; with a
// record, the ones that mention it; else the ones that change data. In time order.
export function chooseLogs(scored, { recordId, coverIds = [], terms = [], max = 6 } = {}) {
  const c = new Set(coverIds);
  let pool = scored.filter((s) => s.score > 0);
  if (terms.length) pool = pool.filter((s) => s.terms?.length); // the developer's terms filter the logs
  if (recordId) { const withId = pool.filter((s) => s.hits.includes('record id')); if (withId.length) pool = withId; }
  if (!terms.length) pool = pool.filter((s) => s.changes);
  const best = [...pool].sort((x, y) => (c.has(y.Id) - c.has(x.Id)) || y.score - x.score).slice(0, max);
  return best.sort((x, y) => Date.parse(x.StartTime) - Date.parse(y.StartTime) || x.Id.localeCompare(y.Id));
}

// ---- 3. the correct source file ----
const flowBlocks = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);
const tagText = (xml, tag) => (new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml) || [])[1];
export function sourceIndex(root) {
  const idx = { triggers: {}, classes: {}, flows: {}, flowLabels: {}, flowElements: {}, lwcApex: {}, validation: {}, workflow: {}, root };
  if (!root) return idx;
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      let m;
      if ((m = /^(\w+)\.trigger$/.exec(e.name))) idx.triggers[m[1]] = p;
      else if ((m = /^(\w+)\.cls$/.exec(e.name))) idx.classes[m[1]] = p;
      else if ((m = /^(\w+)\.flow-meta\.xml$/.exec(e.name))) {
        idx.flows[m[1]] = p;
        const xml = fs.readFileSync(p, 'utf8');
        // the flow's own label: a <label> directly under <Flow> (one tab / four spaces of indent)
        const lab = /\n {4}<label>([^<]*)<\/label>|\n\t<label>([^<]*)<\/label>/.exec(xml);
        if (lab) idx.flowLabels[(lab[1] ?? lab[2]).trim()] = m[1];
        const start = flowBlocks(xml, 'start')[0];
        if (start && tagText(start, 'object')) (idx.flowObjects ||= {})[m[1]] = tagText(start, 'object');
        // record updates / creates: which fields they set (the log has no values for them)
        const els = {};
        for (const tag of ['recordUpdates', 'recordCreates']) {
          for (const b of flowBlocks(xml, tag)) {
            const name = tagText(b, 'name');
            if (!name) continue;
            els[name] = {
              type: tag, object: tagText(b, 'object'), inputReference: tagText(b, 'inputReference'),
              sets: flowBlocks(b, 'inputAssignments').map((a) => {
                const v = flowBlocks(a, 'value')[0] || '';
                const ref = tagText(v, 'elementReference');
                const lit = tagText(v, 'stringValue') ?? tagText(v, 'numberValue') ?? tagText(v, 'booleanValue');
                return { field: tagText(a, 'field'), ref, literal: lit };
              }),
            };
          }
        }
        idx.flowElements[m[1]] = els;
      } else if ((m = /^(\w+)\.validationRule-meta\.xml$/.exec(e.name))) idx.validation[m[1]] = p;
      else if ((m = /^(\w+)\.workflow-meta\.xml$/.exec(e.name))) idx.workflow[m[1]] = p;
      else if (/\.js$/.test(e.name) && /[\\/]lwc[\\/]/.test(p) && !/__tests__/.test(p)) {
        const src = fs.readFileSync(p, 'utf8');
        for (const im of src.matchAll(/import\s+\w+\s+from\s+['"]@salesforce\/apex\/([\w.]+)['"]/g)) {
          const key = im[1].split('.').slice(-2).join('.'); // without a namespace prefix
          (idx.lwcApex[key] ||= []).push({ lwc: path.basename(path.dirname(p)), file: p });
        }
      }
    }
  }
  return idx;
}
const rel = (idx, p) => (p ? path.relative(idx.root, p).replace(/\\/g, '/') : undefined);
const fileLines = new Map();
const readLines = (file) => { if (!fileLines.has(file)) { try { fileLines.set(file, fs.readFileSync(file, 'utf8').split(/\r?\n/)); } catch { fileLines.set(file, []); } } return fileLines.get(file); };
const lineOf = (file, re) => { const i = readLines(file).findIndex((l) => re.test(l)); return i >= 0 ? i + 1 : undefined; };
const codeAt = (file, line) => (line ? (readLines(file)[line - 1] || '').trim().slice(0, 160) : undefined);
const flowApi = (idx, flow) => (idx.flows[flow] ? flow : idx.flowLabels[flow]);
function locate(idx, step) {
  if (!idx.root) return undefined;
  const at = (file, line) => (file ? { file: rel(idx, file), ...(line ? { line } : {}), ...(line && /\.(cls|trigger)$/.test(file) ? { code: codeAt(file, line) } : {}) } : undefined);
  switch (step.kind) {
    case 'trigger': return at(idx.triggers[step.name], step.line);
    case 'class': case 'action': return at(idx.classes[step.name], step.line);
    case 'flow': case 'flowElement': {
      const f = idx.flows[flowApi(idx, step.flow)];
      return at(f, step.element && f ? lineOf(f, new RegExp(`<name>${esc(step.element)}</name>`)) : undefined);
    }
    case 'validation': return at(idx.validation[step.name]);
    case 'workflow': return at(idx.workflow[step.object], step.rule && idx.workflow[step.object] ? lineOf(idx.workflow[step.object], new RegExp(`<fullName>${esc(step.rule)}</fullName>`)) : undefined);
    default: return undefined;
  }
}
const callers = (idx, cls, method) => (idx.lwcApex[`${cls}.${method}`] || []).map((c) => ({ lwc: c.lwc, file: rel(idx, c.file) }));

// ---- 2. the timeline and the field changes ----
function parseLine(line) {
  const m = /^(\d\d:\d\d:\d\d\.\d+) \((\d+)\)\|([A-Z_]+)\|?(.*)$/.exec(line);
  return m ? { time: m[1], event: m[3], parts: m[4] ? m[4].split('|') : [] } : null;
}
const lineNo = (p) => { const m = /^\[(\d+)\]$/.exec(p || ''); return m ? Number(m[1]) : undefined; };
const lastSeg = (s) => String(s || '').split('.').pop();
// "ns.Class.method(args)" -> { cls, method }
function sig(s) {
  const parts = String(s || '').split('(')[0].split('.');
  return { cls: parts.length >= 2 ? parts[parts.length - 2] : parts[0], method: parts[parts.length - 1] };
}
function unitOf(desc) {
  let m;
  if ((m = /^(?:\w+\.)?(\w+) on (\w+) trigger event (\w+)/.exec(desc))) return { kind: 'trigger', name: m[1], object: m[2], event: m[3] };
  if ((m = /^apex:\/\/(?:\w+\.)?(\w+)\/ACTION\$(\w+)/.exec(desc))) return { kind: 'action', name: m[1], method: m[2] };
  if (/execute_anonymous_apex/.test(desc)) return { kind: 'anonymous', name: 'anonymous Apex' };
  if ((m = /^Validation:(\w+):(\w+)/.exec(desc))) return { kind: 'validations', object: m[1], recordId: m[2] };
  if ((m = /^Workflow:(\w+)/.exec(desc))) return { kind: 'workflows', object: m[1] };
  if ((m = /^Flow:(\w+)/.exec(desc))) return { kind: 'flows', object: m[1] };
  if (/^TRIGGERS$/.test(desc)) return { kind: 'wrapper', name: 'triggers' };
  if (/^DuplicateDetector$/.test(desc)) return { kind: 'duplicates', name: 'Duplicate rules' };
  if (/\(/.test(desc)) { const s = sig(desc); return { kind: 'class', name: s.cls, method: s.method }; }
  if (/^[\w.]+$/.test(desc)) return { kind: 'class', name: lastSeg(desc), async: true }; // a Queueable's execute: "ns.ns.MyQueueable"
  return { kind: 'other', name: desc };
}
const unitLabel = (u) => ({
  trigger: () => `Trigger ${u.name} (${u.object} ${u.event.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()})`,
  action: () => `Apex ${u.name}.${u.method} called from the page (LWC / Aura)`,
  anonymous: () => 'Anonymous Apex',
  validations: () => `Validation rules on ${u.object}`,
  workflows: () => `Workflow on ${u.object}`,
  flows: () => `Record-triggered flows on ${u.object}`,
  duplicates: () => 'Duplicate rules',
  class: () => (u.async ? `Apex ${u.name} (async job)` : `Apex ${u.name}.${u.method}`),
}[u.kind] || (() => u.name))();

const SYSTEM_FIELDS = /^(Id|LastModifiedDate|SystemModstamp|LastModifiedById|LastViewedDate|LastReferencedDate|CreatedDate|CreatedById|IsDeleted|CleanStatus|PhotoUrl|attributes|LastActivityDate)$/;
const FIELD = /^([A-Z]\w*|\w+__c)$/; // sObject field names: Name, Rating, ns__My_Field__c
const TRUNC = / ?\(\d+ more\) \.\.\.$/;
const norm = (v) => {
  if (v === null || v === undefined || v === 'null') return '';
  const s = String(v);
  return /^-?\d+(\.\d+)?$/.test(s) ? String(Number(s)) : s;
};
const same = (a, b) => {
  const x = norm(a); const y = norm(b);
  if (x === y) return true;
  // a cut value "Bridge Trace Acme /  (3 more) ..." is its first characters plus N more:
  // equal only to a value with that start AND that length ("... / Hot", not "... / Warm")
  const cx = cutOf(x); const cy = cutOf(y);
  if (cx && cy) return cx.len === cy.len && (cx.p.startsWith(cy.p) || cy.p.startsWith(cx.p));
  if (cx) return y.startsWith(cx.p) && y.length === cx.len;
  if (cy) return x.startsWith(cy.p) && x.length === cy.len;
  return false;
};
// before / after as shown. Two cut values can read the same ("Synced from account:…")
// while they differ: the log keeps the first characters and says how many more,
// so the lengths tell them apart (seen in a real org: 32 vs 30 characters).
function shownPair(old, final) {
  const after = show(final);
  if (!old) return { after };
  const before = show(old.value);
  if (before !== after) return { before, after };
  const len = (v) => { const s = norm(v); return cutOf(s)?.len ?? s.length; };
  return { before: `${before} (${len(old.value)} characters)`, after: `${after} (${len(final)} characters)`, cut: 'cut in the log: only the start and the length are known' };
}
function cutOf(s) { const m = / ?\((\d+) more\) \.\.\.$/.exec(s); return m ? { p: s.slice(0, m.index), len: m.index + Number(m[1]) } : null; }
const show = (v) => { const s = norm(v); return s === '' ? '(empty)' : mask(s.replace(TRUNC, '…')); };
const jsonValue = (s) => { try { return JSON.parse(s); } catch { return s; } };
// the flow's $Record: {Id=001.., Name=Acme, Rating=Hot, ...}
function parseMapRecord(s) {
  const body = String(s || '').replace(/^\{|\}$/g, '');
  const out = {};
  for (const kv of body.split(/, (?=[A-Za-z][A-Za-z0-9_]*=)/)) { const i = kv.indexOf('='); if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1); }
  return out.Id ? out : null;
}
// records inside an Apex JSON value: an object with Id, a list, or a map Id -> record
// Before / after of a field from full record snapshots with different save times:
// after = the newest snapshot; before = the oldest one, preferably printed once the
// newer state exists (Trigger.old of the after-trigger). Null when the times don't differ.
function stampPair(snaps = [], field) {
  const stamps = [...new Set(snaps.map((s) => s.stamp))].sort();
  if (stamps.length < 2) return null;
  const newest = stamps[stamps.length - 1]; const oldest = stamps[0];
  const lastNew = [...snaps].reverse().find((s) => s.stamp === newest);
  // the before-trigger prints Trigger.new with the old save time too: the old state is only
  // certain once a later save time has shown up (Trigger.old of the first after-trigger)
  const firstLater = snaps.findIndex((s) => s.stamp > oldest);
  const oldSnap = snaps.slice(firstLater).find((s) => s.stamp === oldest);
  const val = (s) => (s.values.has(field) ? s.values.get(field) : null);
  return { ...(oldSnap ? { before: val(oldSnap) } : {}), after: val(lastNew) };
}
function recordsIn(v) {
  if (!v || typeof v !== 'object') return [];
  if (Array.isArray(v)) return v.flatMap(recordsIn);
  if (typeof v.Id === 'string') return [v];
  return Object.values(v).filter((x) => x && typeof x === 'object' && typeof x.Id === 'string');
}

export function traceLog(text, { recordId, idx = sourceIndex(null), maxSteps = 500 } = {}) {
  const steps = [];
  const stack = []; // code units; each has its own method stack
  const flows = {}; // interview id -> flow label
  const elIid = {}; // element name -> interview id (bulk lines have none)
  const flowRec = {}; // interview id -> the $Record id
  const flowVars = {}; // interview id -> { variable: value }
  const pendingUpdate = {}; // flow element -> an update by filter, credited at the element's end
  const addr = {}; // Apex object address -> record id
  const prefixObj = {}; // key prefix -> object (learned from triggers / flows)
  const recs = new Map(); // record id -> { events: Map(field -> [{seq, value, fmt, by, source}]) }
  const counts = { soql: 0, dml: 0, debug: 0 };
  let seq = 0; let lastFlowStep = null; let rule = null; let wfRule = null;
  const id15 = (id) => String(id || '').slice(0, 15);
  const recOf = (id) => { const k = id15(id); if (!recs.has(k)) recs.set(k, { id, events: new Map() }); const r = recs.get(k); if (String(id).length > r.id.length) r.id = id; return r; };
  const event = (id, field, value, fmt, extra = {}) => {
    if (!id || SYSTEM_FIELDS.test(field)) return;
    const r = recOf(id);
    if (!r.events.has(field)) r.events.set(field, []);
    r.events.get(field).push({ seq: ++seq, value, fmt, ...extra });
  };
  const snapshot = (rec, fmt) => {
    // a full record snapshot (Trigger.new / old) carries its own save time; Apex leaves out
    // empty fields, so a field missing from it was empty (seen live: Parent Account set from empty)
    const stamp = fmt === 'json' && rec.Id && (rec.SystemModstamp || rec.LastModifiedDate);
    if (stamp) (recOf(rec.Id).snaps ||= []).push({ stamp, values: new Map(Object.entries(rec).filter(([k, v]) => k !== 'Id' && (v === null || typeof v !== 'object'))) });
    for (const [k, v] of Object.entries(rec)) if (k !== 'Id' && (v === null || typeof v !== 'object')) event(rec.Id, k, v, fmt);
  };
  const add = (s) => {
    const step = { depth: stack.length, ...s };
    if (!step.source) { const loc = locate(idx, step); if (loc) step.source = loc; }
    steps.push(step); return step;
  };
  const top = () => stack[stack.length - 1];
  // where Apex code is running now: the innermost user method, else the trigger / class
  const here = (line) => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const u = stack[i];
      if (u.methods.length) { const m = u.methods[u.methods.length - 1]; return { kind: 'class', name: m.cls, line }; }
      if (u.kind === 'trigger') return { kind: 'trigger', name: u.name, line };
      if (u.kind === 'class' || u.kind === 'action') return { kind: 'class', name: u.name, line };
      if (u.kind === 'anonymous') return { kind: 'anonymous', name: 'anonymous Apex', line };
    }
    return null;
  };
  const whereText = (h) => (h ? `${h.kind === 'trigger' ? 'trigger' : 'Apex'} ${h.name}${h.line ? ` line ${h.line}` : ''}` : 'Apex');
  // key prefix -> object, only from reliable places: the first records a trigger
  // sees (Trigger.new), a record-triggered flow's $Record
  const learnPrefix = (id, object) => { if (id && object) prefixObj[String(id).slice(0, 3)] ||= object; };
  const flowObject = (iid) => idx.flowObjects?.[flowApi(idx, flows[iid])] || [...stack].reverse().find((x) => x.kind === 'flows')?.object;
  let failed = null; // the transaction failed: its changes were rolled back

  for (const raw of String(text).split(/\r?\n/)) {
    const l = parseLine(raw);
    if (!l) continue;
    const p = l.parts;
    switch (l.event) {
      case 'CODE_UNIT_STARTED': {
        // the descriptive part: not the line marker, the 15/18-character id (has digits) or the internal path
        const desc = p.filter((x) => x && !/^\[.*\]$/.test(x) && !/^__sfdc_/.test(x) && !(/^[a-zA-Z0-9]{15,18}$/.test(x) && /\d/.test(x))).shift() || '';
        const u = { ...unitOf(desc), methods: [], learn: true };
        if (u.kind !== 'wrapper') {
          const st = add({ time: l.time, kind: u.kind, name: u.name, method: u.method, object: u.object, text: unitLabel(u) });
          if (u.kind === 'action') { const c = callers(idx, u.name, u.method); if (c.length) st.calledBy = c; }
        }
        stack.push(u);
        break;
      }
      case 'CODE_UNIT_FINISHED': stack.pop(); break;
      case 'METHOD_ENTRY': {
        const s = sig(p[2] || p[1]);
        const u = top(); if (!u) break;
        const callSite = here(lineNo(p[0]));
        u.methods.push(s);
        if (s.cls !== s.method && /^01p/.test(p[1] || '')) add({ time: l.time, kind: 'call', text: `calls ${s.cls}.${s.method}`, source: locate(idx, { kind: 'class', name: s.cls }), ...(callSite ? { from: whereText(callSite) } : {}) });
        break;
      }
      case 'METHOD_EXIT': { const u = top(); if (u?.methods.length) u.methods.pop(); break; }
      case 'SYSTEM_METHOD_ENTRY': {
        if (/SObject\.addError\(/.test(p[1] || '')) {
          const h = here(lineNo(p[0]));
          failed ||= `addError in ${whereText(h)}`;
          add({ time: l.time, kind: 'error', text: `addError: the save is stopped by ${whereText(h)} (the message is shown to the user, not logged)`, source: h ? locate(idx, h) : undefined });
        } else if (/System\.enqueueJob\(/.test(p[1] || '')) {
          const h = here(lineNo(p[0]));
          add({ time: l.time, kind: 'async', text: `queues an async job (its changes are in a later log)`, source: h ? locate(idx, h) : undefined });
        } else if (/Database\.executeBatch|System\.schedule\(/.test(p[1] || '')) {
          add({ time: l.time, kind: 'async', text: `starts async work: ${p[1]}` });
        }
        break;
      }
      case 'FLOW_CREATE_INTERVIEW_END': { const [iid, label] = p; if (iid && label) flows[iid] = label; break; }
      case 'FLOW_START_INTERVIEW_BEGIN': {
        const [iid, label] = p; if (iid && label) flows[iid] = label;
        add({ time: l.time, kind: 'flow', flow: label, text: `Flow "${label}"` });
        break;
      }
      case 'FLOW_ELEMENT_BEGIN': case 'FLOW_BULK_ELEMENT_BEGIN': {
        const k = p.findIndex((x) => /^Flow[A-Z]\w+$/.test(x));
        if (k < 0) break;
        const element = p[k + 1];
        const iid = l.event === 'FLOW_ELEMENT_BEGIN' ? p[0] : elIid[element];
        if (l.event === 'FLOW_ELEMENT_BEGIN') elIid[element] = iid;
        lastFlowStep = add({ time: l.time, kind: 'flowElement', flow: flows[iid], element, type: p[k].replace(/^Flow/, ''), iid, text: `${p[k].replace(/^Flow/, '').replace(/([a-z])([A-Z])/g, '$1 $2')} "${element}"` });
        break;
      }
      case 'FLOW_ELEMENT_DEFERRED': {
        // run later in bulk: the BULK lines are the real run; drop this placeholder
        const i = steps.length - 1;
        if (steps[i]?.kind === 'flowElement' && steps[i].element === p[1]) steps.pop();
        break;
      }
      case 'FLOW_RULE_DETAIL': {
        const [iid, ruleName, result] = p;
        if (result === 'true') { const s = [...steps].reverse().find((x) => x.kind === 'flowElement' && x.iid === iid) || lastFlowStep; if (s) s.text += ` -> outcome "${ruleName}"`; }
        break;
      }
      case 'FLOW_VALUE_ASSIGNMENT': {
        const [iid, name, value] = p;
        if (name === '$Record') { const rec = parseMapRecord(value); if (rec) { flowRec[iid] = rec.Id; learnPrefix(rec.Id, flowObject(iid)); snapshot(rec, 'map'); } break; }
        (flowVars[iid] ||= {})[name] = value;
        break;
      }
      case 'FLOW_ASSIGNMENT_DETAIL': {
        const [iid, ref, , val] = p;
        const r = String(ref || '').replace(/^\{!|\}$/g, '');
        const m = /^(\$Record|\w+)\.(\w+)$/.exec(r);
        const by = `flow "${flows[iid]}" element "${curElement(steps, iid)}"`;
        const s = add({ time: l.time, kind: 'assign', flow: flows[iid], element: curElement(steps, iid), text: `${r} = ${mask(val ?? '')}` });
        s.source = locate(idx, { kind: 'flowElement', flow: flows[iid], element: curElement(steps, iid) });
        if (m && m[1] === '$Record' && flowRec[iid]) event(flowRec[iid], m[2], val, 'write', { by, source: s.source });
        else if (!m) (flowVars[iid] ||= {})[r] = val;
        break;
      }
      case 'FLOW_BULK_ELEMENT_DETAIL': {
        // FlowRecordUpdate|Update_X|rows: the log has no field values; the flow file has the fields
        const [type, element, rows] = p;
        const s = [...steps].reverse().find((x) => x.kind === 'flowElement' && x.element === element);
        if (s) s.text += ` (${rows} record${rows === '1' ? '' : 's'})`;
        if (!/^FlowRecord(Update|Create)$/.test(type)) break;
        const iid = elIid[element];
        const def = idx.flowElements[flowApi(idx, flows[iid])]?.[element];
        if (!def) { if (s) s.text += ' [fields: see the flow]'; break; }
        const val = (a) => (a.ref ? (flowVars[iid]?.[a.ref] ?? `{!${a.ref}}`) : a.literal ?? '');
        const target = def.inputReference === '$Record' ? `${prefixObj[String(flowRec[iid]).slice(0, 3)] || 'the record'} (this record)` : def.object || def.inputReference;
        if (s) s.text += `: sets ${def.sets.map((a) => `${a.field} = ${mask(String(val(a)))}`).join(', ')} on ${target}`;
        if (def.inputReference === '$Record' && flowRec[iid]) {
          for (const a of def.sets) event(flowRec[iid], a.field, val(a), 'write', { by: `flow "${flows[iid]}" element "${element}"`, source: s?.source });
        } else if (type === 'FlowRecordUpdate' && def.sets.length) {
          // an update by filter (an autolaunched flow called with a record id): the records are
          // known only once their save ran inside the element, so credit them at its end
          pendingUpdate[element] = { iid, def, val, from: seq, by: `flow "${flows[iid]}" element "${element}"`, source: s?.source };
        }
        break;
      }
      case 'FLOW_BULK_ELEMENT_END': {
        const [type, element] = p;
        const pu = type === 'FlowRecordUpdate' && pendingUpdate[element];
        if (!pu) break;
        delete pendingUpdate[element];
        // the records saved inside the element (their trigger snapshots), else the id the flow got
        let ids = [...recs.values()].filter((r) => [...r.events.values()].some((evs) => evs.some((e) => e.seq > pu.from && e.fmt === 'json'))).map((r) => r.id)
          .filter((id) => !pu.def.object || !prefixObj[id.slice(0, 3)] || prefixObj[id.slice(0, 3)] === pu.def.object);
        if (!ids.length) ids = Object.values(flowVars[pu.iid] || {}).filter((v) => /^[a-zA-Z0-9]{15,18}$/.test(v) && /\d/.test(v) && /[a-zA-Z]/.test(v));
        for (const id of ids) {
          if (pu.def.object) learnPrefix(id, pu.def.object);
          const r = recs.get(id15(id));
          for (const a of pu.def.sets) {
            const v = pu.val(a);
            const lastSeen = [...(r?.events.get(a.field) || [])].reverse().find((e) => e.fmt === 'json');
            // a trigger may have changed it again inside the save: credit the flow only for its own value
            if (lastSeen && !String(v).startsWith('{!') && !same(lastSeen.value, v)) continue;
            event(id, a.field, String(v).startsWith('{!') && lastSeen ? lastSeen.value : v, 'write', { by: pu.by, source: pu.source });
          }
        }
        break;
      }
      case 'FLOW_ACTIONCALL_DETAIL': {
        const [iid, element, kind, name] = p;
        const s = [...steps].reverse().find((x) => x.kind === 'flowElement' && x.element === element);
        if (s && !s.calls) { s.calls = name; s.text += ` -> calls ${kind} ${name}`; }
        void iid;
        break;
      }
      case 'FLOW_ELEMENT_ERROR': case 'FLOW_ELEMENT_FAULT': case 'FLOW_CREATE_INTERVIEW_ERROR': case 'FLOW_START_INTERVIEWS_ERROR':
        failed ||= `flow error in "${lastFlowStep?.flow || '?'}"`;
        add({ time: l.time, kind: 'error', text: `Flow error: ${mask(p.join('|').replace(/<[^>]+>/g, '').replace(/You can look up ExceptionCode.*$/, '').trim()).slice(0, 400)}`, ...(lastFlowStep?.source ? { source: lastFlowStep.source } : {}) });
        break;
      case 'VALIDATION_RULE': rule = p[1] || p[0]; break;
      case 'VALIDATION_PASS': case 'VALIDATION_FAIL': add({ time: l.time, kind: 'validation', name: rule, text: `Validation rule ${rule}: ${l.event === 'VALIDATION_PASS' ? 'passed' : 'FAILED'}` }); break;
      case 'WF_CRITERIA_BEGIN': wfRule = p[1]; break;
      case 'WF_FIELD_UPDATE': {
        const all = p.join('|');
        const field = /Field:(\w+): ?(\w+)/.exec(all);
        const value = (/Value:([^|]*)/.exec(all) || [])[1] || '';
        const ruleName = (/CurrentRule:(.*?) \(Id=/.exec(all) || [])[1] || wfRule;
        const rec = (/\[\w+: .* ([a-zA-Z0-9]{15,18})\]/.exec(p[0]) || [])[1];
        const s = add({ time: l.time, kind: 'workflow', object: field?.[1], rule: ruleName, text: `Workflow field update (rule "${ruleName}"): ${field?.[2]} = ${mask(value)}` });
        if (field && rec) { prefixObj[rec.slice(0, 3)] ||= field[1]; event(rec, field[2], value, 'write', { by: `workflow rule "${ruleName}"`, source: s.source }); }
        break;
      }
      case 'DML_BEGIN': {
        counts.dml++;
        const h = here(lineNo(p[0]));
        add({ time: l.time, kind: 'dml', text: `DML ${(p[1] || '').replace('Op:', '').toLowerCase()} ${(p[2] || '').replace('Type:', '')} (${(p[3] || '').replace('Rows:', '')} rows)`, ...(h ? { source: locate(idx, h) } : {}) });
        break;
      }
      case 'SOQL_EXECUTE_BEGIN': counts.soql++; break;
      case 'VARIABLE_ASSIGNMENT': {
        const [ln, name, val, address] = p;
        if (!name || name === 'this') break;
        const v = jsonValue(val);
        // record snapshots (Trigger.new / old, query results, loop variables)
        const rs = recordsIn(v);
        if (rs.length) {
          const u = top();
          if (u?.kind === 'trigger' && u.learn) { for (const r of rs) learnPrefix(r.Id, u.object); u.learn = false; }
          for (const r of rs) snapshot(r, 'json'); if (rs.length === 1 && v && !Array.isArray(v) && v.Id && address) addr[address] = v.Id; break; }
        const m = /^(\w+)\.(\w+)$/.exec(name);
        if (!m) break;
        const rid = address ? addr[address] : undefined;
        if (!rid && !FIELD.test(m[2])) break; // a member of an Apex object, not a record field
        const h = here(lineNo(ln));
        const where = h ? locate(idx, h) : undefined;
        const s = add({ time: l.time, kind: 'assign', text: `${rid ? `${prefixObj[rid.slice(0, 3)] || 'record'} ${rid}` : m[1]}.${m[2]} = ${show(v)}`, ...(where ? { source: where } : {}) });
        if (rid) event(rid, m[2], v, 'write', { by: whereText(h), source: s.source });
        break;
      }
      case 'USER_DEBUG': counts.debug++; add({ time: l.time, kind: 'debug', text: `debug: ${mask(p.slice(2).join('|')).slice(0, 200)}`, ...(here(lineNo(p[0])) ? { source: locate(idx, here(lineNo(p[0]))) } : {}) }); break;
      case 'EXCEPTION_THROWN': { const h = here(lineNo(p[0])); add({ time: l.time, kind: 'error', text: `Exception: ${mask(p.slice(1).join('|')).slice(0, 300)}`, ...(h ? { source: locate(idx, h) } : {}) }); break; }
      case 'FATAL_ERROR': failed ||= 'unhandled Apex error'; add({ time: l.time, kind: 'error', text: `Fatal error: ${mask(p.join('|')).slice(0, 300)}` }); break;
      default: break;
    }
  }

  // per record and field: old -> new, and what set it last
  const records = [];
  for (const r of recs.values()) {
    const fields = [];
    for (const [field, evs] of r.events) {
      const writes = evs.filter((e) => e.fmt === 'write');
      // compare like with like: Apex JSON snapshots, else the flow's map, plus writes
      const fmt = evs.some((e) => e.fmt === 'json') ? 'json' : 'map';
      const seen = evs.filter((e) => e.fmt === fmt || e.fmt === 'write');
      if (!seen.length) continue;
      // the saved state and the one before it, from the snapshots' save times: Trigger.new and
      // Trigger.old are printed in whatever order the code assigns them
      const pair = stampPair(r.snaps, field);
      let final = pair ? pair.after : seen[seen.length - 1].value;
      // the log cuts long strings in snapshots; a write may have the full value
      // (the flow's $Record keeps full values): use the latest full one that matches
      if (TRUNC.test(norm(final))) { const full = [...evs].reverse().find((w) => same(w.value, final) && !TRUNC.test(norm(w.value))); if (full) final = full.value; }
      // the value before: a snapshot that is neither the final value nor one written earlier in the
      // log (a scheduled flow sets the field, then Trigger.new shows that value before Trigger.old)
      let old = pair && 'before' in pair ? (same(pair.before, final) ? undefined : { value: pair.before, fmt: 'json', seq: 0 })
        : seen.find((e, i) => e.fmt !== 'write' && !same(e.value, final) && !seen.slice(0, i).some((w) => w.fmt === 'write' && same(w.value, e.value)))
        || seen.find((e) => !same(e.value, final));
      // cut in the snapshot: the full value from another place of the log (the flow's $Record map)
      if (old && TRUNC.test(norm(old.value))) { const full = evs.find((e) => !TRUNC.test(norm(e.value)) && same(e.value, old.value)); if (full) old = full; }
      // a field only automation set: its value before, from the flow's $Record (Apex JSON leaves out empty fields)
      if (!old && writes.length && fmt === 'json') old = evs.find((e) => e.fmt === 'map' && e.seq < writes[0].seq && !same(e.value, final));
      if (!old && !writes.length) continue;
      const last = writes[writes.length - 1];
      fields.push({
        field, ...shownPair(old, final),
        by: last ? last.by : 'the save itself (user input or the calling code)',
        ...(last?.source ? { source: last.source } : {}),
        ...(writes.length > 1 ? { earlier: writes.slice(0, -1).filter((w) => !same(w.value, final)).map((w) => `${show(w.value)} (${w.by})`) } : {}),
        ...(TRUNC.test(norm(final)) ? { note: 'value cut in the log' } : {}),
        // "no change" only when no value was cut in the log (cut values can't be compared), and not after a write:
        // record snapshots leave out empty fields, so a value only seen after a write may have been empty before
        ...(!old && evs[0].fmt !== 'write' && !seen.some((e) => TRUNC.test(norm(e.value))) ? { unchanged: true } : {}),
        ...(!old && seen.some((e) => TRUNC.test(norm(e.value))) ? { note: 'value cut in the log: the value before is not known' } : {}),
      });
    }
    for (const f of fields) if (f.earlier && !f.earlier.length) delete f.earlier;
    if (fields.length) records.push({ id: r.id, object: prefixObj[r.id.slice(0, 3)] || objectOf(r.id) || undefined, investigated: !!recordId && id15(recordId) === id15(r.id), ...(failed ? { notSaved: failed } : {}), fields });
  }
  records.sort((a, b) => b.investigated - a.investigated);
  const files = [...new Set(steps.flatMap((s) => [s.source?.file, ...(s.calledBy || []).map((c) => c.file)]).filter(Boolean))];
  // first line: "68.0 APEX_CODE,FINEST;...": logs from `sf apex run` use the CLI's lower levels
  const header = /^\d+\.\d+ (.*)$/m.exec(String(text).slice(0, 300))?.[1] || '';
  const lowDetail = header && !/APEX_CODE,FINEST/.test(header) ? `written at lower detail (${header.slice(0, 60)}): field values are not in it` : undefined;
  return { steps: steps.slice(0, maxSteps), stepsTotal: steps.length, records, counts, files, truncated: /MAXIMUM DEBUG LOG SIZE REACHED/.test(text), ...(failed ? { failed } : {}), ...(lowDetail ? { lowDetail } : {}) };
}
function curElement(steps, iid) {
  const s = [...steps].reverse().find((x) => x.kind === 'flowElement' && x.iid === iid) || [...steps].reverse().find((x) => x.kind === 'flowElement');
  return s?.element;
}

// ---- output ----
const where = (s) => (s?.file ? `${s.file}${s.line ? `:${s.line}` : ''}` : '');
export const changeLine = (rec, c) => `${rec.notSaved ? 'NOT SAVED (rolled back): ' : ''}${rec.object || 'record'} ${rec.id} ${c.field}: ${c.before !== undefined ? `${c.before} -> ` : ''}${c.after}${c.unchanged ? ' (no change)' : ''}, by ${c.by}${c.source?.file ? ` (${where(c.source)})` : ''}${c.earlier?.length ? `; earlier: ${c.earlier.join('; ')}` : ''}${c.note && /set back/.test(c.note) ? ` (${c.note})` : ''}${c.cut ? ` (${c.cut})` : ''}`;
export function renderTrace(t) {
  const out = ['# Change trace', '', `- When: ${t.window.from} to ${t.window.to}`];
  if (t.record) out.push(`- Record: ${t.record.object || '?'} ${t.record.recordId}${t.record.lastModified ? ` (last modified ${t.record.lastModified})` : ''}`);
  if (t.terms?.length) out.push(`- Search terms: ${t.terms.join(', ')}`);
  out.push(`- Logs in the window: ${t.window.logs}; searched: ${t.window.searched}${t.window.skipped ? `; not searched: ${t.window.skipped}` : ''}; chosen: ${t.logs.length}`);
  for (const l of t.logs) out.push(`  - ${l.Id}: ${l.kind}, ${l.StartTime} (${l.why})`);
  out.push('');
  out.push('## What changed', '');
  if (!t.records.length) out.push('No field changes found in the chosen logs.', '');
  for (const r of t.records) {
    out.push(`### ${r.object || 'Record'} ${r.id}${r.investigated ? ' (the record you asked about)' : ''}`, '');
    if (r.notSaved) out.push(`**Not saved: the transaction failed (${r.notSaved}); these changes were rolled back.**`, '');
    out.push('| Field | Before | After | Changed by | Source |', '|---|---|---|---|---|');
    for (const c of r.fields) out.push(`| ${c.field} | ${(c.before ?? '').replace(/\|/g, '\\|')} | ${String(c.after).replace(/\|/g, '\\|')}${c.unchanged ? ' (no change)' : ''} | ${c.by}${c.earlier ? ` (earlier: ${c.earlier.join('; ')})` : ''}${c.note ? ` (${c.note})` : ''}${c.cut ? ` (${c.cut})` : ''} | ${where(c.source)}${c.source?.code ? ` \`${c.source.code}\`` : ''} |`);
    out.push('');
  }
  if (t.termLines && Object.keys(t.termLines).length) {
    out.push('## Where the search terms appear', '');
    for (const [term, byLog] of Object.entries(t.termLines)) for (const [log, lines] of Object.entries(byLog)) for (const x of lines) out.push(`- "${term}" in ${log}: \`${x.replace(/`/g, "'")}\``);
    out.push('');
  }
  out.push('## Timeline', '');
  for (const s of t.steps) {
    const extra = [where(s.source), s.from ? `from ${s.from}` : '', ...(s.calledBy || []).map((c) => `called by LWC ${c.lwc} (${c.file})`)].filter(Boolean).join('; ');
    out.push(`${'  '.repeat(s.depth)}- ${s.time ? `${s.time} ` : ''}${s.text}${extra ? `  [${extra}]` : ''}`);
  }
  if (t.stepsTotal > t.steps.length) out.push(`- … ${t.stepsTotal - t.steps.length} more steps (see the log files)`);
  out.push('', `SOQL: ${t.counts.soql}, DML: ${t.counts.dml}, debug lines: ${t.counts.debug}${t.truncated ? '. A log was cut at 20 MB.' : ''}`);
  if (t.files.length) out.push('', '## Source files', '', ...t.files.map((f) => `- ${f}`));
  if (t.notes?.length) out.push('', '## Notes', '', ...t.notes.map((n) => `- ${n}`));
  return out.join('\n') + '\n';
}
