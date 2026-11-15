#!/usr/bin/env node
// Offline check of the local Salesforce DX project model (mcp-server/src/project.js)
// on a synthetic mini project written to a temp folder.
//   node tests/project.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { loadProject, projectView, classify, parseXml, findProject } from '../mcp-server/src/project.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cbb-proj-'));
const D = 'force-app/main/default';
const put = (rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const X = (tag, body) => `<?xml version="1.0" encoding="UTF-8"?>\n<${tag} xmlns="http://soap.sforce.com/2006/04/metadata">${body}</${tag}>`;

put('sfdx-project.json', JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }] }));
put(`${D}/objects/Opportunity/fields/Discount__c.field-meta.xml`, X('CustomField', '<fullName>Discount__c</fullName><label>Discount</label><type>Percent</type><required>false</required>'));
put(`${D}/objects/Opportunity/fields/Approver__c.field-meta.xml`, X('CustomField', '<fullName>Approver__c</fullName><label>Approver</label><type>Lookup</type><referenceTo>User</referenceTo>'));
put(`${D}/objects/Opportunity/fields/Region__c.field-meta.xml`, X('CustomField', '<fullName>Region__c</fullName><label>Region</label><type>Picklist</type><valueSet><controllingField>Type</controllingField><restricted>true</restricted><valueSetDefinition><value><fullName>EMEA</fullName></value><value><fullName>APAC</fullName></value></valueSetDefinition><valueSettings><controllingFieldValue>New Customer</controllingFieldValue><valueName>EMEA</valueName></valueSettings></valueSet>'));
put(`${D}/objects/Opportunity/validationRules/Discount_Needs_Approver.validationRule-meta.xml`, X('ValidationRule', '<fullName>Discount_Needs_Approver</fullName><active>true</active><errorConditionFormula>Discount__c &gt; 0.2 &amp;&amp; ISBLANK(Approver__c)</errorConditionFormula><errorDisplayField>Approver__c</errorDisplayField><errorMessage>Discounts over 20% need an approver.</errorMessage>'));
put(`${D}/flows/Opp_After_Save.flow-meta.xml`, X('Flow', '<label>Opp After Save</label><processType>AutoLaunchedFlow</processType><status>Active</status><start><object>Opportunity</object><recordTriggerType>CreateAndUpdate</recordTriggerType><triggerType>RecordAfterSave</triggerType><filterLogic>and</filterLogic><filters><field>StageName</field><operator>EqualTo</operator><value><stringValue>Closed Won</stringValue></value></filters></start><recordUpdates><name>u1</name></recordUpdates>'));
put(`${D}/triggers/OppTrigger.trigger`, 'trigger OppTrigger on Opportunity (before insert, before update) {\n  // ...\n}\n');
put(`${D}/lwc/discountBadge/discountBadge.js`, 'export default class X {}');
put(`${D}/lwc/discountBadge/discountBadge.js-meta.xml`, X('LightningComponentBundle', '<isExposed>true</isExposed><targets><target>lightning__RecordPage</target></targets>'));
put(`${D}/flexipages/Opportunity_Record_Page.flexipage-meta.xml`, X('FlexiPage', '<masterLabel>Opportunity Record Page</masterLabel><type>RecordPage</type><sobjectType>Opportunity</sobjectType><flexiPageRegions><itemInstances><componentInstance><componentName>c:discountBadge</componentName></componentInstance></itemInstances><itemInstances><componentInstance><componentName>force:detailPanel</componentName></componentInstance></itemInstances></flexiPageRegions>'));
put(`${D}/layouts/Opportunity-Opportunity %28Sales%29 Layout.layout-meta.xml`, X('Layout', '<layoutSections><label>Info</label><layoutColumns><layoutItems><behavior>Required</behavior><field>Name</field></layoutItems><layoutItems><behavior>Edit</behavior><field>Discount__c</field></layoutItems></layoutColumns></layoutSections>'));
put(`${D}/permissionsets/Sales_Rep.permissionset-meta.xml`, X('PermissionSet', '<label>Sales Rep</label><fieldPermissions><field>Opportunity.Discount__c</field><readable>true</readable><editable>false</editable></fieldPermissions><objectPermissions><object>Opportunity</object><allowRead>true</allowRead><allowCreate>true</allowCreate><allowEdit>true</allowEdit><allowDelete>false</allowDelete></objectPermissions>'));
put(`${D}/pathAssistants/Opp_Path.pathAssistant-meta.xml`, X('PathAssistant', '<active>true</active><entityName>Opportunity</entityName><fieldName>StageName</fieldName><masterLabel>Opp Path</masterLabel><pathAssistantSteps><fieldNames>Discount__c</fieldNames><picklistValueName>Proposal</picklistValueName></pathAssistantSteps>'));

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };

ok(findProject(path.join(root, D, 'flows')) === root, 'finds the project upward from a subfolder');
ok(classify('x/objects/Account/fields/A__c.field-meta.xml').object === 'Account', 'classify: field object');
ok(classify('x/lwc/fooBar/fooBar.html').kind === 'lwc', 'classify: LWC bundle file');
ok(parseXml('<a><b>1 &amp; 2</b><c/></a>').children[0].text === '1 & 2', 'xml entities decoded');

const m = loadProject(root);
ok(m && m.counts.fields === 3 && m.counts.validationRules === 1, `counts ${JSON.stringify(m?.counts)}`);
const vr = m.objects.Opportunity.validationRules[0];
ok(vr.condition === 'Discount__c > 0.2 && ISBLANK(Approver__c)' && vr.message.startsWith('Discounts over 20%') && vr.errorField === 'Approver__c', 'validation rule: formula decoded, message, error field');
const region = m.objects.Opportunity.fields.find((f) => f.apiName === 'Region__c');
ok(region.controllingField === 'Type' && region.values.join() === 'EMEA,APAC' && region.dependencies[0].when[0] === 'New Customer', 'dependent picklist');
ok(m.objects.Opportunity.fields.find((f) => f.apiName === 'Approver__c').referenceTo === 'User', 'lookup target');
const flow = m.flows[0];
ok(flow.trigger.object === 'Opportunity' && flow.trigger.when === 'CreateAndUpdate' && /StageName EqualTo Closed Won/.test(flow.trigger.entry), `record-triggered flow ${JSON.stringify(flow.trigger)}`);
ok(m.triggers[0].object === 'Opportunity' && m.triggers[0].events.join() === 'before insert,before update', 'Apex trigger object and events');
ok(m.lwc[0].name === 'discountBadge' && m.lwc[0].usedOn[0] === 'flexipage Opportunity_Record_Page (Opportunity)', `LWC usage ${JSON.stringify(m.lwc[0].usedOn)}`);
ok(m.layouts[0].object === 'Opportunity' && m.layouts[0].layout === 'Opportunity (Sales) Layout' && m.layouts[0].fields[0].behavior === 'Required', 'layout name decoded, required field');
ok(m.permissionSets[0].fields[0].edit === false && m.permissionSets[0].objects[0].delete === false, 'permission set field and object access');
ok(m.paths[0].object === 'Opportunity' && m.paths[0].steps[0].keyFields[0] === 'Discount__c', 'Path key fields');

const v = projectView(m, { object: 'Opportunity' });
ok(v.flows.length === 1 && v.triggers.length === 1 && v.paths.length === 1 && v.flexipages[0].customComponents[0] === 'discountBadge', 'object view gathers flows, triggers, paths, pages');
ok(projectView(m).lwc[0].includes('-> flexipage'), 'summary shows where each LWC is used');

fs.rmSync(root, { recursive: true, force: true });
console.log(`project: ${n} checks passed`);
