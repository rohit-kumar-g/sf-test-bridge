// SF Test Bridge - site allow / block lists.
// Shared by the service worker (importScripts), the popup (<script>) and the
// Node unit test (tests/site-policy.test.mjs). No chrome.* calls in here.
//
// One pattern per line. Two forms:
//   plain   host[:port][/path-prefix]   e.g.  abc.my.salesforce.com
//                                             abc.my.salesforce.com/_ui/common/apex/debug
//                                             *.lightning.force.com
//                                             */_ui/common/apex/debug   (that path on any host)
//           A leading http:// or https:// is ignored. "*" in the host matches
//           within the host only (one or more labels); "*" in the path
//           matches anything. A host-only pattern matches every page of that
//           host (not other hosts that merely start with it). A pattern with a
//           path matches pages whose path starts with it.
//   regex   /.../                        e.g.  /^https:\/\/[a-z0-9-]+\.my\.salesforce\.com\//
//           Tested against the full URL.
// All matching ignores case. Empty lines and lines starting with # are ignored.
//
// Decision for a URL:
//   1. matches a block pattern            -> blocked (block always wins)
//   2. the allow list is empty            -> allowed (no restriction set)
//   3. matches an allow pattern           -> allowed
//   4. otherwise                          -> not allowed
// about:blank and about:srcdoc are always allowed (new tabs start there).
(function (root) {
  'use strict';

  const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

  function parseLine(line) {
    const raw = String(line || '').trim();
    if (!raw || raw.startsWith('#')) return null;
    const rx = /^\/(.+)\/([a-z]*)$/.exec(raw);
    if (rx) {
      try {
        // always case-insensitive; g/y would make .test() stateful
        const flags = [...new Set((rx[2] + 'i').replace(/[gy]/g, ''))].join('');
        return { raw, kind: 'regex', re: new RegExp(rx[1], flags) };
      } catch (e) {
        return { raw, error: `invalid regex: ${e.message}` };
      }
    }
    let rest = raw.replace(/^https?:\/\//i, '');
    if (/\s/.test(rest)) return { raw, error: 'contains spaces' };
    const slash = rest.indexOf('/');
    const host = (slash < 0 ? rest : rest.slice(0, slash)).toLowerCase();
    const path = slash < 0 ? '' : rest.slice(slash);
    if (!host) return { raw, error: 'no host' };
    if (!/^[a-z0-9*.\-]+(:\d+)?$/.test(host)) return { raw, error: 'host may only contain letters, digits, ".", "-", "*" and an optional :port' };
    const hostRe = escapeRe(host).replace(/\*/g, '[^/:?#]+');
    const portRe = /:\d+$/.test(host) ? '' : '(?::\\d+)?';
    const pathRe = path ? escapeRe(path).replace(/\*/g, '.*') : '(?:[/?#]|$)';
    return { raw, kind: 'plain', re: new RegExp(`^${hostRe}${portRe}${pathRe}`, 'i') };
  }

  // Lines -> { rules, errors }. Accepts an array or newline-separated text.
  function compile(lines) {
    const list = Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/);
    const rules = [];
    const errors = [];
    for (const l of list) {
      const r = parseLine(l);
      if (!r) continue;
      if (r.error) errors.push(`${r.raw}: ${r.error}`);
      else rules.push(r);
    }
    return { rules, errors };
  }

  function matches(rule, url, u) {
    if (rule.kind === 'regex') return rule.re.test(url);
    // host[:port] + path + query, without the scheme
    return rule.re.test(u.host + u.pathname + u.search);
  }

  // -> { allowed: boolean, reason: string, rule?: string }
  function check(url, allowList, blockList) {
    const href = String(url || '');
    if (/^about:(blank|srcdoc)\b/i.test(href) || href === '') return { allowed: true, reason: 'blank page' };
    let u;
    try { u = new URL(href); } catch { return { allowed: false, reason: 'not a valid URL' }; }
    const allow = Array.isArray(allowList?.rules) ? allowList : compile(allowList);
    const block = Array.isArray(blockList?.rules) ? blockList : compile(blockList);
    const isWeb = /^(https?|file):$/.test(u.protocol);
    if (isWeb) {
      const b = block.rules.find((r) => matches(r, href, u));
      if (b) return { allowed: false, reason: `blocked by "${b.raw}"`, rule: b.raw };
    }
    if (!allow.rules.length) return { allowed: true, reason: 'no allow list set' };
    if (isWeb) {
      const a = allow.rules.find((r) => matches(r, href, u));
      if (a) return { allowed: true, reason: `allowed by "${a.raw}"`, rule: a.raw };
    }
    return { allowed: false, reason: 'not in the allow list' };
  }

  // Defaults, loaded on first start (the user can edit them in the popup, and
  // "Reset to defaults" brings them back). They fit any org: production,
  // sandboxes, developer and scratch orgs all serve Lightning from
  // *.lightning.force.com.
  //
  // Allow: the pages a sales or service user works in. Setup and developer
  // tools are not in this list, so they are refused even without the block list.
  const DEFAULT_ALLOW = [
    '# Record pages and their related lists',
    '*.force.com/lightning/r/',
    '# Object home, list views, New record',
    '*.force.com/lightning/o/',
    '# Home, Chatter and other standard pages',
    '*.force.com/lightning/page/',
    '# Custom tabs (Lightning pages, Visualforce tabs)',
    '*.force.com/lightning/n/',
    '# Switching apps from the App Launcher',
    '*.force.com/lightning/app/',
    '# Quick actions and component pages',
    '*.force.com/lightning/action/',
    '*.force.com/lightning/cmp/',
    '# Global search results',
    '*.force.com/lightning/search',
    '*.force.com/one/one.app',
    '# Visualforce pages shown inside Lightning, file previews',
    '*.vf.force.com/apex/',
    '*.file.force.com/sfc/',
  ];
  // Block: admin and developer areas (the Setup menu and builders). These win
  // over the allow list. "*/path" means that path on any host.
  const DEFAULT_BLOCK = [
    '# Setup menu: Setup, Object Manager, Data Cloud Setup, Salesforce Go',
    '*/lightning/setup/',
    '*.salesforce-setup.com',
    '*.salesforce.com/setup/',
    '*.salesforce.com/ui/setup/',
    '# Setup menu: Web Console, and the classic Developer Console',
    '*/lwr/application/platformdx-webconsole',
    '*/_ui/common/apex/debug',
    '# Setup menu: Agentforce Vibes (formerly Code Builder)',
    '/^https?:\\/\\/[^/]*(vibes|codebuilder|code-builder)[^/]*\\//',
    '# Builders: Flow, Lightning App, Experience, Process Builder',
    '*/builder_platform_interaction/',
    '*/visualEditor/',
    '*/sfsites/picasso/',
    '*/processui/',
    '# Log in as another user, session hand-off, raw API pages',
    '*/servlet/servlet.su',
    '*/secur/frontdoor.jsp',
    '*/services/',
  ];

  // ---- org identity from a URL (no API) --------------------------------
  // Salesforce hostnames start with the My Domain name, followed for
  // sandboxes by "--<sandbox>", and for Visualforce/package hosts by
  // "--<package>" (acme--uat--c.sandbox.vf.force.com). A partition label
  // (sandbox, develop, scratch, ...) follows the first label. No partition
  // means production (or an org without enhanced domains): treated as
  // production, the safe assumption.
  const PARTITIONS = { sandbox: 'sandbox', develop: 'developer', scratch: 'scratch', patch: 'patch', demo: 'demo', trailblaze: 'trailhead', free: 'free' };
  const SF_HOST = /\.(force\.com|salesforce\.com|salesforce-setup\.com|site\.com|documentforce\.com|visualforce\.com|lightning\.com)$/i;
  function orgInfo(url) {
    let u;
    try { u = new URL(/^[a-z]+:\/\//i.test(String(url)) ? url : `https://${url}`); } catch { return null; }
    const host = u.hostname.toLowerCase();
    if (!SF_HOST.test(host)) return null;
    const labels = host.split('.');
    const partition = labels.slice(1).find((l) => PARTITIONS[l]) || '';
    return { host, key: labels[0], partition, type: partition ? PARTITIONS[partition] : 'production' };
  }
  // Same org: same partition, and the first label is the org's own
  // (or the org's plus "--<package>" for Visualforce / file hosts).
  function sameOrg(urlA, urlB) {
    const a = orgInfo(urlA);
    const b = orgInfo(urlB);
    if (!a || !b || a.partition !== b.partition) return false;
    const [ka, kb] = a.key.length <= b.key.length ? [a.key, b.key] : [b.key, a.key];
    if (ka === kb) return true;
    // The longer key may add exactly one "--<package>" part (Visualforce,
    // packages). It can't be another sandbox of the same org: a sandbox host
    // always carries the "sandbox" partition, which a production host lacks,
    // and two sandboxes differ in the part before it (acme--uat vs acme--dev).
    const rest = kb.startsWith(`${ka}--`) ? kb.slice(ka.length + 2) : null;
    return !!rest && !rest.includes('--');
  }

  // Raise when DEFAULT_ALLOW / DEFAULT_BLOCK change, so the popup can offer
  // the new defaults to users whose saved lists are older.
  //   1: first defaults   2: + Web Console (platformdx-webconsole)
  const DEFAULTS_VERSION = 2;

  const api = { compile, check, parseLine, DEFAULT_ALLOW, DEFAULT_BLOCK, DEFAULTS_VERSION, orgInfo, sameOrg };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SitePolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
