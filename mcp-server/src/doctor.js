// Setup check ("doctor"): is everything in place for a good session?
// Used by the browser_doctor tool and `cli.js doctor`. Read-only.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadCharter } from './charter.js';

export const SERVER_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// Plain-words comparison of the MCP server and extension versions.
export function versionCheck(extVersion) {
  if (!extVersion) return { ok: false, server: SERVER_VERSION, extension: null, note: 'extension not connected' };
  if (extVersion === SERVER_VERSION) return { ok: true, server: SERVER_VERSION, extension: extVersion };
  return {
    ok: false, server: SERVER_VERSION, extension: extVersion,
    note: `The browser extension (${extVersion}) and the MCP server (${SERVER_VERSION}) are different versions. Update both from the same release, then reload the extension (browser_reload_extension, or chrome://extensions > reload).`,
  };
}

const MIN_WIDTH = 1280; // narrower: Lightning hides actions and tabs in overflow menus

export async function runDoctor(request, { checkCli = true } = {}) {
  const checks = [];
  const add = (check, ok, detail, fix) => checks.push({ check, result: ok === true ? 'ok' : ok === false ? 'problem' : 'info', detail, ...(fix && ok !== true ? { fix } : {}) });

  add('Node.js', Number(process.versions.node.split('.')[0]) >= 20, `v${process.versions.node}`, 'Install Node.js 20 or newer.');

  let hub = null;
  try { hub = await request('hub.status', {}, 5000); } catch (e) { add('Hub', false, e.message, 'Restart the browser MCP server (in Claude Code: /mcp, reconnect "browser").'); }
  if (hub) add('Hub', true, `port ${hub.port}, ${hub.sessions?.length ?? '?'} session(s), ${hub.peers} peer process(es)`);

  const ext = hub?.extensions?.find((e) => e.active);
  add('Browser extension connected', !!ext, ext ? `${ext.browser} ${ext.version}` : 'not connected',
    'Open Chrome or Edge with the SF Test Bridge extension loaded (chrome://extensions > Developer mode > Load unpacked > extension/), then click its toolbar icon to reconnect.');

  let st = null;
  if (ext) {
    try { st = await request('status', { __waitMs: 0 }, 8000); } catch (e) { add('Extension status', false, e.message); }
  }
  const v = versionCheck(ext?.version);
  if (ext) add('Versions match', v.ok, `MCP server ${v.server}, extension ${v.extension}`, v.note);

  if (st) {
    add('Not paused', !st.paused, st.paused ? 'paused in the popup' : 'active', 'Resume Claude in the extension popup.');
    const allowN = (st.sites?.allow || []).filter((l) => l && !String(l).startsWith('#')).length;
    const blockN = (st.sites?.block || []).filter((l) => l && !String(l).startsWith('#')).length;
    add('Site lists', true, `${allowN || 'any site'} allowed, ${blockN} blocked`);
    if (st.sites?.defaultsVersion != null && st.sites?.currentDefaults != null && st.sites.defaultsVersion < st.sites.currentDefaults) {
      add('Site list defaults current', false, `saved lists use defaults v${st.sites.defaultsVersion}; v${st.sites.currentDefaults} is available`, 'Popup > Sites > "Show new defaults", review, Save.');
    }
    if (st.lastTabId != null) {
      try {
        const w = await request('window', { tabId: st.lastTabId }, 8000);
        add('Window width', w.width >= MIN_WIDTH ? true : false, `${w.width}x${w.height}, zoom ${Math.round((w.zoom || 1) * 100)}%`,
          `Make the window at least ${MIN_WIDTH}px wide (browser_window width: 1400), or Lightning hides actions and tabs in "More" menus.`);
      } catch { /* tab may be gone */ }
    } else {
      add('Window width', null, 'no tab in this session yet; checked once a tab is open');
    }
  }

  const c = loadCharter();
  add('Agent instructions', true, `${c.customised ? `customised, edited ${c.edited.slice(0, 10)}` : 'default'} (${c.file})`);

  if (checkCli) {
    const r = spawnSync(process.platform === 'win32' ? 'sf.cmd' : 'sf', ['--version'], { encoding: 'utf8', timeout: 20_000, shell: process.platform === 'win32' });
    const ver = (r.stdout || '').split('\n')[0].trim();
    add('Salesforce CLI (optional, for debug logs)', ver ? true : null, ver || 'not found: only needed for debug-log root cause', 'Install @salesforce/cli if you want debug-log root cause.');
  }

  const problems = checks.filter((x) => x.result === 'problem').length;
  return { summary: problems ? `${problems} problem(s) found` : 'everything looks good', checks };
}
