// Phase 3: check what changed (the developer's diff) in the real org.
//
// 1. Which source files changed: git diff of the project's package folders
//    (uncommitted + untracked by default, or since a ref), or a given list.
// 2. What each file is (field, validation rule, flow, LWC, ...) and where it
//    shows up in the org (layouts, record pages, quick actions, Path).
// 3. Checks:
//    - against the org's setup (UI API, read-only): is it deployed? same type,
//      picklist values, on the edit layout, required as in the source?
//    - read-only UI checks (no data needed): the field is on the New form,
//      the picklist offers the deployed values
//    - behaviour checks that need test data (validation rules, flows,
//      triggers, LWC, quick actions): a plan for the agent, run with
//      browser_steps under a write brief.
// 4. A report and a snippet for the pull request.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadProject, classify } from './project.js';
import { orgInfo } from './orginfo.js';

// ---- 1. changed files ----
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const STATUS = { A: 'added', M: 'changed', D: 'deleted', R: 'renamed', C: 'copied', T: 'changed', U: 'changed', '?': 'added' };

export function changedFiles(root, { since, files } = {}) {
  if (Array.isArray(files) && files.length) {
    return { source: 'given files', changes: files.map((f) => ({ file: path.relative(root, path.resolve(root, f)).replace(/\\/g, '/'), status: 'changed' })) };
  }
  let top;
  try { top = git(root, ['rev-parse', '--show-toplevel']); } catch {
    throw new Error(`${root} is not in a git repository: pass files (the changed source files) instead.`);
  }
  let pkgs = ['force-app'];
  try { pkgs = JSON.parse(fs.readFileSync(path.join(root, 'sfdx-project.json'), 'utf8')).packageDirectories.map((p) => p.path); } catch { /* default */ }
  const specs = pkgs.map((p) => path.relative(top, path.join(root, p)).replace(/\\/g, '/'));
  const read = (base) => {
    const out = [];
    // no rename detection: a different file name is a different API name (delete + add)
    const diff = git(top, ['diff', '--name-status', '--no-renames', base, '--', ...specs]);
    for (const line of diff.split('\n').filter(Boolean)) {
      const [st, a, b] = line.split('\t');
      out.push({ file: (b || a), status: STATUS[st[0]] || 'changed' });
    }
    if (base === 'HEAD') {
      for (const f of git(top, ['ls-files', '--others', '--exclude-standard', '--', ...specs]).split('\n').filter(Boolean)) out.push({ file: f, status: 'added' });
    }
    return out.map((c) => ({ ...c, file: path.relative(root, path.join(top, c.file)).replace(/\\/g, '/') }));
  };
  if (since) return { source: `changes since ${since} (including uncommitted)`, changes: read(since) };
  let changes = [];
  try { changes = read('HEAD'); } catch { /* no commits yet */ }
  if (changes.length) return { source: 'uncommitted changes', changes };
  try { return { source: 'the last commit', changes: read('HEAD~1') }; } catch { return { source: 'no changes', changes: [] }; }
}

// ---- 2. components ----
export function componentsOf(changes) {
  const map = new Map();
  for (const ch of changes) {
    const c = classify(ch.file);
    if (['other', 'apexClassMeta', 'apexTriggerMeta', 'visualforcePageMeta'].includes(c.kind) && !/\.(cls|trigger)-meta\.xml$/.test(ch.file)) continue;
    const kind = c.kind.replace(/Meta$/, ''); // a class's / trigger's meta file counts as the class / trigger
    const key = `${kind}:${c.object || ''}:${c.name}`;
    const prev = map.get(key);
    if (prev) { prev.files.push(ch.file); if (ch.status !== 'changed') prev.status = ch.status; } else map.set(key, { kind, name: c.name, object: c.object, status: ch.status, files: [ch.file] });
  }
  return [...map.values()];
}

// "a Contact", "an Account"
const an = (w) => `${/^[aeiou]/i.test(String(w)) ? 'an' : 'a'} ${w}`;

