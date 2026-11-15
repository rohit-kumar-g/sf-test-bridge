#!/usr/bin/env node
// Offline check of browser_org_info's logic (mcp-server/src/orginfo.js) with
// synthetic UI API answers and a fake extension: trimming, per-user cache,
// "page-only" for users without API access, "cannot" answers, record types.
//   node tests/orginfo.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cbb-orginfo-'));
process.env.BROWSER_BRIDGE_ORG_CACHE = tmp;
const { orgInfo, compactPicklists, compactLayout, cacheClear } = await import('../mcp-server/src/orginfo.js');

const HOST = 'acme--uat.sandbox.lightning.force.com';
const OI = {
  apiName: 'Opportunity', label: 'Opportunity', labelPlural: 'Opportunities', keyPrefix: '006', createable: true, updateable: true, deletable: false,
  defaultRecordTypeId: '012000000000001AAA',
  recordTypeInfos: {
    '012000000000001AAA': { recordTypeId: '012000000000001AAA', name: 'New Business', defaultRecordTypeMapping: true, available: true, master: false },
    '012000000000002AAA': { recordTypeId: '012000000000002AAA', name: 'Renewal', defaultRecordTypeMapping: false, available: true, master: false },
  },
  fields: {
    StageName: { apiName: 'StageName', label: 'Stage', dataType: 'Picklist', required: true, createable: true, updateable: true },
    Discount__c: { apiName: 'Discount__c', label: 'Discount', dataType: 'Percent', createable: true, updateable: true, custom: true, inlineHelpText: 'Over 20% needs an approver' },
    Region__c: { apiName: 'Region__c', label: 'Region', dataType: 'Picklist', createable: true, updateable: true, custom: true, controllerName: 'Type' },
    Score__c: { apiName: 'Score__c', label: 'Score', dataType: 'Double', calculated: true, createable: false, updateable: false, custom: true },
    AccountId: { apiName: 'AccountId', label: 'Account ID', dataType: 'Reference', createable: true, updateable: true, referenceToInfos: [{ apiName: 'Account' }] },
    Code__c: { apiName: 'Code__c', label: 'Code', dataType: 'String', length: 8, createable: true, updateable: true, custom: true },
    Colors__c: { apiName: 'Colors__c', label: 'Colors', dataType: 'MultiPicklist', createable: true, updateable: true, custom: true },
  },
};
const PV = {
  picklistFieldValues: {
    StageName: { defaultValue: { value: 'Prospecting' }, controllerValues: {}, values: [{ value: 'Prospecting', label: 'Prospecting' }, { value: 'Closed Won', label: 'Closed Won' }] },
    Colors__c: { controllerValues: {}, values: [{ value: 'Red', label: 'Red' }, { value: 'Blue', label: 'Blue' }] },
    Region__c: { controllerValues: { 'New Customer': 0, 'Existing Customer': 1 }, values: [{ value: 'EMEA', label: 'EMEA', validFor: [0] }, { value: 'APAC', label: 'Asia Pacific', validFor: [0, 1] }] },
  },
};
const LAYOUT = {
  mode: 'Edit', layoutType: 'Full', recordTypeId: '012000000000001AAA',
  sections: [{ heading: 'Information', layoutRows: [{ layoutItems: [
    { label: 'Opportunity Name', required: true, editableForNew: true, editableForUpdate: true, layoutComponents: [{ componentType: 'Field', apiName: 'Name' }] },
    { label: 'Score', required: false, editableForNew: false, editableForUpdate: false, layoutComponents: [{ componentType: 'Field', apiName: 'Score__c' }] },
    { label: '', layoutComponents: [{ componentType: 'EmptySpace' }] },
  ] }] }],
};

