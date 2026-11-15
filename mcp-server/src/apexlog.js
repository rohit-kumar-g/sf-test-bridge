// Phase 4: read Apex debug logs into what a developer needs to find the cause:
// the failure (exception, fatal error, validation failure, flow error), where
// it happened (code unit, line; matched to the local source), USER_DEBUG
// lines, the SOQL / DML and variable values close to the failure. Emails and
// phone numbers are masked in what goes to Claude.
import fs from 'node:fs';
import path from 'node:path';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?<![\w.])\+?\d[\d\s().-]{7,}\d(?![\w.])/g;
const DATE = /^\d{4}-\d\d-\d\d|^\d\d?[/.-]\d\d?[/.-]\d{4}$/; // dates and timestamps are not phone numbers
// IP addresses: an Apex REST log holds the caller's address and X-Forwarded-For (seen in a real org)
const IPV4 = /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?::\d{1,5})?(?![\w.])/g;
export const mask = (s) => String(s).replace(EMAIL, '<email>').replace(IPV4, '<ip>').replace(PHONE, (m) => (m.replace(/\D/g, '').length >= 8 && !DATE.test(m.trim()) && !/^-?\d+\.\d+$/.test(m.trim()) ? '<phone>' : m));

// one log line: "12:00:00.123 (123456)|EVENT|a|b|c"
function parseLine(line) {
  const m = /^(\d\d:\d\d:\d\d\.\d+) \((\d+)\)\|([A-Z_]+)\|?(.*)$/.exec(line);
  if (!m) return null;
  return { time: m[1], event: m[3], parts: m[4] ? m[4].split('|') : [] };
}
const lineNo = (p) => { const m = /^\[(\d+|EXTERNAL)\]$/.exec(p || ''); return m && m[1] !== 'EXTERNAL' ? Number(m[1]) : null; };

// Code unit names in logs: "MyTrigger on Account trigger event BeforeInsert",
// "MyClass.myMethod(...)", "execute_anonymous_apex", "Validation:Account:...", "Flow:Account"
function unitName(s) {
  const t = /^(\w+) on (\w+) trigger event (\w+)/.exec(s);
  if (t) return { kind: 'trigger', name: t[1], object: t[2], event: t[3] };
  if (/execute_anonymous_apex/.test(s)) return { kind: 'anonymous', name: 'anonymous Apex' };
  const v = /^Validation:(\w+):(\w+)/.exec(s);
  if (v) return { kind: 'validation', name: v[0], object: v[1] };
  const c = /^(\w+)\.(\w+)/.exec(s);
  if (c) return { kind: 'class', name: c[1], method: c[2] };
  return { kind: 'other', name: s };
}