// ---- helpers: org names (namespace), types ----
const ORG_TYPE = {
  Text: 'String', TextArea: 'TextArea', LongTextArea: 'TextArea', Html: 'TextArea', Number: 'Double', Currency: 'Currency', Percent: 'Percent',
  Checkbox: 'Boolean', Date: 'Date', DateTime: 'DateTime', Time: 'Time', Email: 'Email', Phone: 'Phone', Url: 'Url', Picklist: 'Picklist',
  MultiselectPicklist: 'MultiPicklist', Lookup: 'Reference', MasterDetail: 'Reference', AutoNumber: 'String', EncryptedText: 'EncryptedString', Location: 'Location',
};
// The org name of a local field: the same, or with the org's namespace prefix
// (an org with a namespace adds it on deploy: Bridge_Contact__c -> ns__Bridge_Contact__c).
export function orgField(fields, localName) {
  const exact = fields.find((f) => f.apiName.toLowerCase() === localName.toLowerCase());
  if (exact) return exact;
  if (!/__c$/i.test(localName)) return null;
  return fields.find((f) => new RegExp(`^[A-Za-z0-9]+__${localName.replace(/[^\w]/g, '')}$`, 'i').test(f.apiName)) || null;
}
const valuesOf = (pv) => (pv?.values || []).map((v) => (typeof v === 'string' ? v : v.value));

