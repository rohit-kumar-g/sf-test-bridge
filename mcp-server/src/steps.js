// browser_steps: run an ordered list of browser actions in one call.
//
// Each step is { action, ...params, expect? }. Actions: navigate, click, fill,
// record_action, path, wait_for, get_text, press_key, dialog, type, options.
// Runs stop at the first failing step. The result is one compact text line per
// step plus a final PASS/FAIL line, so a whole test case costs one tool call.
//
// expect (all optional, substrings, case-insensitive):
//   toast       - a toast/alert shown during or after the step
//   error       - an error the step must produce: thrown error, field error,
//                 validation message or error toast (the step then PASSES)
//   fieldError  - an inline field error / field-level fill error
//   text        - text on the page after the step (waits up to expect.timeoutMs, default 5000)
//   textGone    - text no longer on the page
//   url         - the URL contains this
//   outcome     - the step's outcome (e.g. "stage changed", "saved", "modal closed")
//   current     - path: the current stage after the step
//
// Old alerts: Salesforce error toasts and popovers stay on screen across
// actions. Every action stamps the alerts already visible; its result lists
// only alerts it produced (`alerts`) and the rest as `staleAlerts`. error and
// toast expectations count only this step's alerts, or for error a save
// response from the server sent during the step (works even when the same
// error re-appears in the same element). Before an acting step with
// expect.error / expect.toast, open toasts and error popovers are closed first
// (step option dismissAlerts: false keeps them; true closes them for any
// acting step). wait_for / expect.text ignore text that is only in an old
// alert (step option allowStale: true accepts it).

import { EvidenceRun, EVIDENCE_MODE, shown as shownPath } from './evidence.js';

const shown = (c) => shownPath(c, '');

const ACTIONS = {
  navigate: { method: 'navigate', timeoutMs: 90_000 },
  click: { method: 'click', timeoutMs: 60_000 },
  fill: { method: 'fill', timeoutMs: 180_000 },
  record_action: { method: 'recordAction', timeoutMs: 60_000 },
  path: { method: 'path', timeoutMs: 180_000 },
  wait_for: { method: 'waitFor', timeoutMs: (a) => Math.min(a.timeoutMs || 15_000, 120_000) + 15_000 },
  get_text: { method: 'getText', timeoutMs: 180_000 },
  press_key: { method: 'key', timeoutMs: 60_000 },
  dialog: { method: 'dialog', timeoutMs: 30_000 },
  type: { method: 'type', timeoutMs: 60_000 },
  options: { method: 'options', timeoutMs: 60_000 },
};
export const STEP_ACTION_NAMES = Object.keys(ACTIONS);
// Steps that act on the page (and can produce a new error or toast).
const ACTING = new Set(['click', 'fill', 'record_action', 'path', 'press_key', 'type']);

const has = (hay, needle) => String(hay ?? '').toLowerCase().includes(String(needle).toLowerCase());
const short = (s, n = 160) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

// Every message a step produced that could be an error or a toast.
function messagesOf(r) {
  if (!r || typeof r !== 'object') return [];
  const out = [...(r.alerts || [])];
  for (const f of r.fields || []) if (f.error) out.push(f.error);
  if (r.outcome) out.push(r.outcome);
  if (r.submitted?.outcome) out.push(r.submitted.outcome);
  return out;
}
function fieldErrorsOf(r) {
  if (!r || typeof r !== 'object') return [];
  return [...(r.fields || []).filter((f) => f.error).map((f) => f.error), ...(r.alerts || [])];
}

