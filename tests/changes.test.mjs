#!/usr/bin/env node
// Offline check of sf_verify_change (mcp-server/src/changes.js): a temp git
// repo with a synthetic project, real git diffs, and a fake extension that
// plays an org WITH a namespace ("acme__"), so names differ from the source.
//   node tests/changes.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cbb-changes-'));
process.env.BROWSER_BRIDGE_ORG_CACHE = path.join(tmp, '.orgcache');
const { verifyChanges, changedFiles, componentsOf, orgField, prSnippet } = await import('../mcp-server/src/changes.js');

const root = path.join(tmp, 'proj');
const D = 'force-app/main/default';
const put = (rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const X = (tag, body) => `<?xml version="1.0" encoding="UTF-8"?>\n<${tag} xmlns="http://soap.sforce.com/2006/04/metadata">${body}</${tag}>`;
const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// baseline
put('sfdx-project.json', JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], namespace: '' }));
put(`${D}/objects/Opportunity/fields/Discount__c.field-meta.xml`, X('CustomField', '<fullName>Discount__c</fullName><label>Discount</label><type>Percent</type>'));
put(`${D}/objects/Opportunity/fields/Old__c.field-meta.xml`, X('CustomField', '<fullName>Old__c</fullName><label>Old</label><type>Text</type>'));
put(`${D}/objects/Opportunity/fields/Tier__c.field-meta.xml`, X('CustomField', '<fullName>Tier__c</fullName><label>Tier</label><type>Picklist</type><valueSet><valueSetDefinition><value><fullName>Gold</fullName></value><value><fullName>Silver</fullName></value></valueSetDefinition></valueSet>'));
git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('add', '-A'); git('commit', '-q', '-m', 'base');

// the developer's work (uncommitted)
put(`${D}/objects/Opportunity/fields/Discount__c.field-meta.xml`, X('CustomField', '<fullName>Discount__c</fullName><label>Discount %</label><type>Percent</type><required>true</required>'));
put(`${D}/objects/Opportunity/fields/Tier__c.field-meta.xml`, X('CustomField', '<fullName>Tier__c</fullName><label>Tier</label><type>Picklist</type><valueSet><valueSetDefinition><value><fullName>Gold</fullName></value><value><fullName>Silver</fullName></value><value><fullName>Bronze</fullName></value></valueSetDefinition></valueSet>'));
put(`${D}/objects/Opportunity/fields/New_Field__c.field-meta.xml`, X('CustomField', '<fullName>New_Field__c</fullName><label>New Field</label><type>Text</type>'));
put(`${D}/objects/Opportunity/validationRules/Discount_Needs_Approver.validationRule-meta.xml`, X('ValidationRule', '<fullName>Discount_Needs_Approver</fullName><active>true</active><errorConditionFormula>Discount__c &gt; 0.2</errorConditionFormula><errorDisplayField>Discount__c</errorDisplayField><errorMessage>Over 20% needs approval.</errorMessage>'));
put(`${D}/lwc/dealBadge/dealBadge.js`, 'export default class X {}');
put(`${D}/lwc/dealBadge/dealBadge.js-meta.xml`, X('LightningComponentBundle', '<isExposed>true</isExposed>'));
put(`${D}/flexipages/Opp_Page.flexipage-meta.xml`, X('FlexiPage', '<masterLabel>Opp Page</masterLabel><type>RecordPage</type><sobjectType>Opportunity</sobjectType><flexiPageRegions><itemInstances><componentInstance><componentName>c:dealBadge</componentName></componentInstance></itemInstances></flexiPageRegions>'));
fs.rmSync(path.join(root, D, 'objects/Opportunity/fields/Old__c.field-meta.xml'));

// fake org (namespace acme__): Discount deployed with the OLD label and optional,
// Tier deployed without Bronze, Old__c still there, New_Field__c missing
const HOST = 'acme--dev.sandbox.lightning.force.com';
const OI = {
  apiName: 'Opportunity', label: 'Opportunity', createable: true, updateable: true, deletable: true, defaultRecordTypeId: '012000000000000AAA',
  recordTypeInfos: { '012000000000000AAA': { recordTypeId: '012000000000000AAA', name: 'Master', defaultRecordTypeMapping: true, available: true, master: true } },
  fields: {
    Name: { apiName: 'Name', label: 'Opportunity Name', dataType: 'String', required: true, createable: true, updateable: true },
    acme__Discount__c: { apiName: 'acme__Discount__c', label: 'Discount', dataType: 'Percent', createable: true, updateable: true, custom: true },
    acme__Tier__c: { apiName: 'acme__Tier__c', label: 'Tier', dataType: 'Picklist', createable: true, updateable: true, custom: true },
    acme__Old__c: { apiName: 'acme__Old__c', label: 'Old', dataType: 'String', createable: true, updateable: true, custom: true },
  },
};
const PV = { picklistFieldValues: { acme__Tier__c: { controllerValues: {}, values: [{ value: 'Gold', label: 'Gold' }, { value: 'Silver', label: 'Silver' }] } } };
const LAYOUT = { mode: 'Edit', sections: [{ heading: 'Info', layoutRows: [{ layoutItems: [
  { label: 'Opportunity Name', required: true, layoutComponents: [{ componentType: 'Field', apiName: 'Name' }] },
  { label: 'Discount', layoutComponents: [{ componentType: 'Field', apiName: 'acme__Discount__c' }] },
  { label: 'Tier', layoutComponents: [{ componentType: 'Field', apiName: 'acme__Tier__c' }] },
] }] }] };
const calls = [];
const request = async (method, p) => {
  calls.push(method);
  if (method === 'orgRead') {
    const ans = (x) => (x === 'chatter/users/me' ? { status: 200, mode: 'api', body: { id: '005000000000001AAA', name: 'Dev' } }
      : x === 'ui-api/object-info/Opportunity' ? { status: 200, mode: 'api', body: OI }
        : x.startsWith('ui-api/object-info/Opportunity/picklist-values') ? { status: 200, mode: 'api', body: PV }
          : x.startsWith('ui-api/layout/Opportunity') ? { status: 200, mode: 'api', body: LAYOUT }
            : { status: 404, mode: 'cannot', errorCode: 'NOT_FOUND', message: x });
    return { host: HOST, orgType: 'sandbox', results: Object.fromEntries(p.paths.map((x) => [x, ans(x)])) };
  }
  if (method === 'open') { assert.match(p.url, /\/lightning\/o\/Opportunity\/new\?count=1&nooverride=1/); return { tabId: 9 }; }
  if (method === 'snapshot') return { text: '- textbox "Opportunity Name" [ref=e1]\n- spinbutton "Discount" [ref=e2]\n- combobox "Tier" [ref=e3]' };
  if (method === 'options') return { field: p.label, options: [{ name: '--None--' }, { name: 'Gold' }, { name: 'Silver' }] };
  if (method === 'click' || method === 'close') return {};
  throw new Error(`unexpected ${method}`);
};

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