// ---- 3. plan + checks ----
export async function verifyChanges({ request, root: start, since, files, runUi = true, org } = {}) {
  const model = loadProject(start || process.cwd());
  if (!model) throw new Error('No Salesforce DX project (sfdx-project.json) found. Pass path.');
  const { source, changes } = changedFiles(model.root, { since, files });
  const comps = componentsOf(changes);
  const result = { project: model.root, source, changedFiles: changes.length, components: [] };
  if (!comps.length) return { ...result, report: `No Salesforce source changes found (${source}).` };

  // org setup per object, once (needs the user's consent; otherwise static checks are skipped)
  const objInfo = new Map();
  let orgNote = null;
  const infoFor = async (object) => {
    if (!object) return null;
    if (objInfo.has(object)) return objInfo.get(object);
    let r = null;
    try {
      r = await orgInfo(request, { object, org });
      if (r.mode === 'page-only' || r.error) { orgNote = orgNote || r.note || r.error; r = null; }
      if (r?.cannot) { orgNote = orgNote || r.cannot; r = { cannot: r.cannot }; }
    } catch (e) { orgNote = orgNote || e.message; }
    objInfo.set(object, r);
    return r;
  };

  const local = (kind, c) => {
    const pick = { field: () => model.objects[c.object]?.fields.find((f) => f.apiName === c.name), validationRule: () => model.objects[c.object]?.validationRules.find((v) => v.name === c.name), recordType: () => model.objects[c.object]?.recordTypes.find((r) => r.name === c.name) };
    const group = { flow: 'flows', flexipage: 'flexipages', layout: 'layouts', permissionSet: 'permissionSets', quickAction: 'quickActions', pathAssistant: 'paths', apexTrigger: 'triggers', apexClass: 'apexClasses', lwc: 'lwc' }[kind];
    return pick[kind] ? pick[kind]() : group ? model[group].find((x) => x.name === c.name) : null;
  };

  const uiForms = new Map(); // object -> [{ label, picklist values }] to check on the New form
  for (const c of comps) {
    const item = { component: `${c.kind}${c.object ? ` ${c.object}.` : ' '}${c.name}`, change: c.status, files: c.files, checks: [], behaviour: [] };
    const add = (check, ok, detail) => item.checks.push({ check, result: ok === true ? 'pass' : ok === false ? 'fail' : 'info', ...(detail ? { detail } : {}) });
    const src = c.status === 'deleted' ? null : local(c.kind, c);

    if (c.kind === 'field') {
      const info = await infoFor(c.object);
      if (info?.fields) {
        const f = orgField(info.fields, c.name);
        if (c.status === 'deleted') add('removed from the org', !f, f ? `${f.apiName} still exists in the org (deletion not deployed?)` : undefined);
        else if (!f) add('deployed', false, `${c.object}.${c.name} is not in the org for this user (not deployed yet, or field-level security hides it)`);
        else {
          item.orgName = f.apiName;
          add('deployed', true, f.apiName !== c.name ? `as ${f.apiName} (org namespace)` : undefined);
          if (src?.label) add('label', f.label === src.label, f.label === src.label ? undefined : `org "${f.label}", source "${src.label}"`);
          const want = ORG_TYPE[src?.type];
          if (want) add('type', f.type === want || (src.formula && f.formula), f.type === want ? undefined : `org ${f.type}, source ${src.type}`);
          if (src?.required != null) add('required', !!f.required === !!src.required, `org ${f.required ? 'required' : 'optional'}, source ${src.required ? 'required' : 'optional'}`);
          if (src?.values) {
            const orgVals = valuesOf(info.picklists?.[f.apiName]);
            const missing = src.values.filter((v) => !orgVals.includes(v));
            const extra = orgVals.filter((v) => !src.values.includes(v));
            add('picklist values', !missing.length && !extra.length, missing.length || extra.length ? `${missing.length ? `missing in org: ${missing.join(', ')}` : ''}${missing.length && extra.length ? '; ' : ''}${extra.length ? `only in org: ${extra.join(', ')}` : ''}` : `${orgVals.length} values match`);
          }
          const onLayout = info.layout?.sections?.some((s) => s.fields.some((x) => x.apiName === f.apiName));
          if (info.layout?.sections) add('on the edit layout', onLayout ? true : null, onLayout ? undefined : 'not on the edit layout this user gets (may be intended)');
          if (onLayout && f.createable !== false) {
            const list = uiForms.get(c.object) || [];
            list.push({ label: f.label, apiName: f.apiName, values: src?.values ? valuesOf(info.picklists?.[f.apiName]) : null });
            uiForms.set(c.object, list);
          }
        }
      } else add('in the org', null, orgNote || `can't read ${c.object} in the org`);
    } else if (c.kind === 'validationRule') {
      add('deployed', null, 'validation rules can\'t be read with the UI API: confirmed by the behaviour test');
      if (src) {
        const info = await infoFor(c.object);
        const ef = src.errorField && info?.fields ? orgField(info.fields, src.errorField) : null;
        item.behaviour.push({
          goal: `Validation rule ${src.name} on ${c.object}${src.active === false ? ' (inactive in source: should NOT fire)' : ''}`,
          condition: src.condition, message: src.message, shownAt: ef?.label || src.errorField || 'top of the form',
          how: [`Open the New ${c.object} form (or edit a test record) and enter data that makes the condition TRUE, then Save: expect the error "${src.message}"${ef ? ` at "${ef.label}"` : ''}.`,
            'Change one value so the condition becomes FALSE and Save again: expect it to save.',
            'Use only test data you create (brief with data: "write"); delete it afterwards.'],
          stepsHint: { action: 'fill', submit: 'Save', expect: { error: src.message } },
        });
      }
    } else if (c.kind === 'flow' && src) {
      if (src.trigger) {
        item.behaviour.push({ goal: `Record-triggered flow ${src.label || src.name} (${src.status})`, object: src.trigger.object, when: `${src.trigger.when} (${src.trigger.timing})`, entry: src.trigger.entry || 'no entry criteria', effects: `${src.recordUpdates} record update(s), ${src.recordCreates} record create(s)`, how: [`Create or update ${an(src.trigger.object)} that meets the entry criteria; then read the record (and related records) for the expected updates.`, 'Also try a record that does NOT meet the criteria: nothing should change.'] });
      } else {
        const qa = model.quickActions.filter((q) => q.flow === src.name);
        item.behaviour.push({ goal: `Screen flow ${src.label || src.name}`, launchedFrom: qa.map((q) => `quick action ${q.name}`).join(', ') || 'not placed by a quick action in this project', screens: src.screens || [], how: [qa.length ? `Open ${an(qa[0].object)} record and run the "${qa[0].label || qa[0].action}" action; walk through the screens ${(src.screens || []).join(' -> ')}.` : 'Find where the flow is launched (Lightning page, button) and run it.'] });
      }
    } else if (c.kind === 'apexTrigger' && src) {
      item.behaviour.push({ goal: `Apex trigger ${src.name}`, object: src.object, events: src.events, how: [`Create / update / delete ${an(src.object)} as the events require (${src.events.join(', ')}) and check the outcome; a failure shows as an error on save.`] });
    } else if (c.kind === 'lwc' && src) {
      item.where = src.usedOn;
      item.behaviour.push({ goal: `LWC ${src.name}`, usedOn: src.usedOn.length ? src.usedOn : ['not placed on a Lightning page or quick action in this project'], how: [src.usedOn.length ? `Open where it is used (${src.usedOn[0]}); check it renders, its labels and buttons, and that no new console errors appear.` : 'Find where it is placed in the org and open it.'] });
    } else if (c.kind === 'quickAction' && src) {
      item.behaviour.push({ goal: `Quick action ${src.name}`, object: src.object, type: src.type, how: [`Open ${an(src.object)} record and run "${src.label || src.action}" (browser_record_action); check its modal / flow / component works.`] });
    } else if (c.kind === 'layout' && src) {
      const info = await infoFor(src.object);
      if (info?.layout?.sections) {
        const orgFields = new Set(info.layout.sections.flatMap((s) => s.fields.map((x) => x.apiName)));
        const missing = src.fields.map((x) => x.field).filter((n) => !/\./.test(n)).filter((n) => !orgFields.has(n) && !(info.fields && orgFields.has(orgField(info.fields, n)?.apiName)));
        add('fields on the edit layout this user gets', !missing.length, missing.length ? `not shown: ${missing.join(', ')} (layout not deployed, or this user is assigned another layout)` : `${src.fields.length} fields shown`);
      } else add('layout in the org', null, orgNote || 'no edit layout for this user');
    } else if (c.kind === 'pathAssistant' && src) {
      item.behaviour.push({ goal: `Path on ${src.object}.${src.field}`, steps: src.steps.map((s) => `${s.value}: ${s.keyFields.join(', ') || '(no key fields)'}`), how: [`Open ${an(src.object)} record; browser_path read: check the stages and the key fields per stage.`] });
    } else if (c.kind === 'permissionSet' && src) {
      item.behaviour.push({ goal: `Permission set ${src.name}`, how: ['Check as a user who has it (persona): the objects and fields it grants are visible / editable (Phase 5 persona check; browser_org_info answers as that user).'], grants: { objects: src.objects.length, fields: src.fields.length } });
    } else if (c.status === 'deleted') {
      add('deleted', null, 'check it is gone where it was used');
    } else {
      add('kind', null, `${c.kind}: no automatic check; look at it where it is used`);
    }
    result.components.push(item);
  }

  // read-only UI checks: the changed fields on the New form, picklist options
  if (runUi && uiForms.size) {
    for (const [object, fields] of uiForms) {
      const info = objInfo.get(object);
      const rt = info?.recordTypes?.find((r) => r.default && !r.master);
      const url = `${info?.org ? `https://${info.org}` : ''}/lightning/o/${object}/new?count=1&nooverride=1${rt ? `&recordTypeId=${rt.id}` : ''}`;
      const ui = { object, checks: [] };
      let tabId = null;
      try {
        const o = await request('open', { url }, 90_000);
        tabId = o.tabId;
        const snap = await request('snapshot', { tabId, maxChars: 60_000 }, 120_000);
        const text = snap.text || '';
        for (const f of fields) {
          const shownOnForm = text.toLowerCase().includes(`"${f.label.toLowerCase()}`);
          ui.checks.push({ check: `"${f.label}" on the New ${object} form`, result: shownOnForm ? 'pass' : 'fail' });
          if (shownOnForm && f.values?.length) {
            try {
              const op = await request('options', { tabId, label: f.label }, 60_000);
              const shownVals = (op.options || []).map((x) => x.name).filter((x) => x && !/^--\s*None\s*--$/i.test(x));
              const missing = f.values.filter((v) => !shownVals.includes(v));
              ui.checks.push({ check: `"${f.label}" offers the deployed values`, result: missing.length ? 'fail' : 'pass', detail: missing.length ? `not offered: ${missing.join(', ')}` : `${shownVals.length} options` });
            } catch (e) { ui.checks.push({ check: `"${f.label}" options`, result: 'info', detail: e.message }); }
          }
        }
      } catch (e) {
        ui.checks.push({ check: `open the New ${object} form`, result: 'fail', detail: e.message });
      } finally {
        if (tabId != null) {
          await request('click', { tabId, text: 'Cancel', exact: true, role: ['button'], scope: 'modal' }, 30_000).catch(() => {});
          await request('close', { tabId }, 30_000).catch(() => {});
        }
      }
      for (const comp of result.components) if (comp.component.startsWith(`field ${object}.`)) comp.ui = ui.checks.filter((x) => fields.some((f) => x.check.includes(`"${f.label}"`) && comp.orgName === f.apiName));
    }
  }
  if (orgNote) result.orgNote = orgNote;
  result.report = renderReport(result);
  return result;
}

