#!/usr/bin/env node
// Offline check of the site allow / block lists (extension/sitepolicy.js).
//   node tests/site-policy.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { compile, check } = createRequire(import.meta.url)('../extension/sitepolicy.js');

let n = 0;
const is = (url, allow, block, want, why) => {
  const r = check(url, allow, block);
  assert.equal(r.allowed, want, `${url} -> ${JSON.stringify(r)} (${why})`);
  n++;
};

// The example from the feature request.
const allow = ['abc.my.force.com'];
const block = ['abc.my.force.com/ui/apex/developerconsole'];
is('https://abc.my.force.com/', allow, block, true, 'allowed host');
is('https://abc.my.force.com/lightning/r/Account/001/view', allow, block, true, 'any page of the allowed host');
is('https://abc.my.force.com/ui/apex/developerconsole', allow, block, false, 'blocked path');
is('https://abc.my.force.com/ui/apex/developerconsole?x=1', allow, block, false, 'blocked path with query');
is('https://abc.my.force.com/ui/apex/developerconsole/sub', allow, block, false, 'below the blocked path');
is('https://ABC.my.force.com/UI/apex/DeveloperConsole', allow, block, false, 'case does not matter');
is('https://other.my.force.com/', allow, block, false, 'host not in the allow list');
is('https://abc.my.force.com.evil.com/', allow, block, false, 'host that only starts with the allowed host');
is('https://xabc.my.force.com/', allow, block, false, 'host that only ends with the allowed host');
is('https://abc.my.force.com:8443/x', allow, block, true, 'port allowed when the pattern has none');
is('chrome://settings', allow, block, false, 'non-web page with an allow list set');
is('about:blank', allow, block, true, 'blank page always allowed');

// Empty allow list = no restriction; block list still applies.
is('https://anything.example.com/', [], block, true, 'no allow list');
is('https://abc.my.force.com/ui/apex/developerconsole', [], block, false, 'block list without allow list');

// Wildcards.
is('https://abc.lightning.force.com/one/one.app', ['*.lightning.force.com'], [], true, 'host wildcard');
is('https://lightning.force.com/', ['*.lightning.force.com'], [], false, 'wildcard needs a label');
is('https://evil.com/x.lightning.force.com', ['*.lightning.force.com'], [], false, 'host wildcard does not cross into the path');
is('https://abc.my.salesforce.com/setup/a/b/Users', [], ['abc.my.salesforce.com/setup/*/Users'], false, 'path wildcard');

// Scheme in a plain pattern is ignored; regex patterns test the full URL.
is('https://abc.my.force.com/x', ['https://abc.my.force.com'], [], true, 'scheme ignored');
is('https://abc.my.salesforce.com/_ui/common/apex/debug/ApexCSIPage', [], ['/apexcsipage/'], false, 'regex block');
is('https://abc.my.salesforce.com/lightning/page/home', ['/^https:\\/\\/[a-z0-9-]+\\.my\\.salesforce\\.com\\//'], [], true, 'regex allow');
is('http://abc.my.salesforce.com/', ['/^https:\\/\\/[a-z0-9-]+\\.my\\.salesforce\\.com\\//'], [], false, 'regex allow, wrong scheme');

// Parsing: comments and blank lines ignored, bad lines reported.
const c = compile('# my org\n\nabc.my.force.com\n/([a-/\nbad host/x\n');
assert.equal(c.rules.length, 1);
assert.equal(c.errors.length, 2, JSON.stringify(c.errors));
// g flag must not make repeated tests alternate
const g = compile(['/force/g']);
is('https://a.force.com/', g, [], true, 'g flag 1');
is('https://a.force.com/', g, [], true, 'g flag 2');