// fake extension: answers orgRead like the real one; counts UI API reads
let reads = 0;
let user = { id: '005000000000001AAA', name: 'Dev User' };
let apiAccess = true;
const answer = (path) => {
  if (!apiAccess) return { status: 403, mode: 'no-api-access', errorCode: 'API_DISABLED_FOR_ORG', message: 'not enabled' };
  if (path === 'chatter/users/me') return { status: 200, mode: 'api', body: user };
  reads++;
  if (path === 'ui-api/object-info') return { status: 200, mode: 'api', body: { objects: { Opportunity: { apiName: 'Opportunity', label: 'Opportunity', nameFields: ['Name'] }, OpportunityHistory: { apiName: 'OpportunityHistory', label: 'Opportunity History', nameFields: [] } } } };
  if (path === 'ui-api/object-info/Opportunity') return { status: 200, mode: 'api', body: OI };
  if (path.startsWith('ui-api/object-info/Opportunity/picklist-values/')) return { status: 200, mode: 'api', body: PV };
  if (path.startsWith('ui-api/layout/Opportunity')) return path.includes('012000000000002AAA') ? { status: 400, mode: 'cannot', errorCode: 'MISSING_RECORD', message: 'no layout' } : { status: 200, mode: 'api', body: LAYOUT };
  if (path === 'ui-api/object-info/Hidden__c') return { status: 404, mode: 'cannot', errorCode: 'NOT_FOUND', message: 'not found' };
  return { status: 404, mode: 'cannot', errorCode: 'NOT_FOUND', message: path };
};
let tabUrl = `https://${HOST}/lightning/o/Opportunity/new?recordTypeId=012000000000001AAA`;
const request = async (method, p) => {
  if (method === 'status') return { lastTabId: 7 };
  if (method === 'tabs') return [{ tabId: 7, url: tabUrl }];
  assert.equal(method, 'orgRead');
  return { host: HOST, orgType: 'sandbox', results: Object.fromEntries(p.paths.map((x) => [x, answer(x)])) };
};

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

let r = await orgInfo(request, {});
ok(r.objects.length === 1 && r.objects[0].startsWith('Opportunity'), `object list keeps layoutable objects (${r.objects})`);

r = await orgInfo(request, { object: 'Opportunity' });
ok(r.org === HOST && r.user === 'Dev User' && r.recordType === 'New Business', 'org, user and default record type');
const f = Object.fromEntries(r.fields.map((x) => [x.apiName, x]));
ok(f.StageName.required && f.StageName.type === 'Picklist', 'required picklist');
ok(f.Score__c.formula && f.Score__c.createable === false, 'formula field, not createable');
ok(f.Region__c.controlledBy === 'Type' && f.AccountId.references[0] === 'Account' && f.Discount__c.helpText, 'dependent picklist, lookup, help text');
ok(r.picklists.StageName.default === 'Prospecting' && r.picklists.StageName.values.includes('Closed Won'), 'picklist values and default');
ok(r.picklists.Region__c.values[0].when[0] === 'New Customer' && r.picklists.Region__c.values[1].when.length === 2, 'dependent values: valid for which controller values');
ok(r.layout.sections[0].fields.length === 2 && r.layout.sections[0].fields[0].required && r.layout.sections[0].fields[1].readOnly, 'layout: required and read-only, empty spaces dropped');
const readsAfterFirst = reads;

r = await orgInfo(request, { object: 'Opportunity' });
ok(reads === readsAfterFirst && r.cached, 'second call served from the cache (no UI API reads)');
r = await orgInfo(request, { object: 'Opportunity', refresh: true });
ok(reads > readsAfterFirst, 'refresh reads again');

user = { id: '005000000000002AAA', name: 'Sales Rep' };
const before = reads;
await orgInfo(request, { object: 'Opportunity' });
ok(reads > before, 'another user does not get the first user\'s cache');
ok(fs.existsSync(path.join(tmp, HOST, '005000000000001AAA')) && fs.existsSync(path.join(tmp, HOST, '005000000000002AAA')), 'cache is per org and per user on disk');

r = await orgInfo(request, { object: 'Opportunity', recordType: 'Renewal' });
ok(r.recordType === 'Renewal' && /no edit layout/.test(r.layout.note), 'record type by name; "cannot" layout reported as an answer');
r = await orgInfo(request, { object: 'Opportunity', recordType: 'Nope' });
ok(/no record type "Nope"/.test(r.error) && /New Business/.test(r.error), 'unknown record type lists the available ones');
r = await orgInfo(request, { object: 'Hidden__c' });
ok(/can't see Hidden__c/.test(r.cannot), 'object the user can\'t see: "cannot"');
await assert.rejects(orgInfo(request, { object: 'Bad Name' }), /API name/); n++;