function summarize(action, r) {
  if (r == null) return '';
  if (typeof r === 'string') return short(r, 300);
  const parts = [];
  switch (action) {
    case 'navigate':
      parts.push(`${short(r.title, 60)} ${String(r.url || '').replace(/^https?:\/\/[^/]+/, '')}`);
      if (r.note) parts.push(r.note);
      break;
    case 'click':
      parts.push(`clicked ${r.clicked}${r.via ? ` via ${r.via}` : ''}`);
      if (r.outcome) parts.push(r.outcome);
      if (r.ambiguous) parts.push(r.ambiguous);
      break;
    case 'fill':
      parts.push((r.fields || []).map((f) => (f.error ? `${f.label}: ERROR ${f.error}` : `${f.label}=${short(f.value, 50)} (${f.kind}${f.inlineEdit ? ', inline edit' : ''}${f.via ? `, ${f.via}` : ''})${f.ambiguous ? ` [${f.ambiguous}]` : f.note ? ` [${f.note}]` : ''}`)).join('; '));
      if (r.submitted) parts.push(`submitted ${r.submitted.button}: ${r.submitted.outcome || 'clicked'}`);
      if (r.note) parts.push(r.note);
      break;
    case 'record_action':
      parts.push(`${r.action} via ${r.via}`);
      break;
    case 'path':
      if (r.outcome) parts.push(`${r.clicked}: ${r.outcome}`);
      parts.push(`current: ${r.current}${r.selected && r.selected !== r.current ? `, selected: ${r.selected}` : ''}`);
      if (r.keyFields) parts.push(`key fields: ${r.keyFields.join('; ')}`);
      if (r.fields) parts.push((r.fields || []).map((f) => (f.error ? `${f.label}: ERROR ${f.error}` : `${f.label}=${short(f.value, 40)}`)).join('; '));
      if (r.submitted) parts.push(`submitted: ${r.submitted.outcome || 'clicked'}`);
      if (r.editable) parts.push(`editable: ${r.editable.join(', ')}`);
      break;
    case 'wait_for':
      parts.push(`ok after ${r.waitedMs}ms`);
      break;
    case 'get_text':
      parts.push(`"${short(r.text, r.__max || 600)}"`);
      break;
    case 'options':
      parts.push(`${r.field}: ${(r.options || []).map((o) => o.name).slice(0, 20).join(' | ') || '(none)'}`);
      break;
    default:
      for (const k of ['pressed', 'typedInto', 'handled', 'value']) if (r[k] != null) parts.push(`${k}: ${short(JSON.stringify(r[k]), 80)}`);
  }
  if (r.alerts?.length) parts.push(`alerts: ${r.alerts.map((a) => `"${short(a, 140)}"`).join(', ')}`);
  if (r.staleAlerts?.length) parts.push(`old alerts ignored: ${r.staleAlerts.length}`);
  if (r.openModal) parts.push(`modal: ${r.openModal}`);
  if (r.dialog) parts.push(`JS dialog: ${r.dialog.type}`);
  if (r.failedRequests?.length) parts.push(`${r.failedRequests.length} failed request(s)`);
  return parts.filter(Boolean).join(' | ');
}

// Where this call's evidence goes. `evidence`: false = none; true / omitted =
// default mode (BROWSER_BRIDGE_EVIDENCE: steps | failures | off); or
// {project, run, case, mode, description}. Each runSteps call is one test case.
function openEvidence(evidence, steps) {
  if (evidence === false) return null;
  const o = evidence && typeof evidence === 'object' ? evidence : {};
  const mode = (o.mode || EVIDENCE_MODE).toLowerCase();
  if (mode === 'off') return null;
  const run = EvidenceRun.open({ project: o.project, run: o.run, title: o.runTitle, description: o.runDescription });
  const title = o.case || steps.map((s) => s.name).filter(Boolean).slice(0, 3).join(' / ') || `browser_steps ${new Date().toISOString().slice(11, 19)}`;
  return { mode, case: run.startCase(title, { description: o.description || '' }) };
}

