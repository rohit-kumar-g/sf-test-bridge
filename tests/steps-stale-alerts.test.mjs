#!/usr/bin/env node
// Offline check of browser_steps' old-alert handling (no browser needed).
// A fake extension answers each command. Covers:
//  1. expected error only in an old alert (staleAlerts)  -> FAIL with a clear note
//  2. same error produced again, shown in a new alert     -> PASS (page)
//  3. same error again, page element not re-rendered,
//     but the server answered the save with it            -> PASS (server response)
//  4. old toasts are closed before a step with expect.error, not before others
//  5. allowStale: true accepts the old alert
//   node tests/steps-stale-alerts.test.mjs
import { runSteps } from '../mcp-server/src/steps.js';

const ERR = 'To leave Prospecting, fill in: Bridge Contact.';
const toast = `Error notification. You encountered some errors when trying to save this record ${ERR}`;

function fake(plan) {
  const calls = [];
  const request = async (method, params) => {
    calls.push(method);
    if (method === 'dismissAlerts') return { closed: 1, texts: [toast] };
    if (method === 'netMark') return { netSeq: 10, captured: true };
    if (method === 'serverMessages') return plan.server || { captured: true, matched: false, errors: [] };
    if (method === 'path' || method === 'click') return plan.result;
    throw new Error(`unexpected ${method}`);
  };
  return { request, calls };
}
const step = (extra = {}) => ({ action: 'path', do: 'mark', name: 'NEG mark', expect: { error: ERR }, ...extra });

let failed = 0;
const check = (name, cond, info) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : `\n     ${info}`}`); if (!cond) failed++; };

{ // 1. only an old alert
  const f = fake({ result: { outcome: 'no change', current: 'Prospecting', staleAlerts: [toast] } });
  const r = await runSteps(f.request, { steps: [step()], tabId: 1, evidence: false });
  check('1 old alert only -> FAIL', !r.ok && /only in an old alert/.test(r.text), r.text);
}
{ // 2. new alert
  const f = fake({ result: { outcome: 'error shown', current: 'Prospecting', alerts: [toast] } });
  const r = await runSteps(f.request, { steps: [step()], tabId: 1, evidence: false });
  check('2 new alert -> PASS (page)', r.ok && /error from: page/.test(r.text), r.text);
}
{ // 3. element not re-rendered, server confirms
  const f = fake({ result: { outcome: 'no change', current: 'Prospecting', staleAlerts: [toast] }, server: { captured: true, matched: true, errors: [ERR] } });
  const r = await runSteps(f.request, { steps: [step()], tabId: 1, evidence: false });
  check('3 server confirms repeated error -> PASS (server)', r.ok && /error from: server response/.test(r.text), r.text);
}
{ // 4. dismiss before expect.error steps only
  const f = fake({ result: { clicked: 'x', alerts: [] } });
  await runSteps(f.request, { steps: [{ action: 'click', text: 'x' }], tabId: 1, evidence: false });
  check('4a no dismiss without expectation', !f.calls.includes('dismissAlerts'), f.calls.join(','));
  const g = fake({ result: { outcome: 'error shown', current: 'Prospecting', alerts: [toast] } });
  await runSteps(g.request, { steps: [step()], tabId: 1, evidence: false });
  check('4b dismiss + netMark before the action', g.calls.slice(0, 3).join(',') === 'dismissAlerts,netMark,path', g.calls.join(','));
  const h = fake({ result: { outcome: 'error shown', current: 'Prospecting', alerts: [toast] } });
  await runSteps(h.request, { steps: [step({ dismissAlerts: false })], tabId: 1, evidence: false });
  check('4c dismissAlerts:false keeps them', !h.calls.includes('dismissAlerts'), h.calls.join(','));
}
{ // 5. allowStale
  const f = fake({ result: { outcome: 'no change', current: 'Prospecting', staleAlerts: [toast] } });
  const r = await runSteps(f.request, { steps: [step({ allowStale: true })], tabId: 1, evidence: false });
  check('5 allowStale accepts the old alert', r.ok, r.text);
}
{ // three identical NEG attempts in a row, each must be judged on its own
  const results = [
    { outcome: 'error shown', current: 'Prospecting', alerts: [toast] }, // new toast element
    { outcome: 'no change', current: 'Prospecting', reusedAlerts: [toast], alerts: [toast] }, // same popover re-rendered
    { outcome: 'no change', current: 'Prospecting', staleAlerts: [toast] }, // nothing new, server confirms
  ];
  let i = 0;
  const server = [null, null, { captured: true, matched: true, errors: [ERR] }];
  const request = async (method) => {
    if (method === 'dismissAlerts') return { closed: 0 };
    if (method === 'netMark') return { netSeq: i * 10, captured: true };
    if (method === 'serverMessages') return server[i - 1] || { captured: true, matched: false, errors: [] };
    if (method === 'path') return results[i++];
    throw new Error(method);
  };
  const r = await runSteps(request, { steps: [step(), step(), step()], tabId: 1, evidence: false });
  check('6 three identical errors in a row -> 3 PASS', r.ok && (r.text.match(/ PASS /g) || []).length === 3 && /re-rendered/.test(r.text) && /server response/.test(r.text), r.text);
  // and a 4th attempt that produced nothing must fail
  const r4 = await runSteps(async (m) => (m === 'path' ? { outcome: 'no change', current: 'Prospecting', staleAlerts: [toast] } : m === 'netMark' ? { netSeq: 50, captured: true } : m === 'serverMessages' ? { captured: true, matched: false, errors: [] } : { closed: 0 }), { steps: [step()], tabId: 1, evidence: false });
  check('7 4th attempt with no new error -> FAIL', !r4.ok && /only in an old alert/.test(r4.text), r4.text);
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
