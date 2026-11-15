#!/usr/bin/env node
// A stand-in for the Salesforce CLI (sf) for offline tests of debuglog.js.
// State (records, logs, calls) lives in the JSON file named by FAKE_SF_STATE.
// FAKE_SF_MODE: "production" (org is production), "nolog" (apex run writes no log).
import fs from 'node:fs';

const file = process.env.FAKE_SF_STATE;
const st = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { records: {}, logs: [], calls: [], seq: 0 };
const args = process.argv.slice(2);
st.calls.push(args.join(' '));
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const org = opt('--target-org');
// Only commands that change something save the state: read calls run in
// parallel (several logs at once) and must not overwrite each other's file.
const mutating = /^(data (create|update|delete) record|apex run)/.test(args.slice(0, 3).join(' '));
const save = () => { if (mutating) fs.writeFileSync(file, JSON.stringify(st)); };
const out = (result) => { save(); process.stdout.write(JSON.stringify({ status: 0, result })); process.exit(0); };
const fail = (message) => { save(); process.stdout.write(JSON.stringify({ status: 1, message })); process.exit(1); };
const needOrg = () => { if (!org) fail('no --target-org: refusing the default org'); };
const cmd = args.slice(0, 3).join(' ');
const ORG = { username: 'dev@acme.test', alias: 'acme-dev', instanceUrl: 'https://acme--dev.sandbox.my.salesforce.com', id: '00D000000000001AAA' };