export function analyzeLog(text, { source } = {}) {
  const lines = String(text).split(/\r?\n/);
  const out = { units: [], debug: [], failures: [], queries: 0, dml: [], truncated: /MAXIMUM DEBUG LOG SIZE REACHED/.test(text) };
  const stack = [];
  const recent = []; // last statements / variables before a failure
  const remember = (s) => { recent.push(s); if (recent.length > 12) recent.shift(); };
  for (const raw of lines) {
    const l = parseLine(raw);
    if (!l) continue;
    const [p0, p1, p2] = l.parts;
    const unit = () => stack[stack.length - 1];
    switch (l.event) {
      case 'CODE_UNIT_STARTED': {
        // "[EXTERNAL]|01q...|OppTrigger on Opportunity trigger event BeforeInsert|__sfdc_trigger/OppTrigger":
        // the descriptive part, not the line marker, the id or the internal path
        const desc = l.parts.filter((x) => x && !/^\[.*\]$/.test(x) && !/^__sfdc_/.test(x) && !/^[a-zA-Z0-9]{15,18}$/.test(x)).shift() || '';
        const u = unitName(desc);
        stack.push(u); out.units.push(u);
        break;
      }
      case 'CODE_UNIT_FINISHED': stack.pop(); break;
      case 'USER_DEBUG': out.debug.push({ unit: unit()?.name, line: lineNo(p0), level: p1, message: mask(l.parts.slice(2).join('|')).slice(0, 500) }); remember(`debug [${lineNo(p0)}] ${mask(l.parts.slice(2).join('|')).slice(0, 200)}`); break;
      case 'SOQL_EXECUTE_BEGIN': out.queries++; remember(`SOQL [${lineNo(p0)}] ${mask(l.parts[l.parts.length - 1]).slice(0, 200)}`); break;
      case 'DML_BEGIN': { const d = { line: lineNo(p0), op: (p1 || '').replace('Op:', ''), type: (p2 || '').replace('Type:', ''), rows: (l.parts[3] || '').replace('Rows:', ''), unit: unit()?.name }; out.dml.push(d); remember(`DML [${d.line}] ${d.op} ${d.type} (${d.rows} rows)`); break; }
      case 'VARIABLE_ASSIGNMENT': if (p1 && !/^this$/.test(p1)) remember(`var [${lineNo(p0)}] ${p1} = ${mask(l.parts.slice(2).join('|')).slice(0, 150)}`); break;
      case 'STATEMENT_EXECUTE': break;
      case 'EXCEPTION_THROWN': out.failures.push({ kind: 'exception', unit: unit()?.name, unitInfo: unit(), line: lineNo(p0), message: mask(l.parts.slice(1).join('|')).slice(0, 800), before: [...recent] }); break;
      case 'FATAL_ERROR': out.failures.push({ kind: 'fatal', unit: unit()?.name, unitInfo: unit(), message: mask(l.parts.join('|')).slice(0, 1200), before: [...recent] }); break;
      case 'VALIDATION_FAIL': out.failures.push({ kind: 'validation', unit: unit()?.name, unitInfo: unit(), message: 'validation rule failed', before: [...recent] }); break;
      case 'VALIDATION_ERROR': out.failures.push({ kind: 'validation', unit: unit()?.name, unitInfo: unit(), message: mask(l.parts.join('|')).slice(0, 500) }); break;
      case 'VALIDATION_FORMULA': remember(`formula ${mask(l.parts.join('|')).slice(0, 300)}`); break;
      case 'FLOW_ELEMENT_ERROR': case 'FLOW_CREATE_INTERVIEW_ERROR': out.failures.push({ kind: 'flow', message: mask(l.parts.join('|')).slice(0, 800), before: [...recent] }); break;
      default: break;
    }
  }
  // match failure lines to the local source (class / trigger files)
  if (source) {
    for (const f of out.failures) {
      const u = f.unitInfo;
      if (!f.line || !u || !['class', 'trigger'].includes(u.kind)) continue;
      const file = findSource(source, u.kind, u.name);
      if (file) {
        const src = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        f.source = { file: path.relative(source, file).replace(/\\/g, '/'), line: f.line, code: (src[f.line - 1] || '').trim().slice(0, 200) };
      }
    }
  }
  for (const f of out.failures) delete f.unitInfo;
  return out;
}
function findSource(root, kind, name) {
  const want = kind === 'trigger' ? `${name}.trigger` : `${name}.cls`;
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p); else if (e.name === want) return p;
    }
  }
  return null;
}

// One line a developer reads first.
export function rootCause(analyses) {
  const f = analyses.flatMap((a) => a.failures);
  const pick = f.find((x) => x.kind === 'fatal') || f.find((x) => x.kind === 'exception') || f.find((x) => x.kind === 'flow') || f.find((x) => x.kind === 'validation');
  if (!pick) return null;
  const where = pick.source ? `${pick.source.file}:${pick.source.line} (${pick.source.code})` : pick.unit ? `${pick.unit}${pick.line ? ` line ${pick.line}` : ''}` : '';
  return `${pick.kind === 'validation' ? 'Validation rule failed' : pick.kind === 'flow' ? 'Flow error' : 'Apex error'}${where ? ` in ${where}` : ''}: ${pick.message}`;
}