const ch = changedFiles(root);
ok(ch.source === 'uncommitted changes' && ch.changes.length === 8, `uncommitted + untracked files (${ch.changes.length}: ${ch.changes.map((c) => `${c.status} ${path.basename(c.file)}`).join(', ')})`);
const comps = componentsOf(ch.changes);
ok(comps.find((c) => c.kind === 'lwc').files.length === 2, 'the LWC bundle\'s files count as one component');
ok(comps.find((c) => c.name === 'Old__c').status === 'deleted', 'deleted field');
ok(orgField(Object.values(OI.fields), 'Discount__c').apiName === 'acme__Discount__c' && !orgField(Object.values(OI.fields), 'Count__c'), 'namespace: Discount__c -> acme__Discount__c; no false suffix match');

const r = await verifyChanges({ request, root, org: `https://${HOST}` });
const by = (s) => r.components.find((c) => c.component.includes(s));
const res = (c, check) => c.checks.find((x) => x.check === check)?.result;
const disc = by('Discount__c');
ok(res(disc, 'deployed') === 'pass' && disc.orgName === 'acme__Discount__c', 'Discount deployed under the org namespace');
ok(res(disc, 'label') === 'fail' && /org "Discount", source "Discount %"/.test(disc.checks.find((x) => x.check === 'label').detail), 'label change not deployed yet');
ok(res(disc, 'required') === 'fail', 'required in source, optional in org');
const tier = by('Tier__c');
ok(res(tier, 'picklist values') === 'fail' && /missing in org: Bronze/.test(tier.checks.find((x) => x.check === 'picklist values').detail), 'new picklist value not deployed');
ok(tier.ui.find((x) => /offers/.test(x.check)).result === 'pass', 'UI: the form offers the deployed values (the missing Bronze is caught by the deploy check above)');
ok(tier.ui.find((x) => /on the New Opportunity form/.test(x.check)).result === 'pass', 'UI: field shown on the New form');
ok(res(by('New_Field__c'), 'deployed') === 'fail', 'new field not deployed');
ok(res(by('Old__c'), 'removed from the org') === 'fail', 'deleted in source, still in the org');
const vr = by('Discount_Needs_Approver').behaviour[0];
ok(vr.condition === 'Discount__c > 0.2' && vr.message === 'Over 20% needs approval.' && vr.shownAt === 'Discount', 'validation rule plan: condition, message, shown at the org label');
ok(by('dealBadge').behaviour[0].usedOn[0] === 'flexipage Opp_Page (Opportunity)', 'LWC plan: where it is used');
ok(calls.includes('click') && calls.includes('close'), 'UI check cancels the form and closes its tab');
ok(/## Change check: \d+ changed component/.test(r.report) && /Behaviour tests to run/.test(r.report) && /acme__Discount__c/.test(r.report), 'report: table, behaviour section, org names');
const snip = prSnippet(r, { org: HOST });
ok(/❌ field Opportunity.Tier__c .*picklist values/.test(snip), 'PR snippet: failed check with its reason');
ok(/🧪 validationRule Opportunity.Discount_Needs_Approver \(added\): to test/.test(snip) && !/✅ validationRule/.test(snip), 'PR snippet: planned behaviour test is "to test", never passed');
const snip2 = prSnippet(r, { behaviourResults: [{ goal: by('Discount_Needs_Approver').behaviour[0].goal, pass: true, note: 'blocked with the message' }] });
ok(/✅ validationRule Opportunity.Discount_Needs_Approver \(added\): blocked with the message/.test(snip2), 'PR snippet: behaviour test that ran and passed');

// no UI run, given files instead of git
const r2 = await verifyChanges({ request, root, files: [`${D}/objects/Opportunity/fields/Tier__c.field-meta.xml`], runUi: false });
ok(r2.components.length === 1 && !r2.components[0].ui, 'given files, no UI checks');

// nothing changed
git('add', '-A'); git('commit', '-q', '-m', 'work');
const r3 = changedFiles(root);
ok(r3.source === 'the last commit' && r3.changes.length === 8, 'no uncommitted changes: falls back to the last commit');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`changes: ${n} checks passed`);