// ---- 4. report ----
const MARK = { pass: '✅', fail: '❌', info: 'ℹ️' };
export function renderReport(r) {
  const lines = [`## Change check: ${r.components.length} changed component(s) (${r.source})`, ''];
  lines.push('| Component | Change | Result |', '|---|---|---|');
  for (const c of r.components) {
    const all = [...c.checks, ...(c.ui || [])];
    const fails = all.filter((x) => x.result === 'fail');
    const status = fails.length ? `❌ ${fails.map((x) => `${x.check}${x.detail ? `: ${x.detail}` : ''}`).join('; ')}`
      : all.some((x) => x.result === 'pass') ? `✅ ${all.filter((x) => x.result === 'pass').map((x) => x.check).join(', ')}`
        : c.behaviour.length ? '🧪 needs a behaviour test (below)' : `ℹ️ ${all.map((x) => x.detail || x.check).join('; ') || 'no automatic check'}`;
    lines.push(`| ${c.component}${c.orgName && !c.component.endsWith(c.orgName) ? ` (org: ${c.orgName})` : ''} | ${c.change} | ${status.replace(/\|/g, '/')} |`);
  }
  const beh = r.components.flatMap((c) => c.behaviour);
  if (beh.length) {
    lines.push('', '### Behaviour tests to run (need test data: brief with data "write")', '');
    for (const b of beh) {
      lines.push(`- **${b.goal}**`);
      if (b.condition) lines.push(`  - condition: \`${b.condition}\` -> message "${b.message}" at ${b.shownAt}`);
      if (b.entry) lines.push(`  - runs on ${b.object} ${b.when}; entry: ${b.entry}; ${b.effects}`);
      if (b.usedOn) lines.push(`  - used on: ${b.usedOn.join('; ')}`);
      if (b.launchedFrom) lines.push(`  - launched from: ${b.launchedFrom}${b.screens?.length ? `; screens: ${b.screens.join(' -> ')}` : ''}`);
      if (b.steps) lines.push(`  - stages: ${b.steps.join(' | ')}`);
      for (const h of b.how) lines.push(`  - ${h}`);
    }
  }
  if (r.orgNote) lines.push('', `Note: ${r.orgNote}`);
  return lines.join('\n');
}

