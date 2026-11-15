// A stand-in for @salesforce/core (tests of sfdirect.js): records every request;
// FAKE_CORE_FAIL=1 makes every request fail with a message holding a session id.
const calls = [];
const conn = {
  instanceUrl: 'https://acme--dev.sandbox.my.salesforce.com',
  getApiVersion: () => '62.0',
  async request({ method, url }) {
    calls.push({ method, url });
    if (process.env.FAKE_CORE_FAIL === '1') throw Object.assign(new Error('Session 00D000000000001!AQEAfake.session.value expired or invalid'), { errorCode: 'INVALID_SESSION_ID' });
    if (/\/query\?q=/.test(url)) return { totalSize: 1, done: true, records: [{ Id: '07L000000000001AAA', StartTime: '2026-11-15T07:00:00.000+0000', Operation: '/aura', Status: 'Success', LogLength: 10, LogUser: { Name: 'Dev User' } }] };
    if (/\/ApexLog\/\w+\/Body$/.test(url)) return '62.0 APEX_CODE,FINEST\n12:00:00.0 (1)|USER_DEBUG|[1]|DEBUG|direct body\n';
    return {};
  },
};
module.exports = { calls, Org: { create: async () => ({ getConnection: () => conn }) } };