// ---- fill preparation
const { prepareFill } = await import('../mcp-server/src/orginfo.js');
let pf = await prepareFill(request, { fields: [{ apiName: 'Discount__c', value: '25' }, { label: 'Stage', value: 'closed won' }], submit: 'Save' });
ok(pf.fields[0].label === 'Discount' && !pf.fields[0].apiName && pf.submit === 'Save', 'apiName becomes the label; other params kept');
await assert.rejects(prepareFill(request, { label: 'Stage', value: 'Closed Wonn' }), /nothing was typed.*"Closed Wonn" is not a value of Stage.*Valid: Prospecting, Closed Won/); n++;
await assert.rejects(prepareFill(request, { fields: [{ apiName: 'Nope__c', value: 'x' }] }), /has no field "Nope__c"/); n++;
pf = await prepareFill(request, { label: 'Region', value: 'Asia Pacific' });
ok(pf.fields[0].value === 'Asia Pacific', 'picklist value accepted by its label');
pf = await prepareFill(request, { fields: [{ label: 'Code', value: 'BRIDGE-TEST-1' }, { label: 'Colors', value: 'Red; Blue' }] });
ok(pf.__notes?.[0] === 'Code holds 8 characters; the 13-character value will be cut to "BRIDGE-T"' && pf.fields[0].value === 'BRIDGE-TEST-1', 'too long: still typed, with a note about the cut');
ok(pf.fields[1].value === 'Red; Blue', 'multi-select (MultiPicklist) values checked one by one');
await assert.rejects(prepareFill(request, { label: 'Colors', value: 'Red; Green' }), /"Green" is not a value of Colors/); n++;
tabUrl = `https://${HOST}/lightning/o/Opportunity/new`; // 2 record types, which one is unknown
pf = await prepareFill(request, { label: 'Stage', value: 'Closed Wonn' });
ok(pf.fields[0].value === 'Closed Wonn', 'record type unknown (several): no pre-check, fill decides');
tabUrl = 'https://example.com/';
pf = await prepareFill(request, { label: 'Stage', value: 'x' });
ok(pf.label === 'Stage', 'not a Salesforce page: fill unchanged');
await assert.rejects(prepareFill(request, { apiName: 'Discount__c', value: '1' }), /use the field label/); n++;
tabUrl = `https://${HOST}/lightning/o/Opportunity/new?recordTypeId=012000000000001AAA`;

apiAccess = false;
r = await orgInfo(request, { object: 'Opportunity' });
ok(r.mode === 'page-only' && /no API access/.test(r.note), 'user without API Enabled: page-only with a plain note');
pf = await prepareFill(request, { label: 'Stage', value: 'Closed Wonn' });
ok(pf.label === 'Stage', 'page-only user: label fill unchanged (the form itself decides)');
await assert.rejects(prepareFill(request, { apiName: 'Discount__c', value: '1' }), /apiName can't be resolved/); n++;

ok(compactPicklists({}) && compactLayout({ sections: [] }).sections.length === 0, 'empty answers are handled');
const { compactObject, compactObjectList } = await import('../mcp-server/src/orginfo.js');
const ro = compactObject({ apiName: 'Account', fields: {
  Id: { apiName: 'Id', label: 'Account ID', dataType: 'String', required: true },
  CreatedById: { apiName: 'CreatedById', label: 'Created By ID', dataType: 'Reference', required: true },
  Name: { apiName: 'Name', label: 'Account Name', dataType: 'String', required: true, createable: false, updateable: false },
  Rating__c: { apiName: 'Rating__c', label: 'Rating', dataType: 'Double', calculated: true, custom: true },
} });
ok(!ro.fields.some((x) => ['Id', 'CreatedById'].includes(x.apiName)), 'system audit fields left out');
ok(ro.fields.find((x) => x.apiName === 'Name').required === undefined, 'read-only user: Name not shown as required (can\'t set it)');
ok(ro.fields.some((x) => x.apiName === 'Rating__c' && x.formula), 'custom read-only formula fields kept');
const cb = compactObject({ apiName: 'Opportunity', fields: { IsPrivate: { apiName: 'IsPrivate', label: 'Private', dataType: 'Boolean', required: true, createable: true, updateable: true } } });
ok(cb.fields[0].required === undefined, 'checkbox not shown as required (always true or false)');
ok(compactLayout({ mode: 'Edit', sections: [{ heading: 'Custom Links', layoutRows: [{ layoutItems: [{ label: '' }] }] }] }).sections.length === 0, 'empty layout sections dropped');
// the real list answer has names only (live-checked): apiName, keyPrefix, label, labelPlural, nameFields
const list = compactObjectList({ objects: {
  Account: { apiName: 'Account', label: 'Account', nameFields: ['Name'] },
  AccountHistory: { apiName: 'AccountHistory', label: 'Account History', nameFields: [] },
  Invoice__Share: { apiName: 'Invoice__Share', label: 'Invoice Share', nameFields: ['Name'] },
  Case: { apiName: 'Case', label: 'Case', nameFields: ['CaseNumber'] },
} });
ok(list.join() === 'Account (Account),Case (Case)', `business objects only, no history/share companions (${list})`);
cacheClear(HOST);
ok(!fs.existsSync(path.join(tmp, HOST)), 'clear removes the org\'s cache');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`orginfo: ${n} checks passed`);