// A short block for the pull request / ticket, once the behaviour tests ran.
// Only what was actually checked gets ✅ / ❌; a planned behaviour test that
// has not run yet is 🧪 "to test" (never shown as passed).
export function prSnippet(r, { org, user, behaviourResults = [] } = {}) {
  const lines = [`**Checked in the org with SF Test Bridge** (${new Date().toISOString().slice(0, 10)}${org ? `, ${org}` : ''}${user ? `, as ${user}` : ''})`, ''];
  for (const c of r.components) {
    const all = [...c.checks, ...(c.ui || [])];
    const failed = all.filter((x) => x.result === 'fail');
    const passed = all.some((x) => x.result === 'pass');
    const ran = behaviourResults.filter((b) => c.behaviour.some((x) => x.goal === b.goal));
    let mark;
    let note = '';
    if (failed.length) { mark = '❌'; note = `: ${failed.map((x) => `${x.check}${x.detail ? ` (${x.detail})` : ''}`).join('; ')}`; } else if (ran.length) { mark = ran.every((b) => b.pass) ? '✅' : '❌'; note = ran.map((b) => (b.note ? `: ${b.note}` : '')).join(''); } else if (c.behaviour.length) { mark = '🧪'; note = ': to test'; } else mark = passed ? '✅' : 'ℹ️';
    lines.push(`- ${mark} ${c.component} (${c.change})${note}`);
  }
  return lines.join('\n');
}
