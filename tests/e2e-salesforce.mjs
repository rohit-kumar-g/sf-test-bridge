#!/usr/bin/env node
// End-to-end regression suite for SF Test Bridge against a Salesforce test org
// (SF_ORG_URL). Tests that need optional fixtures are skipped when they are absent.
// Drives the real browser through the extension (same commands the MCP tools
// use) and asserts on the text results. No screenshots.
//
//   node tests/e2e-salesforce.mjs                 run everything
//   node tests/e2e-salesforce.mjs console guards  run tests whose name contains a filter
//
// Needs: Chrome/Edge running with the extension, logged in to the org.
// Records it creates are named "Bridge E2E <run>" and deleted at the end.
import fs from 'node:fs';
import { Bridge } from '../mcp-server/src/hub.js';
import { logAction } from '../mcp-server/src/actionlog.js';
import { runSteps } from '../mcp-server/src/steps.js';
import { EvidenceRun } from '../mcp-server/src/evidence.js';

const ORG = (process.env.SF_ORG_URL || '').replace(/\/+$/, '');
if (!ORG) { console.error('Set SF_ORG_URL to your org\'s Lightning URL, e.g. https://yourdomain.lightning.force.com'); process.exit(2); }
const RUN = new Date().toISOString().slice(5, 19).replace(/[-T:]/g, '');
const filters = process.argv.slice(2).map((f) => f.toLowerCase());

const bridge = new Bridge({ port: Number(process.env.BROWSER_BRIDGE_PORT || 17345) }).start();
let TAB = null;

// Evidence: each suite run is a test run, each test a case, each action call a
// step with an annotated screenshot (E2E_EVIDENCE=steps|failures|off).
const EVIDENCE = (process.env.E2E_EVIDENCE || 'steps').toLowerCase();
const evRun = EVIDENCE === 'off' ? null : EvidenceRun.open({
  project: 'claude-bridge-e2e', run: `e2e-${RUN}`, title: `Regression suite ${RUN}${filters.length ? ` (${filters.join(', ')})` : ''}`,
  description: 'node tests/e2e-salesforce.mjs', env: { org: ORG, filters: filters.join(' ') || 'all' },
});
let evCase = null;
const ACTION_METHODS = new Set(['navigate', 'open', 'click', 'fill', 'recordAction', 'path', 'type', 'key', 'select', 'dialog', 'upload']);
const brief = (method, p) => {
  const t = p.label || p.text || p.url || p.key || p.selector || (p.fields ? p.fields.map((f) => f.label).join(', ') : '') || p.action || '';
  return `${method}${t ? ` ${String(t).replace(/^https?:\/\/[^/]+/, '').slice(0, 80)}` : ''}`;
};
async function evidenceStep(method, p, ok, ms, info) {
  if (!evCase || !ACTION_METHODS.has(method)) return;
  const n = evCase.data.steps.length + 1;
  const what = brief(method, p);
  const shot = EVIDENCE === 'steps' || !ok
    ? await evCase.capture((m, q, t) => bridge.request(m, q, t), { n, status: ok ? 'pass' : 'error', caption: `#${n} ${ok ? 'OK' : 'ERROR'} ${what}`, tabId: p.tabId })
    : null;
  evCase.addStep({
    n, name: what, action: method, status: ok ? 'passed' : 'error', durationMs: ms,
    line: ok ? '' : info, result: ok ? (info || null) : null, error: ok ? null : info,
    screenshot: shot?.file || null, url: shot?.url || null, marked: shot?.marked || null, captureError: shot?.error || null,
  });
}

async function call(method, params = {}, timeoutMs = 180_000) {
  const p = TAB && !('tabId' in params) && method !== 'open' && method !== 'status' ? { ...params, tabId: TAB } : params;
  const t0 = Date.now();
  try {
    const r = await bridge.request(method, p, timeoutMs);
    logAction('sf-test-bridge-e2e', method, p, true, r);
    const sum = [r?.clicked && `clicked ${r.clicked}`, r?.outcome, r?.submitted?.outcome, r?.openModal && `modal: ${r.openModal}`, r?.alerts?.length && `alerts: ${r.alerts.join(' | ')}`]
      .filter(Boolean).join(' | ');
    await evidenceStep(method, p, true, Date.now() - t0, sum);
    return r;
  } catch (e) {
    logAction('sf-test-bridge-e2e', method, p, false, e.message);
    // an error here may be what the test expects; the case result decides
    await evidenceStep(method, p, false, Date.now() - t0, e.message);
    throw e;
  }
}
const snap = async (maxChars = 40_000) => (await call('snapshot', { maxChars })).text;
const go = (path) => call('navigate', { url: ORG + path });
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const alertsOf = (r) => (r.alerts || []).join(' | ');
const cancelModal = () => call('click', { text: 'Cancel', exact: true, role: ['button'], scope: 'modal' });

// Make sure the given Lightning app is active (console apps change how
// records and "New" open: workspace tabs instead of modals).
async function ensureApp(name) {
  const t = await snap(4000);
  if (new RegExp(`heading "${name}" \\[level=1\\]`).test(t)) return false;
  await call('click', { text: 'App Launcher', role: ['button'] });
  await call('type', { text: 'Search apps and items...', value: name, slowly: true });
  await call('click', { text: name, exact: true, role: ['option'] });
  return true;
}