// Default lists (loaded on first start): rep pages allowed, Setup menu blocked.
const { DEFAULT_ALLOW: DA, DEFAULT_BLOCK: DB } = createRequire(import.meta.url)('../extension/sitepolicy.js');
assert.equal(compile(DA).errors.length, 0, JSON.stringify(compile(DA).errors));
assert.equal(compile(DB).errors.length, 0, JSON.stringify(compile(DB).errors));
const L = 'https://acme.lightning.force.com';
const SB = 'https://acme--uat.sandbox.lightning.force.com';
const MY = 'https://acme.my.salesforce.com';
for (const [url, want, why] of [
  [`${L}/lightning/o/Account/list?filterName=Recent`, true, 'list view'],
  [`${L}/lightning/o/Opportunity/new?count=1&nooverride=1`, true, 'new record'],
  [`${L}/lightning/o/Case/home`, true, 'object home'],
  [`${L}/lightning/r/Account/001000000000001AAA/view`, true, 'record page'],
  [`${L}/lightning/r/Account/001000000000001AAA/related/Contacts/view`, true, 'related list'],
  [`${L}/lightning/r/Report/00O000000000001AAA/view`, true, 'report'],
  [`${L}/lightning/page/home`, true, 'home'],
  [`${L}/lightning/page/chatter`, true, 'chatter'],
  [`${L}/lightning/n/My_Tab`, true, 'custom tab'],
  [`${L}/lightning/app/06m000000000001AAA`, true, 'app switch'],
  [`${SB}/lightning/r/Contact/003000000000001AAA/view`, true, 'sandbox record page'],
  [`https://acme--c.vf.force.com/apex/MyPage?id=1`, true, 'Visualforce in Lightning'],
  [`${L}/lightning/setup/SetupOneHome/home`, false, 'Setup'],
  [`${L}/lightning/setup/ObjectManager/home`, false, 'Object Manager'],
  [`${L}/lightning/setup/SetupOneHome/home?setupApp=audience360`, false, 'Data Cloud Setup'],
  [`${L}/lightning/setup/SalesforceGo/home`, false, 'Salesforce Go'],
  [`https://acme.my.salesforce-setup.com/lightning/setup/SetupOneHome/home`, false, 'Setup on the setup domain'],
  [`${MY}/_ui/common/apex/debug/ApexCSIPage`, false, 'classic Developer Console'],
  // addresses seen in a live org (Setup menu, Nov 2026)
  [`https://acme.develop.my.salesforce-setup.com/lightning/setup/SetupOneHome/home?SetupDomainProbePassed=true&setupApp=all`, false, 'Setup (live)'],
  [`https://acme.develop.my.salesforce-setup.com/lightning/setup/SalesforceGo/home?setupApp=all`, false, 'Salesforce Go (live)'],
  [`https://acme.develop.my.salesforce-setup.com/lwr/application/platformdx-webconsole?SetupDomainProbePassed=true`, false, 'Web Console (live)'],
  [`${MY}/lwr/application/platformdx-webconsole`, false, 'Web Console without the setup domain'],
  [`${L}/visualEditor/appBuilder.app?id=sfa__Account_rec_L&recordId=001`, false, 'Edit Page (live)'],
  [`https://acme.vibes.salesforce.com/`, false, 'Agentforce Vibes host'],
  [`${L}/builder_platform_interaction/flowBuilder.app?flowId=301`, false, 'Flow Builder'],
  [`${L}/visualEditor/appBuilder.app?id=0M0`, false, 'Lightning App Builder'],
  [`${MY}/servlet/servlet.su?oid=00D&suorgadminid=005`, false, 'Login as user'],
  [`${MY}/services/data/v62.0/sobjects`, false, 'raw API'],
  [`${L}/`, false, 'org root (open a record or list URL instead)'],
  ['https://example.com/', false, 'other website'],
]) is(url, DA, DB, want, why);

// Org identity from the URL (briefs keep a session in one org).
const { orgInfo, sameOrg, DEFAULTS_VERSION } = createRequire(import.meta.url)('../extension/sitepolicy.js');
assert.ok(DEFAULTS_VERSION >= 2, 'defaults version raised after the Web Console rule');
const same = (a, b, want, why) => { assert.equal(sameOrg(a, b), want, `${a} vs ${b}: ${why}`); n++; };
same('https://acme.lightning.force.com/x', 'https://acme.my.salesforce.com/', true, 'Lightning and My Domain of one org');
same('https://acme.lightning.force.com/x', 'https://acme--c.vf.force.com/apex/P', true, 'Visualforce host of the org');
same('https://acme.lightning.force.com/x', 'https://acme.file.force.com/sfc/x', true, 'file host of the org');
same('https://acme.lightning.force.com/x', 'https://acme--uat.sandbox.lightning.force.com/', false, 'production vs its sandbox');
same('https://acme--uat.sandbox.lightning.force.com/', 'https://acme--uat--c.sandbox.vf.force.com/', true, 'sandbox and its Visualforce host');
same('https://acme--uat.sandbox.lightning.force.com/', 'https://acme--dev.sandbox.lightning.force.com/', false, 'two sandboxes');
same('https://acme.lightning.force.com/', 'https://acmex.lightning.force.com/', false, 'look-alike name');
same('https://acme.develop.lightning.force.com/', 'https://acme.lightning.force.com/', false, 'developer org vs production of the same name');
same('https://acme.lightning.force.com/', 'https://example.com/', false, 'non-Salesforce host');
assert.equal(orgInfo('https://acme--uat.sandbox.lightning.force.com/x').type, 'sandbox'); n++;
assert.equal(orgInfo('acme.develop.lightning.force.com').type, 'developer'); n++;
assert.equal(orgInfo('https://acme.scratch.lightning.force.com').type, 'scratch'); n++;
assert.equal(orgInfo('https://acme.lightning.force.com').type, 'production', 'no partition = production (safe assumption)'); n++;
assert.equal(orgInfo('https://example.com'), null); n++;

console.log(`site-policy: ${n} checks passed`);