if (cmd.startsWith('org list')) out({ nonScratchOrgs: [ORG, { username: 'prod@acme.test', alias: 'acme-prod', instanceUrl: 'https://acme.my.salesforce.com' }] });
if (cmd.startsWith('org display')) { needOrg(); out({ ...ORG, username: org === 'prod@acme.test' ? 'prod@acme.test' : ORG.username, instanceUrl: org === 'prod@acme.test' ? 'https://acme.my.salesforce.com' : ORG.instanceUrl }); }
if (cmd === 'data query --query' || cmd === 'data query --use-tooling-api') {
  needOrg();
  const q = opt('--query');
  if (/FROM Organization/.test(q)) out({ records: [process.env.FAKE_SF_MODE === 'production' || org === 'prod@acme.test' ? { Id: '00D2', IsSandbox: false, OrganizationType: 'Enterprise Edition' } : { Id: '00D1', IsSandbox: true, OrganizationType: 'Enterprise Edition' }] });
  // the popup's "Log a user": active users by name / username / email, or the background kinds
  if (/FROM User WHERE IsActive = true AND \(/.test(q)) {
    const t = /\(Name LIKE '%(.*?)%'/.exec(q)?.[1]?.replace(/\\_/g, '_').toLowerCase();
    // like the real org: a Profile.* filter never matches a user with no profile
    const bg = (u) => (/UserType IN/.test(q) && ['AutomatedProcess', 'CloudIntegrationUser', 'Guest'].includes(u.UserType))
      || (/Profile\./.test(q) && !!u.Profile && (/Integration/.test(u.Profile.UserLicense?.Name || '') || /API/.test(u.Profile.Name || '')));
    out({ records: (st.users || []).filter((u) => u.IsActive !== false && (t ? `${u.Name} ${u.Username}`.toLowerCase().includes(t) : bg(u))).sort((a, b) => a.Name.localeCompare(b.Name)) });
  }
  // a named user (capture: add logging for another user), else the CLI user
  const uq = /FROM User WHERE (Id|Username) = '([^']+)'/.exec(q);
  const known = uq && (st.users || []).find((x) => x.Id === uq[2] || x.Username === uq[2]);
  if (known) out({ records: [known] });
  if (uq && uq[1] === 'Id') out({ records: [] });
  if (/UserType = 'AutomatedProcess'/.test(q)) { const u = (st.users || []).find((x) => x.Name === 'Automated Process'); out({ records: u ? [u] : [] }); }
  if (/FROM User/.test(q)) out({ records: [{ Id: '005000000000001AAA', Name: 'Dev User' }] });
  if (/FROM EntityDefinition/.test(q)) { const k = /KeyPrefix = '(\w+)'/.exec(q)?.[1]; out({ records: st.entities?.[k] ? [{ QualifiedApiName: st.entities[k] }] : [] }); }
  if (/FROM ApexLog/.test(q)) out({ records: st.logs.map((l) => ({ Id: l.id, StartTime: l.start, Operation: l.operation || 'Api', Status: l.status || 'Success', LogLength: l.text.length, DurationMilliseconds: l.duration ?? 100, LogUserId: l.userId || '005000000000001AAA', LogUser: { Name: l.user || 'Dev User' } })) });
  const lm = /^SELECT LastModifiedDate FROM (\w+) WHERE Id = '(\w+)'$/.exec(q);
  if (lm) { const m = st.modified?.[lm[2]]; out({ records: m ? [{ LastModifiedDate: (typeof m === 'string' ? m : m.at) }] : [] }); }
  // who changed the record last (capture)
  const lmb = /^SELECT LastModifiedDate, LastModifiedById, LastModifiedBy\.Name FROM (\w+) WHERE Id = '(\w+)'$/.exec(q);
  if (lmb) { const m = st.modified?.[lmb[2]]; out({ records: m ? [{ LastModifiedDate: (typeof m === 'string' ? m : m.at), LastModifiedById: m.byId || '005000000000001AAA', LastModifiedBy: { Name: m.by || 'Dev User' } }] : [] }); }
  fail(`unexpected query ${q}`);
}
if (cmd === 'data create record') {
  needOrg();
  const sobject = opt('--sobject');
  const values = opt('--values');
  // like the real org: some categories don't take the highest levels; the message doesn't say which
  const INVALID = /Validation=(FINEST|FINER|FINE|DEBUG)\b|System=(FINEST|FINER)\b|Workflow=FINEST\b|Database=(FINER|FINE)\b/;
  const strict = process.env.FAKE_SF_STRICT && /Callout=FINEST/.test(values);
  if (sobject === 'DebugLevel' && (INVALID.test(values) || strict)) fail('bad value for restricted picklist field: FINEST');
  // a user someone else already logs (one USER_DEBUG trace flag per user)
  if (sobject === 'TraceFlag' && (st.tracedElsewhere || []).some((u) => values.includes(`TracedEntityId=${u}`))) fail('Having more than one trace flag for a traced entity is not allowed.');
  const id = `${sobject === 'DebugLevel' ? '7dl' : '7tf'}${String(++st.seq).padStart(12, '0')}`;
  st.records[id] = { sobject, values, DeveloperName: /DeveloperName=(\S+)/.exec(values)?.[1] };
  out({ id, success: true });
}
if (cmd === 'data update record') {
  needOrg();
  const values = opt('--values');
  if (/Validation=(FINEST|FINER|FINE|DEBUG)\b|System=(FINEST|FINER)\b|Workflow=FINEST\b|Database=(FINER|FINE)\b/.test(values) || (process.env.FAKE_SF_STRICT && /Callout=FINEST/.test(values))) fail('bad value for restricted picklist field: FINEST');
  const r = st.records[opt('--record-id')]; if (!r) fail('not found'); r.values += ` ${values}`; out({ id: opt('--record-id') });
}
if (cmd === 'data delete record') { needOrg(); const id = opt('--record-id'); if (!st.records[id]) fail('entity is deleted'); delete st.records[id]; out({ id }); }
if (cmd === 'data get record') { needOrg(); const r = st.records[opt('--record-id')]; if (!r) fail('not found'); out({ Id: opt('--record-id'), DeveloperName: r.DeveloperName }); }
if (cmd.startsWith('apex run')) {
  needOrg();
  const code = fs.readFileSync(opt('--file'), 'utf8');
  if (process.env.FAKE_SF_MODE !== 'nolog') st.logs.push({ id: `07L${String(++st.seq).padStart(12, '0')}`, start: new Date().toISOString(), text: `12:00:00.001 (1)|USER_DEBUG|[1]|DEBUG|${/'(.*)'/.exec(code)[1]}\n` });
  out({ success: true, compiled: true });
}
if (cmd.startsWith('apex get log')) { needOrg(); const l = st.logs.find((x) => x.id === opt('--log-id')); out([{ log: l ? l.text : '' }]); }
fail(`unexpected command: ${args.join(' ')}`);