// request(method, params, timeoutMs) -> result; log(stepAction, params, ok, resultOrMessage)
export async function runSteps(request, { steps, tabId, evidence } = {}, log = () => {}) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('steps must be a non-empty array of {action, ...}');
  const lines = [];
  const t0 = Date.now();
  let failedAt = null;
  const ev = openEvidence(evidence, steps);
  let shots = 0;
  // Store one step (and its screenshots) in the evidence case.
  const record = async (i, stepName, action, ok, secs, line, extra) => {
    if (!ev) return;
    const st = steps[i];
    const want = st.evidence !== false && (ev.mode === 'steps' || !ok || st.evidence === true);
    const exp = st.expect ? Object.entries(st.expect).filter(([k]) => k !== 'timeoutMs').map(([k, v]) => `${k} "${v}"`).join(', ') : '';
    const caption = `#${i + 1} ${ok ? 'PASS' : 'FAIL'} ${stepName ? `${stepName} - ` : ''}${action}${exp ? ` | expect ${exp}` : ''}`;
    const tab = st.tabId ?? tabId;
    let shot = null;
    let detail = null;
    if (want) {
      shot = await ev.case.capture(request, { n: i + 1, status: ok ? 'pass' : 'fail', caption, tabId: tab });
      if (!ok) detail = await ev.case.capture(request, { n: i + 1, status: 'fail', caption: `${caption} (first error in view)`, detail: true, tabId: tab });
    }
    if (shot?.file) shots++;
    if (detail?.file) shots++;
    ev.case.addStep({
      n: i + 1, name: stepName || '', action, status: ok ? 'passed' : 'failed', durationMs: Math.round(Number(secs) * 1000),
      line, params: Object.fromEntries(Object.entries(st).filter(([k]) => !['action', 'expect', 'name', 'evidence'].includes(k))),
      expect: st.expect, ...extra,
      screenshot: shot?.file || null, detail: detail?.file || null, url: shot?.url || null,
      marked: shot?.marked || null, captureError: shot?.error || null,
    });
  };
  for (let i = 0; i < steps.length; i++) {
    const { action, expect = {}, evidence: _ev, ...params } = steps[i];
    const n = `#${i + 1}`;
    const def = ACTIONS[action];
    if (!def) {
      lines.push(`${n} FAIL ${action}: unknown action (use ${STEP_ACTION_NAMES.join(', ')})`);
      await record(i, params.name, action, false, '0', lines[lines.length - 1], { error: 'unknown action' });
      failedAt = i + 1;
      break;
    }
    // A step description can go in `name` (shown in the result line).
    const stepName = params.name || '';
    const name = stepName ? `${stepName}: ` : '';
    delete params.name;
    if (tabId != null && params.tabId == null) params.tabId = tabId;
    // browser_path has its own `action` (read/select/mark/editKeyFields): in a
    // step it is given as `do`, because `action` names the step type.
    if (action === 'path' && params.do) { params.action = params.do; delete params.do; }
    const timeoutMs = typeof def.timeoutMs === 'function' ? def.timeoutMs(params) : def.timeoutMs;
    const s0 = Date.now();
    const dismissOpt = params.dismissAlerts;
    delete params.dismissAlerts;
    const allowStale = !!params.allowStale;
    if (action !== 'wait_for') delete params.allowStale;
    const acting = ACTING.has(action);
    // Start clean: close old toasts / error popovers before an acting step
    // that expects an error or toast.
    let dismissed = 0;
    if (acting && (dismissOpt === true || (dismissOpt !== false && (expect.error || expect.toast)))) {
      dismissed = (await request('dismissAlerts', { tabId: params.tabId }, 20_000).catch(() => null))?.closed || 0;
    }
    // Network position, to check the server's answer to this step's save.
    const net = acting && expect.error ? await request('netMark', { tabId: params.tabId }, 10_000).catch(() => null) : null;
    let r = null;
    let err = null;
    try {
      r = await request(def.method, params, timeoutMs);
      log(action, params, true, r);
    } catch (e) {
      err = e.message;
      log(action, params, false, err);
    }
    if (r && action === 'get_text') r.__max = params.maxChars && params.maxChars < 2000 ? params.maxChars : 600;
    const problems = [];
    const msgs = messagesOf(r);
    const stale = r && typeof r === 'object' ? r.staleAlerts || [] : [];
    const staleNote = (want) => (!allowStale && has(stale.join(' \n '), want) ? ': it is on screen only in an old alert left from an earlier action; this step did not produce it' : '');
    let server = null;
    let errorSource = null;
    // what counts as failure without expectations
    if (expect.error) {
      const onPage = has([err, ...msgs].join(' \n '), expect.error) || (allowStale && has(stale.join(' \n '), expect.error));
      if (net?.captured) server = await request('serverMessages', { tabId: params.tabId, sinceSeq: net.netSeq, text: expect.error }, 30_000).catch(() => null);
      if (server?.matched) errorSource = onPage ? 'server response and page' : 'server response';
      else if (onPage) errorSource = has((r?.reusedAlerts || []).join(' \n '), expect.error) ? 'page (re-rendered alert)' : 'page';
      if (!errorSource) {
        const sn = staleNote(expect.error);
        problems.push(`expected error "${expect.error}"${sn || (err ? `, got: ${err}` : msgs.length ? `, got: ${msgs.map((m) => short(m, 120)).join(' / ')}` : ', but the step succeeded with no error')}`);
      }
    } else if (err) {
      problems.push(err);
    } else {
      const fieldErr = (r?.fields || []).find((f) => f.error);
      if (fieldErr && !expect.fieldError) problems.push(`field "${fieldErr.label}": ${fieldErr.error}`);
      const oc = r?.submitted?.outcome || (action === 'path' ? r?.outcome : null) || (action === 'click' ? r?.outcome : null);
      if (oc && /error shown|still open|still editing|no change/.test(oc) && !expect.outcome && !expect.fieldError) problems.push(`outcome: ${oc}${r.alerts?.length ? ` (${r.alerts.map((a) => short(a, 120)).join(' / ')})` : ''}`);
    }
    if (!err || expect.error) {
      if (expect.toast && !has(msgs.join(' \n '), expect.toast) && !(allowStale && has(stale.join(' \n '), expect.toast))) problems.push(`expected toast "${expect.toast}"${staleNote(expect.toast) || `; alerts: ${(r?.alerts || []).map((a) => short(a, 100)).join(' / ') || 'none'}`}`);
      if (expect.fieldError && !has(fieldErrorsOf(r).join(' \n '), expect.fieldError)) problems.push(`expected field error "${expect.fieldError}"; got: ${fieldErrorsOf(r).map((a) => short(a, 100)).join(' / ') || 'none'}`);
      if (expect.outcome && !has(`${r?.outcome || ''} ${r?.submitted?.outcome || ''}`, expect.outcome)) problems.push(`expected outcome "${expect.outcome}", got "${r?.submitted?.outcome || r?.outcome || 'none'}"`);
      if (expect.current && !has(r?.current, expect.current)) problems.push(`expected current stage "${expect.current}", got "${r?.current}"`);
      if (expect.url && !has(r?.url, expect.url)) {
        const st = await request('tabs', {}, 10_000).catch(() => []);
        const t = (st || []).find((x) => x.tabId === (params.tabId ?? r?.tabId)) || st?.[0];
        if (!has(t?.url, expect.url)) problems.push(`expected url to contain "${expect.url}", got ${t?.url || r?.url}`);
      }
      if (expect.text) {
        if (!(action === 'get_text' && has(r?.text, expect.text))) {
          const res = await request('waitFor', { tabId: params.tabId, text: expect.text, allowStale, timeoutMs: expect.timeoutMs ?? 5000 }, (expect.timeoutMs ?? 5000) + 15_000).then(() => null, (e) => e.message || 'not found');
          if (res) problems.push(`expected text "${expect.text}" on the page${/old alert/.test(res) ? ' (found only in an old alert left from an earlier action)' : ''}`);
        }
      }
      if (expect.textGone) {
        const ok = await request('waitFor', { tabId: params.tabId, textGone: expect.textGone, timeoutMs: expect.timeoutMs ?? 5000 }, (expect.timeoutMs ?? 5000) + 15_000).then(() => true, () => false);
        if (!ok) problems.push(`expected text "${expect.textGone}" to be gone`);
      }
    }
    const secsN = ((Date.now() - s0) / 1000).toFixed(1);
    const secs = `${secsN}s`;
    const summary = err ? (expect.error ? `failed as expected: ${short(err, 300)}` : '') : summarize(action, r);
    const body = [dismissed ? `closed ${dismissed} old alert(s) first` : '', summary, errorSource ? `error from: ${errorSource}` : ''].filter(Boolean).join(' | ');
    const extra = {
      error: problems.length ? problems.join('; ') : null, alerts: r?.alerts || [], result: body || null,
      ...(stale.length ? { staleAlerts: stale } : {}),
      ...(r?.reusedAlerts?.length ? { reusedAlerts: r.reusedAlerts } : {}),
      ...(server?.errors?.length ? { serverErrors: server.errors } : {}),
      ...(errorSource ? { errorSource } : {}),
      ...(dismissed ? { dismissedAlerts: dismissed } : {}),
    };
    if (problems.length) {
      lines.push(`${n} FAIL ${name}${action} (${secs}): ${problems.join('; ')}${body ? ` || ${body}` : ''}`);
      await record(i, stepName, action, false, secsN, lines[lines.length - 1], extra);
      failedAt = i + 1;
      break;
    }
    lines.push(`${n} PASS ${name}${action} (${secs})${body ? `: ${body}` : ''}`);
    await record(i, stepName, action, true, secsN, lines[lines.length - 1], extra);
  }
  const total = `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  lines.push(failedAt
    ? `FAIL at step ${failedAt}/${steps.length} (${total}); steps after it were not run`
    : `PASS ${steps.length}/${steps.length} steps (${total})`);
  if (ev) {
    ev.case.finish(failedAt ? 'failed' : 'passed', failedAt ? lines[lines.length - 2] : undefined);
    // only the folder goes back to Claude, never the images
    lines.push(`Evidence: ${shown(ev.case)} (${shots} screenshot${shots === 1 ? '' : 's'}; case.json)`);
  }
  return { ok: !failedAt, failedAt, text: lines.join('\n'), evidenceDir: ev ? ev.case.dir : null };
}