async function closeStrayModals() {
  for (let i = 0; i < 4; i++) {
    const t = await snap(3000).catch(() => '');
    if (!/^\s*- (dialog|alertdialog) "/m.test(t)) return;
    await call('click', { text: 'Cancel', exact: true, role: ['button'], scope: 'modal', timeoutMs: 500 })
      .catch(() => call('key', { key: 'Escape' })).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Ledger of record ids this suite created, so cleanup also covers interrupted runs.
const LEDGER = new URL('./.e2e-created.json', import.meta.url);
const ledger = { read: () => { try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { return []; } } };
ledger.add = (id, name) => fs.writeFileSync(LEDGER, JSON.stringify([...ledger.read().filter((x) => x.id !== id), { id, name }], null, 1));
ledger.remove = (id) => fs.writeFileSync(LEDGER, JSON.stringify(ledger.read().filter((x) => x.id !== id), null, 1));

const results = [];
const state = {};
async function test(name, fn, { needs } = {}) {
  if (filters.length && !filters.some((f) => name.toLowerCase().includes(f))) return;
  if (needs && !needs.every((k) => state[k])) {
    results.push({ name, status: 'SKIP', note: `needs ${needs.filter((k) => !state[k]).join(', ')}` });
    console.log(`SKIP  ${name}`);
    return;
  }
  const t0 = Date.now();
  evCase = evRun ? evRun.startCase(name) : null;
  try {
    const note = await fn();
    results.push({ name, status: 'PASS', ms: Date.now() - t0, note });
    console.log(`PASS  ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)${note ? ' - ' + note : ''}`);
    evCase?.finish('passed', note || undefined);
  } catch (e) {
    if (e.skip) {
      results.push({ name, status: 'SKIP', note: e.message });
      console.log(`SKIP  ${name} - ${e.message}`);
      evCase?.finish('blocked', `skipped: ${e.message}`);
    } else {
      results.push({ name, status: 'FAIL', ms: Date.now() - t0, note: e.message });
      console.log(`FAIL  ${name} - ${e.message}`);
      if (evCase && TAB) { // what the page showed when the test failed
        const c = evCase;
        const n = c.data.steps.length + 1;
        const shot = await c.capture((m, q, t) => bridge.request(m, q, t), { n, status: 'fail', caption: `FAIL ${name}: ${e.message}`.slice(0, 200), detail: true, tabId: TAB });
        c.addStep({ n, name: 'test failed', action: 'assert', status: 'failed', durationMs: 0, error: e.message, line: e.message, screenshot: shot?.file || null, url: shot?.url || null, marked: shot?.marked || null });
      }
      evCase?.finish('failed', e.message);
    }
    evCase = null;
    await closeStrayModals();
  }
  evCase = null;
}
const skip = (msg) => Object.assign(new Error(msg), { skip: true });

// ---------------------------------------------------------------------------
const ACCT = `Bridge E2E ${RUN}`;
const PARENT = `Bridge E2E Parent ${RUN}`;
const CONTACT = `E2E Contact ${RUN}`;

await test('bridge: extension connected', async () => {
  const s = await call('status');
  assert(s.browser && !s.paused, `extension not ready: ${JSON.stringify(s)}`);
  return `${s.browser} ${s.version}`;
});

await test('session: open org with existing browser login', async () => {
  const r = await call('open', { url: `${ORG}/lightning/o/Account/list` });
  TAB = r.tabId;
  // Results must not depend on how the window happens to be arranged: Lightning
  // collapses actions and tabs into overflow menus in narrow windows.
  state.window = await call('window', {});
  await call('window', { width: 1400, height: 900 });
  assert(/force\.com\/lightning\//.test(r.url) && !/login|secur/i.test(r.url), `not inside the org: ${r.url}`);
  const switched = await ensureApp('Developer Edition');
  const l = await go('/lightning/o/Account/list');
  assert(/Accounts/.test(l.title), `account list not shown: ${l.title}`);
  return switched ? 'switched back to Developer Edition app' : undefined;
});

await test('record create: all standard field types in New Account modal', async () => {
  const n = await go('/lightning/o/Account/new?count=1&nooverride=1');
  assert(/New Account/.test(n.openModal || ''), `modal not open: ${n.openModal}`);
  const want = {
    'Account Name': ACCT, Rating: 'Hot', Type: 'Customer - Direct', Phone: '(555) 010-2030', Employees: '42',
    Industry: 'Technology', 'SLA Expiration Date': '12/31/2026', Active: 'Yes', Description: `E2E ${RUN}`,
  };
  const r = await call('fill', { fields: Object.entries(want).map(([label, value]) => ({ label, value })), submit: 'Save' });
  for (const f of r.fields) {
    assert(!f.error, `${f.label}: ${f.error}`);
    assert(String(f.value) === want[f.label], `${f.label}: expected "${want[f.label]}", got "${f.value}"`);
  }
  const m = /\/lightning\/r\/(?:Account\/)?(001\w{12,15})\/view/.exec(r.url);
  if (m) ledger.add(m[1], ACCT);
  // durable proof: we landed on the new record (toasts are transient)
  assert(m, `not on the new record: ${r.url} | ${alertsOf(r)} | ${JSON.stringify(r.submitted)}`);
  state.acctId = m[1];
  return /was created/.test(alertsOf(r)) ? undefined : 'record created (toast not captured)';
});

await test('validation: required-field errors reported as text', async () => {
  await go('/lightning/o/Account/new?count=1&nooverride=1');
  const r = await call('click', { text: 'Save', exact: true, role: ['button'] });
  assert(/Complete this field/.test(alertsOf(r)), `field error missing: ${alertsOf(r)}`);
  assert(/snag/i.test(r.openModal || ''), `error popover missing: ${r.openModal}`);
  await cancelModal();
});

await test('record create: parent account (lookup target)', async () => {
  await go('/lightning/o/Account/new?count=1&nooverride=1');
  const r = await call('fill', { fields: [{ label: 'Account Name', value: PARENT }], submit: 'Save' });
  state.parentId = /\/lightning\/r\/(?:Account\/)?(001\w{12,15})\/view/.exec(r.url)?.[1];
  if (state.parentId) ledger.add(state.parentId, PARENT);
  assert(state.parentId, `not on the new record: ${r.url} | ${alertsOf(r)}`);
  return /was created/.test(alertsOf(r)) ? undefined : 'record created (toast not captured)';
}, { needs: ['acctId'] });

await test('record action: Edit (panel or overflow) + lookup + picklists + Save', async () => {
  await go(`/lightning/r/Account/${state.acctId}/view`);
  const a = await call('recordAction', { label: 'Edit' });
  assert(/^Edit /.test(a.openModal || ''), `edit modal not open: ${a.openModal}`);
  const r = await call('fill', {
    fields: [
      { label: 'Parent Account', value: PARENT, search: `Bridge E2E Parent ${RUN}` },
      { label: 'Rating', value: 'Warm' },
      { label: 'Customer Priority', value: 'High' },
    ],
    submit: 'Save',
  });
  for (const f of r.fields) assert(!f.error, `${f.label}: ${f.error}`);
  assert(r.fields[0].value === PARENT, `lookup value: ${r.fields[0].value}`);
  assert(!r.openModal, `edit modal still open after Save: ${r.openModal} | ${alertsOf(r)}`);
  await call('click', { text: 'Details', exact: true, role: ['tab'] });
  await call('waitFor', { text: PARENT, timeoutMs: 10_000 }); // Parent Account is on the Details tab
  return `via ${a.via}`;
}, { needs: ['acctId', 'parentId'] });

await test('button clicks: stateful header button (Follow -> Following -> Unfollow)', async () => {
  await go(`/lightning/r/Account/${state.acctId}/view`);
  const header = async () => (await snap()).split('\n').filter((l) => /button "(Follow|Following|Unfollow)/.test(l)).join(' ');
  await call('click', { text: 'Follow', exact: true, role: ['button'], scope: 'header' });
  await call('waitFor', { text: 'Following', timeoutMs: 8000 });
  assert(/Following/.test(await header()), `not following: ${await header()}`);
  await call('hover', { text: 'Following', role: ['button'], scope: 'header' });
  await call('click', { text: 'Following', role: ['button'], scope: 'header' });
  await call('waitFor', { textGone: 'Following', timeoutMs: 8000 });
  assert(/button "Follow"/.test(await header()), `still following: ${await header()}`);
}, { needs: ['acctId'] });

await test('lazy loading: loadAll renders below-the-fold related lists; click finds them by scrolling', async () => {
  await go(`/lightning/r/Account/${state.acctId}/view`);
  const plain = await snap();
  const full = (await call('snapshot', { loadAll: true, maxChars: 60_000 })).text;
  const has = (t, re) => re.test(t);
  assert(has(full, /heading "Partners \(0\)"/) && has(full, /heading "Notes & Attachments \(0\)"/), 'loadAll did not render lower related lists');
  const lazyProof = !has(plain, /heading "Partners \(0\)"/);
  await go(`/lightning/r/Account/${state.acctId}/view`); // fresh page, nothing scrolled
  const r = await call('click', { text: 'New', exact: true, role: ['button'], within: 'Cases', timeoutMs: 20_000 });
  assert((r.openModal || '').includes('New Case'), `scroll-to-find opened "${r.openModal}"`);
  await cancelModal();
  return lazyProof ? 'plain snapshot lacked lower lists; loadAll had them' : 'page was small enough to render fully';
}, { needs: ['acctId'] });

await test('record action: Change Owner modal opens and cancels', async () => {
  const a = await call('recordAction', { label: 'Change Owner' });
  assert(/Owner/.test(a.openModal || ''), `modal: ${a.openModal}`);
  const c = await cancelModal();
  assert(!c.openModal, `modal still open: ${c.openModal}`);
  return `via ${a.via}`;
}, { needs: ['acctId'] });

await test('quick action: New Contact (picklist + text) + Save', async () => {
  await go(`/lightning/r/Account/${state.acctId}/view`);
  const a = await call('recordAction', { label: 'New Contact' });
  assert(/New Contact/.test(a.openModal || ''), `modal: ${a.openModal}`);
  const r = await call('fill', {
    fields: [
      { label: 'Salutation', value: 'Dr.' }, { label: 'First Name', value: 'E2E' },
      { label: 'Last Name', value: CONTACT }, { label: 'Email', value: `e2e.${RUN}@example.com` },
    ],
    submit: 'Save',
  });
  for (const f of r.fields) assert(!f.error, `${f.label}: ${f.error}`);
  assert(!r.openModal, `contact modal still open after Save: ${r.openModal} | ${alertsOf(r)}`);
  await call('waitFor', { text: CONTACT, timeoutMs: 15_000 }); // shows up in the Contacts related list
  state.contact = true;
  return /was created/.test(alertsOf(r)) ? undefined : 'contact created (toast not captured)';
}, { needs: ['acctId'] });

await test('duplicate buttons: ambiguity warning, within, index', async () => {
  await go(`/lightning/r/Account/${state.acctId}/view`);
  await call('scroll', { text: 'Cases', role: ['heading'], timeoutMs: 15_000 });
  await call('waitFor', { text: 'Cases (0)', timeoutMs: 20_000 });
  const amb = await call('click', { text: 'New', exact: true, role: ['button'], scope: 'page' });
  assert(/elements match/.test(amb.ambiguous || ''), `no ambiguity warning: ${JSON.stringify(amb)}`);
  await cancelModal();
  for (const [list, modal] of [['Contacts', 'New Contact'], ['Opportunities', 'New Opportunity'], ['Cases', 'New Case']]) {
    const r = await call('click', { text: 'New', exact: true, role: ['button'], within: list });
    assert((r.openModal || '').includes(modal), `New within ${list} opened "${r.openModal}"`);
    const c = await cancelModal();
    assert(!c.openModal, `${modal} did not close: ${c.openModal}`);
  }
  const i2 = await call('click', { text: 'New', exact: true, role: ['button'], scope: 'page', index: 2 });
  assert((i2.openModal || '').includes('New Opportunity'), `index 2 opened "${i2.openModal}"`);
  await cancelModal();
  return amb.ambiguous;
}, { needs: ['acctId'] });

await test('record page tabs: Details / Related / Chatter / Activity', async () => {
  await go(`/lightning/r/Account/${state.acctId}/view`);
  for (const tab of ['Details', 'Related', 'Chatter', 'Activity']) {
    await call('click', { text: tab, exact: true, role: ['tab'] });
    const t = await snap();
    assert(new RegExp(`tab "${tab}" \\[selected\\]`).test(t), `tab ${tab} not selected after click`);
  }
}, { needs: ['acctId'] });

await test('fixture: screen flow in quick-action modal (all input types, Next/Finish)', async () => {
  await go(`/lightning/r/Account/${state.acctId}/view`);
  const a = await call('recordAction', { label: 'Claude Bridge Test Flow' }).catch(() => null);
  if (!a) throw skip('flow quick action not deployed (salesforce/ fixtures)');
  const r = await call('fill', {
    fields: [
      { label: 'Project Name', value: `Flow ${RUN}` }, { label: 'Priority', value: 'High' },
      { label: 'Contact Method', value: 'Phone' }, { label: 'Regions', value: 'North, West' },
      { label: 'Start Date', value: '12/31/2026' }, { label: 'Budget', value: '1000' },
      { label: 'Agree to Terms', value: true }, { label: 'Notes', value: 'flow notes' },
      { label: 'Related Contact', value: CONTACT, search: CONTACT },
    ],
    submit: 'Next',
  });
  for (const f of r.fields) assert(!f.error, `${f.label}: ${f.error}`);
  const t = (await call('getText', {})).text;
  assert(t.includes(`name=Flow ${RUN}`) && t.includes('priority=High') && t.includes('method=Phone'), `summary wrong: ${t.slice(0, 400)}`);
  assert(/regions=North; ?West|regions=North,West|regions=North;West/.test(t), 'regions missing in summary');
  await call('click', { text: 'Previous', exact: true, role: ['button'] });
  await call('click', { text: 'Next', exact: true, role: ['button'] });
  const fin = await call('click', { text: 'Finish', exact: true, role: ['button'] });
  assert(!fin.openModal, `flow modal still open: ${fin.openModal}`);
}, { needs: ['acctId', 'contact'] });

await test('fixture: LWC quick action (combobox, radio, checkbox group, toggle, record picker, dual listbox)', async () => {
  await go(`/lightning/r/Account/${state.acctId}/view`);
  const a = await call('recordAction', { label: 'Claude Bridge LWC Action' }).catch(() => null);
  if (!a) throw skip('LWC quick action not deployed (salesforce/ fixtures)');
  const r = await call('fill', {
    fields: [
      { label: 'Project Name', value: `LWC ${RUN}` }, { label: 'Priority', value: 'Medium' },
      { label: 'Contact Method', value: 'Email' }, { label: 'Regions', value: ['South'] },
      { label: 'Agree to Terms', value: true }, { label: 'Urgent', value: true },
      { label: 'Start Date', value: 'Dec 31, 2026' }, { label: 'Budget', value: '250' },
      { label: 'Related Contact', value: CONTACT, search: CONTACT },
      { label: 'Products', value: 'Beta, Delta' }, { label: 'Notes', value: 'lwc notes' },
    ],
    submit: 'Submit',
  });
  for (const f of r.fields) assert(!f.error, `${f.label}: ${f.error}`);
  const t = (await call('getText', {})).text;
  for (const k of [`name=LWC ${RUN}`, 'priority=Medium', 'method=Email', 'regions=South', 'agree=true', 'urgent=true', 'products=Beta,Delta']) {
    assert(t.includes(k), `result missing ${k}`);
  }
  assert(/contact=003/.test(t), 'record picker value missing');
  await cancelModal();
}, { needs: ['acctId', 'contact'] });

// ---------------------------------------------------------------------------
// Opportunity tests: need the optional Opportunity fixtures (custom fields, validation rule, Path); skipped without them.
// (Bridge_Contact__c, Bridge_No_Match_Contact__c, Bridge_Account_Name_Source__c,
// validation rule Bridge_Needs_Contact, Path Bridge_Opportunity_Path).
const OPP = `Bridge E2E Opp ${RUN}`;
const oppView = () => go(`/lightning/r/Opportunity/${state.oppId}/view`);
// Discard an inline edit left open on a record page.
const cancelInline = () => call('click', { text: 'Cancel', exact: true, role: ['button'], scope: 'page', timeoutMs: 1500, scrollToFind: false }).catch(() => null);

await test('fill: "Account Name" picks the lookup, not the "Account Name Source" picklist; ambiguity, kind', async () => {
  const n = await go('/lightning/o/Opportunity/new?count=1&nooverride=1');
  assert(/New Opportunity/.test(n.openModal || ''), `modal not open: ${n.openModal}`);
  const probe = await call('fill', { fields: [{ label: 'Account Name Source', value: 'Unknown' }] });
  if (probe.fields[0].error && /no form field/.test(probe.fields[0].error)) throw skip('Opportunity fixtures not deployed (salesforce/)');
  const r = await call('fill', {
    fields: [
      { label: 'Opportunity Name', value: OPP },
      { label: 'Account Nam', value: ACCT, search: ACCT }, // prefix of both fields: must report the ambiguity
      { label: 'Account Name', value: 'Other', kind: 'picklist' }, // kind chooses the picklist
      { label: 'Close Date', value: '12/31/2026' },
      { label: 'Stage', value: 'Prospecting' },
    ],
    submit: 'Save',
  });
  for (const f of r.fields) assert(!f.error, `${f.label}: ${f.error}`);
  const [, acct, src] = r.fields;
  assert(acct.kind === 'lookup' && acct.value === ACCT, `Account Nam filled ${acct.kind} = ${acct.value}`);
  assert(/2 fields match "Account Nam".*lookup "Account Name".*picklist "Account Name Source"/.test(acct.ambiguous || ''), `no ambiguity report: ${JSON.stringify(acct)}`);
  assert(src.kind === 'picklist' && src.value === 'Other' && /Account Name Source/.test(src.note || ''), `kind:picklist filled ${JSON.stringify(src)}`);
  const m = /\/lightning\/r\/(?:Opportunity\/)?(006\w{12,15})\/view/.exec(r.url);
  if (m) ledger.add(m[1], OPP);
  assert(m, `not on the new opportunity: ${r.url} | ${alertsOf(r)}`);
  state.oppId = m[1];
}, { needs: ['acctId', 'contact'] });

await test('click: comboboxes in a modal match by their field label', async () => {
  await oppView();
  const a = await call('recordAction', { label: 'Edit' });
  assert(/^Edit /.test(a.openModal || ''), `edit modal not open: ${a.openModal}`);
  for (const label of ['Account Name Source', 'Stage', 'Type']) {
    const c = await call('click', { text: label, role: ['combobox'], scope: 'modal' });
    assert(c.clicked.includes(`"${label}"`), `${label}: clicked ${c.clicked}`);
    await call('key', { key: 'Escape' });
  }
  await cancelModal();
}, { needs: ['oppId'] });

await test('fill: read-only record field opens inline edit, fills and saves', async () => {
  await oppView();
  const want = `E2E next ${RUN}`;
  const r = await call('fill', { fields: [{ label: 'Next Step', value: want }], submit: 'Save' });
  const f = r.fields[0];
  assert(!f.error, f.error);
  assert(f.inlineEdit && f.value === want, `not filled through inline edit: ${JSON.stringify(f)}`);
  assert(/^saved/.test(r.submitted?.outcome || ''), `inline save outcome: ${r.submitted?.outcome} | ${alertsOf(r)}`);
  await oppView(); // durable: still there after a reload (Next Step is on the Details tab)
  await call('click', { text: 'Details', exact: true, role: ['tab'] });
  await call('waitFor', { text: want, timeoutMs: 15_000 });
  return f.revealed ? `revealed: ${f.revealed}` : undefined;
}, { needs: ['oppId'] });

await test('lookup: zero results vs no match, typed text and wait, full search, wait_for option', async () => {
  await oppView();
  const z = await call('fill', { fields: [{ label: 'Bridge No Match Contact', value: CONTACT, search: 'E2E', fullSearch: true }] });
  const zd = z.fields[0].details || {};
  assert(zd.status === 'no-results', `filtered lookup: ${z.fields[0].error}`);
  assert(zd.typed === 'E2E' && zd.waitedMs > 0 && zd.fullSearch?.count === 0, `details: ${JSON.stringify(zd)}`);
  await cancelInline();
  const n = await call('fill', { fields: [{ label: 'Bridge Contact', value: 'Nobody Matches This', search: 'E2E', fullSearch: true }] });
  const nd = n.fields[0].details || {};
  assert(nd.status === 'no-match', `plain lookup: ${n.fields[0].error}`);
  assert(nd.fullSearch?.count >= 1 && nd.fullSearch.rows.some((x) => x.includes(CONTACT)), `full search rows: ${JSON.stringify(nd.fullSearch)}`);
  // wait_for sees the lookup's dropdown options
  await call('type', { text: 'Bridge Contact', value: 'E2E', slowly: true });
  const w = await call('waitFor', { option: CONTACT, timeoutMs: 10_000 });
  assert(w.ok, 'option not seen');
  await cancelInline();
  return `zero: "${zd.emptyText || zd.shown?.join(' | ')}", full search ${nd.fullSearch.count} row(s)`;
}, { needs: ['oppId'] });

await test('beforeunload: dirty inline lookup + navigate fails fast and leaves the tab usable', async () => {
  await oppView();
  const f = await call('fill', { fields: [{ label: 'Bridge Contact', value: CONTACT, search: 'E2E' }] }); // no Save
  assert(!f.fields[0].error && f.fields[0].inlineEdit, `inline fill: ${JSON.stringify(f.fields[0])}`);
  assert(/Leave site/.test(f.note || ''), `no unsaved-edit note: ${f.note}`);
  const t0 = Date.now();
  const err = await call('navigate', { url: `${ORG}/lightning/o/Opportunity/list` }, 60_000).then(() => null, (e) => e.message);
  const ms = Date.now() - t0;
  assert(err && /Leave site\?.*Stayed on/.test(err), `navigate did not report the beforeunload dialog: ${err}`);
  assert(ms < 15_000, `took ${ms}ms (the old code timed out after 30s)`);
  const s = await call('snapshot', { maxChars: 2000 }, 30_000); // tab still answers
  assert(/Opportunity/.test(s.text), 'tab not usable after the dialog');
  const ok = await call('navigate', { url: `${ORG}/lightning/o/Opportunity/list`, onBeforeUnload: 'accept' });
  assert(/\/Opportunity\/list/.test(ok.url) && /discarded/.test(ok.note || ''), `accept did not leave: ${ok.url} ${ok.note}`);
  return `reported in ${ms}ms`;
}, { needs: ['oppId'] });

await test('dialog guard: a command on a tab blocked by a JS dialog fails at once, then browser_dialog unblocks', async () => {
  await oppView();
  await call('evaluate', { expression: "setTimeout(() => alert('bridge e2e alert'), 100); 1" });
  await new Promise((r) => setTimeout(r, 800));
  const t0 = Date.now();
  const err = await call('click', { text: 'Edit', role: ['button'], scope: 'header' }, 60_000).then(() => null, (e) => e.message);
  const ms = Date.now() - t0;
  assert(err && /blocked by a JavaScript alert dialog "bridge e2e alert"/.test(err), `click not refused: ${err}`);
  assert(ms < 5000, `took ${ms}ms`);
  const d = await call('dialog', { accept: true });
  assert(d.handled && d.dialog?.type === 'alert', `dialog: ${JSON.stringify(d)}`);
  const s = await call('snapshot', { maxChars: 1000 }, 30_000);
  assert(/Opportunity/.test(s.text), 'tab not usable after answering the dialog');
  return `refused in ${ms}ms`;
}, { needs: ['oppId'] });

await test('path: stages, key fields, guidance, select a stage, key fields editor', async () => {
  await oppView();
  const r = await call('path', {});
  assert(/Prospecting \[current\]/.test(r.stages) && r.current === 'Prospecting', `stages: ${r.stages}`);
  assert((r.keyFields || []).some((k) => k.startsWith('Bridge Contact')), `key fields: ${JSON.stringify(r.keyFields)}`);
  assert(/Bridge guidance: confirm the buying contact/.test(r.guidance || ''), `guidance: ${r.guidance}`);
  assert(/Mark Stage as Complete/.test(r.markButton || ''), `mark button: ${r.markButton}`);
  const q = await call('path', { action: 'select', stage: 'Qualification' });
  assert(q.selected === 'Qualification' && (q.keyFields || []).some((k) => k.startsWith('Bridge No Match Contact')), `select: ${JSON.stringify(q)}`);
  const e = await call('path', { action: 'editKeyFields', stage: 'Prospecting' });
  assert((e.editable || []).some((x) => x.startsWith('Bridge Contact')), `editable: ${JSON.stringify(e.editable)}`);
  if (/modal/.test(e.editor)) await cancelModal(); else await cancelInline();
  return `${r.stages.split(' > ').length} stages; key fields editor: ${e.editor}`;
}, { needs: ['oppId'] });

await test('browser_steps: validation-rule case (error, fill key field, retry, stage moves) in one call', async () => {
  const out = await runSteps((m, p, t) => call(m, p, t), {
    tabId: TAB, evidence: false, // the suite's call() captures each step itself
    steps: [
      { action: 'navigate', name: 'open record', url: `${ORG}/lightning/r/Opportunity/${state.oppId}/view` },
      { action: 'path', name: 'read', expect: { current: 'Prospecting' } },
      { action: 'path', do: 'mark', name: 'try move', stage: 'Qualification', button: 'Mark as Current Stage', expect: { error: 'choose a Bridge Contact' } },
      { action: 'fill', name: 'key field', fields: [{ label: 'Bridge Contact', value: CONTACT, search: 'E2E' }], submit: 'Save', expect: { outcome: 'saved' } },
      { action: 'path', do: 'mark', name: 'retry', stage: 'Qualification', button: 'Mark as Current Stage', expect: { current: 'Qualification', toast: 'Stage changed' } },
      { action: 'wait_for', name: 'value shown', text: CONTACT, timeoutMs: 10_000 },
    ],
  });
  assert(out.ok, `steps failed:\n${out.text}`);
  // a failing expectation stops the run and says why
  const bad = await runSteps((m, p, t) => call(m, p, t), {
    tabId: TAB, evidence: false, // the suite's call() captures each step itself
    steps: [{ action: 'path', expect: { current: 'Closed Won' } }, { action: 'get_text' }],
  });
  assert(!bad.ok && bad.failedAt === 1 && /expected current stage "Closed Won", got "Qualification"/.test(bad.text) && /steps after it were not run/.test(bad.text), `failure report: ${bad.text}`);
  return out.text.split('\n').pop();
}, { needs: ['oppId', 'contact'] });

await test('hub: timeout sends __budgetMs and a cancel to the extension (offline)', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, [new URL('./hub-cancel.test.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], { encoding: 'utf8', env: { ...process.env, BROWSER_BRIDGE_RAW_LOG_DIR: `${process.env.TEMP || '/tmp'}/cbb-rawlog-test` }, stdio: ['ignore', 'pipe', 'ignore'] });
  assert(!/FAIL/.test(out), out);
  return out.trim().split('\n').length + ' checks';
});

// Open a record from a console navigation item's list view.
async function openFromNav(item, name) {
  await call('click', { text: 'Show Navigation Menu', role: ['button'] });
  await call('click', { text: item, exact: true, role: ['menuitem', 'option', 'link'] });
  // narrow the list when it has a search box; otherwise the row is clicked directly
  await call('type', { text: 'Search this list...', value: name, submit: true, timeoutMs: 3000, scrollToFind: false }).catch(() => {});
  await call('click', { text: name, role: ['link'], scope: 'page', timeoutMs: 10_000 });
}

await test('console app (Claude Bridge Console): workspace tabs, subtabs by nav rule, buttons', async () => {
  try {
    await ensureApp('Claude Bridge Console');
    await call('click', { text: 'Dismiss', role: ['button'], scope: 'modal', timeoutMs: 3000 }).catch(() => {});
    // split view reuses the current workspace tab when a list row is clicked
    if (/button "Split view mode" \[expanded\]/.test(await snap())) await call('click', { text: 'Split view mode', role: ['button'] });
    for (let i = 0; i < 10; i++) { // close workspace tabs left from earlier runs
      const c = await call('click', { selector: "button[title^='Close']", within: 'Workspace tabs', timeoutMs: 1000, scrollToFind: false }).catch(() => null);
      if (!c) break;
    }
    const tabsNow = async () => (await snap()).split('\n').filter((l) => /^\s*- tab "/.test(l) && !/"(Activity|Chatter|Related|Details|News)"/.test(l));
    await openFromNav('Accounts', ACCT);
    await openFromNav('Accounts', PARENT);
    let tabs = await tabsNow();
    assert(tabs.some((l) => l.includes(PARENT) && l.includes('[selected]')), `parent workspace not selected:\n${tabs.join('\n')}`);
    assert(tabs.some((l) => l.includes(ACCT)), `account workspace missing:\n${tabs.join('\n')}`);
    await call('click', { text: ACCT, role: ['tab'], within: 'Workspace tabs' });
    // buttons inside a console workspace: record action modal and related-list New
    const e = await call('recordAction', { label: 'Edit', waitForModal: 10_000 }); // console modals can be slow
    // the org may stack its own popup (e.g. "Welcome to Data Cloud!") under the modal
    assert(/(^| > )Edit /.test(e.openModal || ''), `edit modal in console: ${e.openModal}`);
    await cancelModal();
    // with "Contacts open as subtabs of Account", New opens an inline subtab, not a modal
    const n = await call('click', { text: 'New', exact: true, role: ['button'], within: 'Contacts', timeoutMs: 15_000 });
    const asSubtab = (await tabsNow()).some((l) => /tab "Contact New Contact" \[selected\]/.test(l));
    assert(asSubtab || (n.openModal || '').includes('New Contact'), `New within Contacts in console opened neither subtab nor modal: ${n.title}`);
    await call('click', { text: 'Cancel', exact: true, role: ['button'] });
    // nav rule: Contacts open as subtabs of their Account
    await openFromNav('Contacts', CONTACT);
    tabs = await tabsNow();
    assert(tabs.some((l) => l.includes(CONTACT) && l.includes('[selected]')), `contact not open:\n${tabs.join('\n')}`);
    assert(tabs.some((l) => l.includes(ACCT) && l.includes('[selected]')), `contact did not open under its account workspace:\n${tabs.join('\n')}`);
    const amb = await call('click', { text: ACCT, role: ['tab'] });
    assert(/elements match/.test(amb.ambiguous || ''), 'workspace/subtab name clash not reported');
    await call('click', { text: ACCT, role: ['tab'], within: 'Subtabs' });
    tabs = await tabsNow();
    assert(tabs.filter((l) => l.includes(ACCT) && l.includes('[selected]')).length === 2, `account subtab not selected:\n${tabs.join('\n')}`);
    await call('click', { text: CONTACT, role: ['tab'], within: 'Subtabs' });
    await call('click', { text: CONTACT, role: ['button'], within: 'Subtabs' }); // "Close E2E E2E Contact … | Contact"
    await call('click', { text: `Close ${PARENT}`, role: ['button'] });
    await call('click', { text: `Close ${ACCT}`, role: ['button'] });
    tabs = await tabsNow();
    assert(!tabs.some((l) => l.includes(RUN)), `tabs not closed:\n${tabs.join('\n')}`);
  } finally {
    await ensureApp('Developer Edition').catch(() => {}); // never leave the user in the console app
  }
}, { needs: ['acctId', 'parentId', 'contact'] });

await test('guards: no typing into password fields, no evaluate on login pages', async () => {
  const g = await call('open', { url: 'https://the-internet.herokuapp.com/login' });
  const refused = async (method, params) => {
    try { await call(method, { tabId: g.tabId, ...params }); return false; } catch (e) { return /Refused/.test(e.message); }
  };
  assert(await refused('type', { text: 'Password', value: 'x' }), 'type into password not refused');
  const f = await call('fill', { tabId: g.tabId, label: 'Password', value: 'x' });
  assert(/Refused/.test(f.fields[0].error || ''), 'fill password not refused');
  assert(await refused('evaluate', { expression: '1' }), 'evaluate on login page not refused');
  await call('click', { tabId: g.tabId, selector: '#password' });
  assert(await refused('key', { key: 'a' }), 'key into focused password not refused');
  await call('close', { tabId: g.tabId });
});

await test('cleanup: delete created records via Delete action + confirm dialog', async () => {
  // opportunities first, then this run's account (and its contact), parent accounts last
  const rank = (x) => (x.id.startsWith('006') ? 0 : x.name.includes('Parent') ? 2 : 1);
  const items = ledger.read().sort((a, b) => rank(a) - rank(b));
  if (!items.length) throw skip('nothing to clean up');
  let deleted = 0;
  for (const { id, name } of items) {
    const v = await go(`/lightning/r/${id}/view`);
    if (!v.url.includes(id.slice(0, 15))) { ledger.remove(id); continue; } // record gone
    const a = await call('recordAction', { label: 'Delete' }).catch(() => null);
    if (!a) { ledger.remove(id); continue; }
    assert(/Delete/.test(a.openModal || ''), `delete dialog not open for ${name}: ${a.openModal}`);
    const r = await call('click', { text: 'Delete', exact: true, role: ['button'], scope: 'modal' });
    if (!/was deleted/.test(alertsOf(r))) { // toast missed: confirm by revisiting the record
      const v2 = await go(`/lightning/r/${id}/view`);
      const t = (await call('getText', { maxChars: 3000 })).text;
      assert(!v2.url.includes(id.slice(0, 15)) || /deleted|isn't available|doesn't exist|not found/i.test(t), `${name} not deleted: ${alertsOf(r)}`);
    }
    ledger.remove(id);
    deleted++;
  }
  return `deleted ${deleted} record(s)`;
});

// ---------------------------------------------------------------------------
if (TAB && state.window) {
  const w = state.window;
  await call('window', w.state === 'normal' ? { width: w.width, height: w.height, left: w.left, top: w.top } : { state: w.state }).catch(() => {});
}
if (TAB) await call('close', { tabId: TAB }).catch(() => {});
const count = (s) => results.filter((r) => r.status === s).length;
console.log(`\n${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped  (run ${RUN})`);
if (evRun) {
  evRun.finish();
  console.log(`Evidence: ${evRun.dir.replace(/\\/g, '/')}  (dashboard: node dashboard/server.js -> http://127.0.0.1:17380/#/run/claude-bridge-e2e/e2e-${RUN})`);
}
for (const r of results.filter((x) => x.status !== 'PASS')) console.log(`  ${r.status} ${r.name}: ${r.note}`);
bridge.close();
process.exit(count('FAIL') ? 1 : 0);
