#!/usr/bin/env node
// MCP server (stdio) exposing browser tools backed by the SF Test Bridge
// extension running in the user's real Chrome/Edge profile.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Bridge, makeSession } from './hub.js';
import { ACTION_LOG, logAction } from './actionlog.js';
import { runSteps, STEP_ACTION_NAMES } from './steps.js';
import { EvidenceRun, EVIDENCE_ROOT, listRuns, shown } from './evidence.js';
import { loadCharter, gate } from './charter.js';
import { runDoctor, versionCheck, SERVER_VERSION } from './doctor.js';
import { loadProject, projectView } from './project.js';
import { orgInfo, prepareFill } from './orginfo.js';
import { verifyChanges } from './changes.js';
import { stateView, stop as dlStop, remove as dlRemove, analyzeWindow, traceWindow, lastSearch, readCapture, captureView, captureCheck, captureSend, captureStart, captureStop, captureSearch, captureExplain } from './debuglog.js';
import { recordFromUrl } from './trace.js';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const DASHBOARD_PORT = Number(process.env.BROWSER_BRIDGE_DASHBOARD_PORT || 17380);
const DASHBOARD_JS = fileURLToPath(new URL('../../dashboard/server.js', import.meta.url));
const dashboardUp = () => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port: DASHBOARD_PORT, path: '/api/health', timeout: 1500 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
  req.on('error', () => resolve(false));
  req.on('timeout', () => { req.destroy(); resolve(false); });
});
// Start the evidence dashboard (detached, survives this process) unless it runs.
async function ensureDashboard() {
  if (!(await dashboardUp())) {
    spawn(process.execPath, [DASHBOARD_JS], { detached: true, stdio: 'ignore', env: { ...process.env, BROWSER_BRIDGE_EVIDENCE_DIR: EVIDENCE_ROOT } }).unref();
    for (let i = 0; i < 20 && !(await dashboardUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  return `http://127.0.0.1:${DASHBOARD_PORT}`;
}
const evidenceSpec = {
  description: 'Test evidence (annotated screenshots saved to disk; only the folder path is returned). Omit for the default (BROWSER_BRIDGE_EVIDENCE: steps), false for none, or {project, run, case, mode: "steps"|"failures"|"off", description}. The same run name collects several calls (one test case each) into one test run.',
  anyOf: [{ type: 'boolean' }, {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'e.g. the org or app under test (default "default")' },
      run: { type: 'string', description: 'Test run name; reuse it for every case of the run (default: one ad-hoc run per day)' },
      runTitle: { type: 'string' }, runDescription: { type: 'string' },
      case: { type: 'string', description: 'Test case title (default: from the step names)' },
      description: { type: 'string', description: 'Test case description / requirement' },
      mode: { type: 'string', enum: ['steps', 'failures', 'off'] },
    },
  }],
};

const PORT = Number(process.env.BROWSER_BRIDGE_PORT || 17345);
// This Claude session's lane in the browser. BROWSER_BRIDGE_SESSION names it
// (tab group "Claude · <name>"); default: the project folder name.
const SESSION = makeSession({ label: process.env.BROWSER_BRIDGE_SESSION, agent: true });
// Hash of the instructions (charter) this session has read; null = not yet.
let charterRead = null;
// ---- debug logs (Phase 4) ----
const debugLogDir = () => path.join(EVIDENCE_ROOT, 'debug-logs', new Date().toISOString().replace(/[:.]/g, '-'));
async function currentOrgHost() {
  try {
    const st = await bridge.request('status', { __waitMs: 0 }, 10_000);
    const org = st.brief?.org || (await bridge.request('tabs', {}, 10_000)).find((t) => t.tabId === st.lastTabId)?.url;
    return org ? new URL(org).hostname : null;
  } catch { return null; }
}
async function currentTabUrl() {
  try {
    const st = await bridge.request('status', { __waitMs: 0 }, 10_000);
    return (await bridge.request('tabs', {}, 10_000)).find((t) => t.tabId === st.lastTabId)?.url || null;
  } catch { return null; }
}
// When this session acted on the page (a change trace starts there).
const WRITE_TOOLS = new Set(['browser_click', 'browser_fill', 'browser_type', 'browser_press_key', 'browser_select', 'browser_upload', 'browser_path', 'browser_record_action', 'browser_dialog', 'browser_steps', 'browser_evaluate']);
const acted = { first: null, last: null };
// Change trace as a few lines for a tool result.
function traceText(r) {
  if (!r.used) return `\nChange trace: ${r.note}`;
  if (!r.logs) return `\nChange trace: ${r.note}`;
  const lines = [`\nChange trace (${r.logs.length} log(s) chosen of ${r.window.logs} in the window${r.record ? `; record ${r.record.recordId}` : ''}):`];
  lines.push(...(r.changes.length ? r.changes.slice(0, 10).map((c) => `  ${c}`) : [r.sameValue?.length ? `  saved, but no field changed: automation set ${r.sameValue.join(', ')} to the value it already had` : '  no field changes found in the log']));
  if (r.errors.length) lines.push(...r.errors.map((e) => `  ${e}`));
  if (r.traceMd) lines.push(`  full trace: ${r.traceMd}`);
  return lines.join('\n');
}
let debugHintShown = false; // "debug logs could help": at most once per session
async function debugLogNote(t0) {
  try {
    const view = stateView();
    if (view.state !== 'on') {
      if (debugHintShown) return '';
      debugHintShown = true;
      return view.state === 'ready'
        ? `\n(Debug logs are set up but not on. The developer can start them in the extension popup to see the cause of failures like this one.)`
        : '\n(Debug logs could show the cause of a failure like this one. Only the developer can set them up: node mcp-server/src/cli.js debuglog setup. Mention it once; do not ask again.)';
    }
    // logs arrive a few seconds after the request: wait up to 12 s for them
    const r = await analyzeWindow({ sinceMs: t0 - 3000, orgHost: await currentOrgHost(), projectRoot: loadProject(process.cwd())?.root, saveDir: debugLogDir(), waitMs: 12_000, aroundMs: Date.now() });
    if (!r.used || !r.logs) return `\nDebug log: ${r.note}`;
    const counts = `${r.logs} log(s) in the window, ${r.read} read${r.notRead ? `; ${r.notRead}` : ''}`;
    if (!r.rootCause) return `\nDebug log: ${counts}; no Apex / flow / validation failure in them.`;
    return `\nDebug log root cause: ${r.rootCause}\n(${counts}${r.savedTo ? `; full logs: ${r.savedTo}` : ''}; browser_debuglog analyze for details)`;
  } catch (e) { return `\nDebug log: could not read (${e.message})`; }
}

// Fill with the org-setup checks (apiName -> label, picklist values checked
// before typing, length notes). Used by browser_fill and fill steps.
async function fillChecked(params, timeoutMs = 180_000) {
  const { __notes, ...prepared } = await prepareFill((m, p, t) => bridge.request(m, p, t), params);
  const r = await bridge.request('fill', prepared, timeoutMs);
  return __notes ? { ...r, notes: __notes } : r;
}
const bridge = new Bridge({
  port: PORT,
  session: SESSION,
  allowedOrigins: (process.env.BROWSER_BRIDGE_EXTRA_ORIGINS || '').split(',').filter(Boolean),
}).start();

// ---------------------------------------------------------------------------
// tool schemas
// ---------------------------------------------------------------------------
const tabId = { type: 'integer', description: 'Tab id (from browser_open / browser_tabs). Defaults to the tab this session used last.' };
const target = {
  ref: { type: 'string', description: 'Element ref from browser_snapshot, e.g. "e12" or "f3e12" (element in frame 3). Most reliable.' },
  text: { type: 'string', description: 'Visible text / accessible name / label of the element (e.g. a button label). Searches the topmost open modal first, then the page.' },
  selector: { type: 'string', description: 'CSS selector, matched through shadow DOM (LWC) and all frames.' },
  exact: { type: 'boolean', description: 'With text: require an exact (case-insensitive) match.' },
  role: {
    type: 'array', items: { type: 'string' },
    description: 'With text: only match these roles, e.g. ["button"], ["menuitem"], ["link"], ["tab"], ["option"], ["checkbox"].',
  },
  scope: {
    type: 'string', enum: ['auto', 'modal', 'page', 'header'],
    description: 'Where text/selector are searched. auto (default) = topmost open modal/dialog first (LWC quick action, Flow modal, lightning-modal), then the page. header = Salesforce record highlights panel.',
  },
  frame: { type: 'integer', description: 'Restrict text/selector search to this frame id.' },
  within: { type: 'string', description: 'Only search inside the section/card/tab bar/region with this label, e.g. "Contacts" (related list card) to click its "New", or the aria-label of a tab bar.' },
  index: { type: 'integer', description: '1-based: pick the Nth of several equally good matches (results warn when a target is ambiguous).' },
  timeoutMs: { type: 'integer', description: 'Auto-wait up to this long for the target to appear (default 5000).' },
  scrollToFind: { type: 'boolean', description: 'If the target is not rendered yet, scroll the page/modal step by step to trigger lazy loading (default true).' },
};
const fieldSpec = {
  type: 'object',
  properties: {
    label: { type: 'string', description: 'Visible field label, e.g. "Account Name", "Stage", "Close Date". The required "*" is ignored.' },
    apiName: { type: 'string', description: 'The field API name instead of its label, e.g. "Discount__c" (needs the user permission to read the org setup, in the extension popup).' },
    value: { description: 'Value to set. Text for inputs/textarea/date; option label for picklists, radio groups and native selects; record name for lookups; true/false for checkboxes and toggles; a list (array or "a, b") for checkbox groups and dual listboxes.' },
    exact: { type: 'boolean', description: 'Require an exact label match (default: exact preferred, then prefix, then contains).' },
    search: { type: 'string', description: 'Lookup only: text to type in the search box if it differs from the value to pick.' },
    slowly: { type: 'boolean', description: 'Type key by key (default true for lookups, false otherwise).' },
    blur: { type: 'boolean', description: 'Press Tab after typing (always done for date/time pickers).' },
    kind: { type: 'string', enum: ['lookup', 'picklist', 'text', 'textarea', 'date', 'checkbox', 'radio', 'select', 'duallistbox'], description: 'Only match a field of this kind (when several fields share a label, e.g. the Account Name lookup vs a picklist "Account Name Source").' },
    within: { type: 'string', description: 'Only match a field inside this section / card / modal (its heading), e.g. "Opportunity Information".' },
    index: { type: 'integer', description: '1-based: pick the Nth of the candidates listed in an "N fields match" warning.' },
    fullSearch: { type: 'boolean', description: 'Lookup only: if the dropdown has no match, also run the full search ("Search <Object>..." / "Show all results"), report its result count and rows, and pick a matching row.' },
    timeoutMs: { type: 'integer', description: 'Lookup: how long to wait for results (default 8000). The wait ends early once the search has finished (no spinner, network idle).' },
  },
  required: ['value'], // plus label or apiName
};

const TOOLS = [
  {
    name: 'browser_status',
    description: 'Show bridge status: which browser(s) are connected, hub role, this session and the other Claude sessions using the browser, this session\'s tabs, site lists. Pass use=<extension id> to switch between several connected browsers.',
    inputSchema: { type: 'object', properties: { use: { type: 'string' } } },
    run: async (a) => {
      if (a.use) await bridge.request('hub.use', { id: a.use });
      const hub = await bridge.request('hub.status');
      let browser = null;
      if (hub.extensions?.length) browser = await bridge.request('status', { __waitMs: 0 }).catch((e) => ({ error: e.message }));
      const c = loadCharter();
      return {
        thisProcess: bridge.role, session: SESSION.label, actionLog: ACTION_LOG, ...hub, browser,
        versions: versionCheck(hub.extensions?.find((e) => e.active)?.version),
        instructions: { read: charterRead === c.hash, version: c.customised ? `customised, edited ${c.edited.slice(0, 10)}` : 'default', file: c.file },
      };
    },
  },
  {
    name: 'browser_guide',
    description: 'REQUIRED FIRST, once per session: the instructions for using SF Test Bridge (purpose, your role, rules, when to stop and ask, playbook), written by the user who installed it, plus the current state. Every other browser tool is refused until this has been read, and again after the user changes the instructions.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const c = loadCharter();
      charterRead = c.hash;
      let st = null;
      try { st = await bridge.request('status', { __waitMs: 0 }, 8000); } catch { /* extension not connected */ }
      const state = {
        session: SESSION.label,
        instructions: c.customised ? `customised by the user (edited ${c.edited.slice(0, 10)})` : 'default',
        extension: st ? `${st.browser} ${st.version}${st.paused ? ' (PAUSED by the user)' : ''}` : 'not connected (ask the user to open the browser with the extension)',
        versions: versionCheck(st?.version),
        brief: st?.brief || 'none yet: needed before any write (browser_brief)',
        yourTabs: st?.controlledTabs || [],
        otherSessions: (st?.sessions || []).filter((x) => !x.you).map((x) => x.session),
        siteLists: st ? `${(st.sites?.allow || []).filter((l) => l && !String(l).startsWith('#')).length || 'any site'} allowed, ${(st.sites?.block || []).filter((l) => l && !String(l).startsWith('#')).length} blocked (browser_status shows them)` : undefined,
      };
      return `${c.text.trim()}\n\n---\nCurrent state:\n${JSON.stringify(state, null, 1)}\n\nYou have read the instructions for this session. Follow them; start with section 5 (intake).`;
    },
  },
  {
    name: 'browser_brief',
    description: 'Record the brief agreed with the user (instructions, section 5). Required before any command that changes data or the page (fill, typing, Save/Delete/Next clicks, record actions, Path moves, upload, evaluate, accepting dialogs); reading needs no brief. With a brief, this session stays in that org. Call again to change it (e.g. the user now allows writes).',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: 'string', description: 'The org to test: its URL or host, e.g. https://acme--uat.sandbox.lightning.force.com. Never guessed: from the user or the tab they pointed to.' },
        target: { type: 'string', description: 'What to test: the feature, change, object or page.' },
        expected: { type: 'string', description: 'What counts as working, as agreed with the user (or "derive from the change / org setup" if they said so).' },
        data: { type: 'string', enum: ['read-only', 'write'], description: 'read-only: look only. write: the user allows creating / changing test data.' },
        rules: { type: 'string', description: 'Which records may be touched, naming, anything the user said about data.' },
        cleanup: { type: 'boolean', description: 'Delete the records you created at the end (default true).' },
        allowProduction: { type: 'boolean', description: 'Only if the user explicitly allowed writes in a production org.' },
      },
      required: ['org', 'target', 'expected', 'data'],
    },
    run: (a) => bridge.request('setBrief', { brief: a }),
  },
  {
    name: 'browser_org_info',
    description: 'The org\'s setup as the logged-in user sees it, read with their own browser login (UI API; read-only; no brief needed; does not use the org\'s API limit): an object\'s fields (type, required, editable, formula, dependent picklists, lookups, help text), picklist values per record type, the edit layout (sections, required and read-only fields) and record types. Without object: the list of objects. Needs the user\'s permission for that org (extension popup); cached for 1 hour. Answers follow the user\'s own access: "cannot" means this user can\'t see it.',
    inputSchema: {
      type: 'object',
      properties: {
        object: { type: 'string', description: 'API name, e.g. Opportunity or Invoice__c. Omit to list objects.' },
        recordType: { type: 'string', description: 'Record type name or id (default: the user\'s default)' },
        include: { type: 'array', items: { type: 'string', enum: ['fields', 'picklists', 'layout', 'recordTypes'] }, description: 'Parts to return (default all)' },
        org: { type: 'string', description: 'Org URL (default: the brief\'s org, else this session\'s current tab)' },
        refresh: { type: 'boolean', description: 'Read again instead of using the cache (e.g. after a deploy)' },
      },
    },
    run: (a) => orgInfo((m, p, t) => bridge.request(m, p, t), a),
  },
  {
    name: 'sf_verify_change',
    description: 'Check what the developer just changed, in the real org. Reads the git diff of the Salesforce DX project (uncommitted + untracked by default, or since a ref, or a given file list), works out each changed component (fields, validation rules, flows, triggers, LWC, quick actions, layouts, Paths, permission sets) and: checks it against the org\'s setup (deployed? same type, picklist values, required, on the edit layout; handles the org\'s namespace), runs read-only UI checks (changed fields on the New form, picklist options), and lists the behaviour tests that need test data (validation rules, flows, triggers, LWC, actions) with how to run them. Read-only: run the behaviour tests yourself with browser_steps after agreeing a write brief. Returns a report you can show the user.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project folder (default: this session\'s working folder)' },
        since: { type: 'string', description: 'Git ref to compare with (e.g. main, HEAD~3). Default: uncommitted changes, or the last commit when there are none.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Changed source files, when the project is not in git' },
        runUi: { type: 'boolean', description: 'Run the read-only UI checks in the browser (default true)' },
        org: { type: 'string', description: 'Org URL (default: the brief\'s org, else this session\'s current tab)' },
      },
    },
    run: async (a) => {
      const r = await verifyChanges({ request: (m, p, t) => bridge.request(m, p, t), root: a.path || process.cwd(), since: a.since, files: a.files, runUi: a.runUi !== false, org: a.org });
      const { report, ...details } = r;
      return `${report}\n\n---\nDetails (JSON):\n${JSON.stringify(details, null, 1)}`;
    },
  },
  {
    name: 'sf_project_info',
    description: 'What the developer built, read from the local Salesforce DX project (no org access): objects with their fields (types, picklist values and dependencies, lookups, formulas), validation rules (condition and message), flows (record-triggered: object, when, entry criteria; screens), Apex triggers, LWC and where they are used, Lightning pages, layouts, permission sets, quick actions, Paths. Pass object for one object in detail. Use it to plan what to test.',
    inputSchema: {
      type: 'object',
      properties: {
        object: { type: 'string', description: 'API name, e.g. Opportunity: everything about that object' },
        path: { type: 'string', description: 'Project folder (default: this session\'s working folder, searched upward and one level down for sfdx-project.json)' },
      },
    },
    run: async (a) => {
      const model = loadProject(a.path || process.cwd());
      if (!model) return { found: false, note: 'No Salesforce DX project (sfdx-project.json) found here. Ask the user where the project is, or pass path.' };
      return projectView(model, { object: a.object });
    },
  },
  {
    name: 'browser_doctor',
    description: 'Check the setup and say what to fix: extension connected, versions match, not paused, site lists, window width, the instructions file, Salesforce CLI (optional). Read-only.',
    inputSchema: { type: 'object', properties: {} },
    run: () => runDoctor((m, p, t) => bridge.request(m, p, t)),
  },
  {
    name: 'browser_reload_extension',
    description: 'Reload the browser extension from disk (after its code changed). Waits until it reconnects. Refused while another Claude session is running a command, unless force is true (a reload stops every command in flight).',
    inputSchema: { type: 'object', properties: { force: { type: 'boolean' } } },
    run: async (a) => {
      const r = await bridge.request('reload', { force: !!a.force });
      await new Promise((res) => setTimeout(res, 1500));
      const status = await bridge.request('status', {}, 40_000);
      return { ...r, reconnected: status };
    },
  },
  {
    name: 'browser_window',
    description: 'Resize or maximize the window of a controlled tab and/or zoom the tab. Use a wider window to make Salesforce show more actions/columns, zoom out to fit more content. Zoom applies to that tab only. With no arguments it returns the current size, zoom and viewport.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        state: { type: 'string', enum: ['normal', 'maximized', 'minimized', 'fullscreen'] },
        width: { type: 'integer' }, height: { type: 'integer' }, left: { type: 'integer' }, top: { type: 'integer' },
        zoom: { description: '"in", "out", "reset", or a factor 0.25-5 (1 = 100%).' },
      },
    },
    run: (a) => bridge.request('window', a),
  },
  {
    name: 'browser_open',
    description: 'Open a URL in a new tab in the user\'s real browser profile (existing logins/SSO sessions apply). The tab goes into a "Claude" tab group (by default in a separate Claude window) and becomes the current tab. Returns tabId, title, url, alerts, open modal.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        where: { type: 'string', enum: ['window', 'tab'], description: 'window = Claude\'s own window (default from extension settings); tab = the user\'s current window.' },
      },
      required: ['url'],
    },
    run: (a) => bridge.request('open', a, 90_000),
  },
  {
    name: 'browser_tabs',
    description: 'List this session\'s tabs, and tabs the user shared that no session has claimed yet (all=true also lists other sessions\' tabs and the user\'s other tabs, which this session cannot act on).',
    inputSchema: { type: 'object', properties: { all: { type: 'boolean' } } },
    run: (a) => bridge.request('tabs', a),
  },
  {
    name: 'browser_navigate',
    description: 'Navigate a controlled tab to a URL, or go back/forward/reload. Waits for load and network idle. If the page has unsaved changes and asks "Leave site?" (beforeunload), by default it stays on the page and returns that message at once.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId, url: { type: 'string' }, action: { type: 'string', enum: ['back', 'forward', 'reload'] },
        onBeforeUnload: { type: 'string', enum: ['report', 'accept', 'dismiss'], description: 'When the page asks "Leave site?" (unsaved changes): report (default) = stay on the page and fail with that message; accept = leave and discard the changes; dismiss = stay and return normally with a note.' },
      },
    },
    run: (a) => bridge.request('navigate', a, 90_000),
  },
  {
    name: 'browser_end_session',
    description: 'Call when this session\'s browser work is done: stops its commands, releases its tabs (they stay open for the user, ungrouped) or closes them, and ends its lane. Happens automatically when the session exits or stays idle. closeTabs overrides the user\'s setting in the extension popup.',
    inputSchema: { type: 'object', properties: { closeTabs: { type: 'boolean' } } },
    run: (a) => bridge.request('endSession', a),
  },
  {
    name: 'browser_close',
    description: 'Close a tab Claude controls.',
    inputSchema: { type: 'object', properties: { tabId } },
    run: (a) => bridge.request('close', a),
  },
  {
    name: 'browser_snapshot',
    description: 'Text snapshot of the page: interactive elements with refs (e.g. [ref=e12]), headings, alerts and dialogs, across shadow DOM (LWC) and iframes. Use refs with the other tools. mode=full also includes visible text (record field values, table cells). Refs are stable while the element lives; re-snapshot after big re-renders.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId, mode: { type: 'string', enum: ['interactive', 'full'] }, maxChars: { type: 'integer', description: 'default 40000' },
        loadAll: { type: 'boolean', description: 'Scroll through the whole page first so lazily loaded sections (related lists, cards) are rendered.' },
      },
    },
    run: async (a) => (await bridge.request('snapshot', a, 180_000)).text,
  },
  {
    name: 'browser_click',
    description: 'Click an element by ref, text/label or selector, using a real (trusted) mouse click at its position, with a DOM click fallback. Text targets search the topmost open modal (LWC / Flow / quick action) first, then the page. Returns the page state afterwards: url, alerts/toasts, open modal, new console errors and failed requests.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId, ...target,
        double: { type: 'boolean' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        method: { type: 'string', enum: ['auto', 'cdp', 'dom'], description: 'auto (default) = trusted click unless the element is covered; cdp = always coordinates; dom = synthetic events.' },
        waitMs: { type: 'integer', description: 'Max wait for network idle after the click (default 3000).' },
      },
    },
    run: (a) => bridge.request('click', a),
  },
  {
    name: 'browser_fill',
    description: 'Fill form fields by their visible LABEL. Works for Salesforce record create/edit forms, LWC quick-action modals and Flow screens (modal or full page). Handles text, textarea, number, date/time pickers, checkbox/toggle, radio groups, checkbox groups, dual listboxes (multi-select picklists), native <select>, Lightning picklists (lightning-combobox: opens it and clicks the option) and lookups (types, waits for results, picks the matching record; clears an existing value first). Optionally clicks a submit button (e.g. "Save", "Next", "Finish") afterwards. Searches the topmost modal first.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        fields: { type: 'array', items: fieldSpec, description: 'Fields to fill, in order.' },
        label: { type: 'string', description: 'Single field shortcut (instead of fields).' },
        value: { description: 'Single field shortcut value.' },
        submit: { type: 'string', description: 'Label of a button to click after filling, e.g. "Save", "Next", "Finish".' },
        scope: target.scope,
        frame: target.frame,
        continueOnError: { type: 'boolean', description: 'Keep filling other fields after one fails (default false).' },
      },
    },
    // apiName -> label, and picklist values checked before anything is typed
    run: (a) => fillChecked(a, 180_000),
  },
  {
    name: 'browser_record_action',
    description: 'Click a Salesforce record action button by label (e.g. "Edit", "Clone", "Delete", "Change Owner", a custom quick action). Looks in the record highlights panel, then opens the "Show more actions" overflow menu if needed. Waits for the action modal and reports it (openModal).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        label: { type: 'string' },
        anywhere: { type: 'boolean', description: 'Fall back to any matching button on the page (default true).' },
        waitForModal: { type: ['boolean', 'integer'], description: 'Wait for a modal after clicking: true (default, up to 4s), false, or a number of ms (e.g. 10000 for slow console apps).' },
      },
      required: ['label'],
    },
    run: (a) => bridge.request('recordAction', a),
  },
  {
    name: 'browser_path',
    description: 'Salesforce Path on a record page. action "read" (default): stages as complete/current/incomplete, time in stage, key fields (label: value) and guidance; stage = show that stage\'s key fields and guidance. "select": click a stage. "mark": optionally select stage, then click the Path button (Mark as Current Stage / Mark Stage as Complete / Select Closed Stage) and return the outcome (stage changed or the validation error) with toasts. "editKeyFields": open the key fields\' Edit and list the editable fields; with fields, fill them and Save (submit), returning errors.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        action: { type: 'string', enum: ['read', 'select', 'mark', 'editKeyFields'] },
        stage: { type: 'string', description: 'Stage name to select (read/select/mark/editKeyFields).' },
        button: { type: 'string', description: 'mark: require this button label, e.g. "Mark as Current Stage".' },
        closedStage: { type: 'string', description: 'mark on "Select Closed Stage": the closed value to choose, e.g. "Closed Won".' },
        details: { type: 'boolean', description: 'read: open the key fields / guidance panel (default true).' },
        fields: { type: 'array', items: fieldSpec, description: 'editKeyFields: fields to fill.' },
        submit: { type: 'string', description: 'editKeyFields with fields: button to click afterwards (default "Save"; "" to leave the editor open).' },
        waitMs: { type: 'integer', description: 'mark: how long to wait for the stage change or an error (default 12000).' },
      },
    },
    run: (a) => bridge.request('path', a, 180_000),
  },
  {
    name: 'browser_steps',
    description: 'Run several browser actions in ONE call (saves a tool call per action). steps: ordered list of {action, ...that tool\'s parameters, expect?}. Actions: navigate, click, fill, record_action, path, wait_for, get_text, press_key, dialog, type, options. Optional per-step expect: {toast, error, fieldError, text, textGone, url, outcome, current} (case-insensitive substrings; with expect.error the step passes only if that error appears). Old alerts: toasts/errors left on screen from an earlier action never count; each step reports only the alerts it produced (older ones as "old alerts ignored"), expect.error also accepts the server\'s answer to the step\'s save (so the same error repeated in the same element still counts), and before an acting step with expect.error/expect.toast open toasts and error popovers are closed (per-step dismissAlerts: false keeps them, true always closes them; allowStale: true lets wait_for/expect.text/expect.toast accept text in an old alert). Stops at the first failing step. Returns one compact line per step and a final PASS/FAIL line. Example: open record, try a Path stage move expecting the validation error, fill the key field, retry, expect the stage change.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: STEP_ACTION_NAMES },
              name: { type: 'string', description: 'Optional step description shown in the result.' },
              expect: {
                type: 'object',
                properties: {
                  toast: { type: 'string' }, error: { type: 'string' }, fieldError: { type: 'string' }, text: { type: 'string' },
                  textGone: { type: 'string' }, url: { type: 'string' }, outcome: { type: 'string' }, current: { type: 'string' }, timeoutMs: { type: 'integer' },
                },
              },
            },
            required: ['action'],
            additionalProperties: true,
          },
        },
        evidence: evidenceSpec,
        trace: { type: ['boolean', 'object'], properties: { recordId: { type: 'string' }, object: { type: 'string' } }, description: 'With debug logs on: after the steps, trace what changed and why (fields set, by which flow element / trigger / Apex line / workflow rule, with source files). true = the record open at the end; or {recordId, object}.' },
      },
      required: ['steps'],
    },
    run: async (a) => {
      const t0 = Date.now();
      const text = (await runSteps(
        (m, p, t) => (m === 'fill' ? fillChecked(p, t) : bridge.request(m, p, t)), a,
        (action, params, ok, res) => logAction('sf-test-bridge (browser_steps)', `browser_${action}`, params, ok, ok ? res : res),
      )).text;
      if (a.trace && stateView().state === 'on') {
        const rec = typeof a.trace === 'object' && a.trace.recordId ? a.trace : recordFromUrl(await currentTabUrl()) || {};
        try {
          const r = await traceWindow({ fromMs: t0 - 3000, toMs: Date.now(), aroundMs: t0, recordId: rec.recordId, object: rec.object, orgHost: await currentOrgHost(), projectRoot: loadProject(process.cwd())?.root, saveDir: debugLogDir(), waitMs: 12_000 });
          return `${text}${traceText(r)}`;
        } catch (e) { return `${text}\nChange trace: could not read (${e.message})`; }
      }
      // a failed test case: add the cause from the debug logs when they are on
      return /^FAIL/m.test(text) ? `${text}${await debugLogNote(t0)}` : text;
    },
  },
  {
    name: 'browser_debuglog',
    description: 'Debug logs, set up by the developer only (their Salesforce CLI: node mcp-server/src/cli.js debuglog setup; started from the extension popup). status: not set up / ready / on (org, user, minutes left). analyze: read the configured user\'s logs from the last N minutes (default 10) and give the root cause (the failure, the class / trigger and line matched to the local source, debug lines, DML); full logs are saved locally. trace: "what changed and why" when there is no error: finds the right log among many (time window from your first action, the record\'s last modified time, then a search of each log for the record and data changes) and returns the fields set, each with what set it (flow element, trigger / Apex line, workflow rule, the LWC that called the Apex) and its source file; trace.md (readable, shareable) and trace.json are saved; terms (comma-separated) keep only the logs that contain them and show where. status also returns the last "Find in logs" search from the extension popup (lastSearchByDeveloper, with its trace.md): read it when they say they searched the logs. Capture (shared with the extension popup of the developer: one capture, either side can start, stop, search or read it; each step is marked with who made it): capture_start marks "from now" (optional recordId / terms; logging must already be on: you cannot turn it on, the developer does in the popup); capture_stop marks the end; capture_search sets the search words (record ids, values, flow / element / class names) and fetches new logs: every log of every user in the window is listed with hints (has the record, has an error, changes data, where the words appear), ordered, none hidden; capture_view gives the capture (and catches up), with ids (comma-separated log ids) it explains those logs ("what changed and why", trace.md, every log of the window saved with an index) and with id it explains one. Read it when the developer says they captured something. Adding logging for another user is a button in the popup, for the developer only. status also says if a capture is running. stop: end the logging window now. remove: remove the setup from the org. You cannot set up or start debug logs; failed browser_steps runs get the root cause automatically while logging is on.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'analyze', 'trace', 'capture_start', 'capture_stop', 'capture_search', 'capture_view', 'capture', 'stop', 'remove'] },
        ids: { type: 'string', description: 'capture_view: comma-separated log ids of the capture to explain together (saved for the developer too)' },
        id: { type: 'string', description: 'capture_view: one log id of the capture to explain' },
        minutes: { type: 'integer', description: 'analyze: how far back (default 10, max 60). trace: how far back (default: from the first action of this session, else from when logging started)' },
        recordId: { type: 'string', description: 'trace: the record to explain (default: the record open in the tab). capture_start: the record to watch (default: the record open in the tab; \"none\" for no record)' },
        object: { type: 'string', description: 'trace: its object API name (needed for custom objects when recordId is given)' },
        terms: { type: 'string', description: 'capture_start / capture_search: comma-separated search words, record ids included. trace: comma-separated words to look for in the logs (a record id, a value, an API name, a flow or element name, a class name); only logs containing them are used' },
        path: { type: 'string', description: 'analyze: project folder for matching lines to source (default: working folder)' },
      },
      required: ['action'],
    },
    run: async (a) => {
      if (a.action === 'status') {
        const ls = lastSearch(); const cp = readCapture();
        return { ...stateView(), ...(ls ? { lastSearchByDeveloper: ls } : {}), ...(cp && cp.status !== 'ended' ? { capture: { status: cp.status, since: cp.at, ...(cp.stoppedAt ? { until: cp.stoppedAt } : {}), terms: cp.terms, logs: cp.total ?? cp.logs?.length ?? 0, say: cp.say, note: 'browser_debuglog capture_view gives the details' } } : {}) };
      }
      if (/^capture/.test(a.action)) {
        // Claude's side of the shared capture: marked "by claude"; never changes the org
        const by = 'claude';
        const projectRoot = loadProject(a.path || process.cwd())?.root;
        if (a.action === 'capture_start') {
          const rec = a.recordId === 'none' ? undefined : a.recordId || (recordFromUrl(await currentTabUrl()) || {}).recordId; // "none": no record
          return captureStart({ by, recordId: rec, terms: a.terms, projectRoot });
        }
        const cp = readCapture();
        if (!cp || cp.status === 'ended') return { status: 'none', note: 'No capture running. Start one with capture_start (logging must be on), or the developer starts it in the extension popup (Debug logs > Start capture).' };
        if (a.action === 'capture_stop') return captureStop({ by });
        if (a.action === 'capture_search') return captureSearch({ by, terms: a.terms, sync: true });
        if (a.id) return captureExplain({ id: String(a.id), projectRoot });
        if (a.ids) return captureSend({ by, ids: String(a.ids).split(','), projectRoot });
        return captureCheck({ by, projectRoot });
      }
      if (a.action === 'stop') return dlStop();
      if (a.action === 'remove') return dlRemove();
      if (a.action === 'trace') {
        const rec = a.recordId ? { recordId: a.recordId, object: a.object } : recordFromUrl(await currentTabUrl()) || {};
        return traceWindow({ fromMs: a.minutes ? Date.now() - Math.min(60, a.minutes) * 60_000 : acted.first ?? undefined, toMs: Date.now(), aroundMs: acted.last ?? undefined, recordId: a.terms && !a.recordId ? undefined : rec.recordId, object: rec.object, terms: a.terms, orgHost: await currentOrgHost(), projectRoot: loadProject(a.path || process.cwd())?.root, saveDir: debugLogDir(), waitMs: 8_000 });
      }
      const minutes = Math.min(60, Math.max(1, a.minutes || 10));
      return analyzeWindow({ sinceMs: Date.now() - minutes * 60_000, orgHost: await currentOrgHost(), projectRoot: loadProject(a.path || process.cwd())?.root, saveDir: debugLogDir() });
    },
  },
  {
    name: 'browser_evidence',
    description: 'Test evidence for reports. action "capture": annotated screenshot of the current tab (the element last clicked/typed into outlined, error messages and toasts boxed, a caption banner with the status) saved into project/run/case on disk; returns only the file path (no image, no tokens). "runs": list recent test runs with pass/fail totals. "dashboard": start the local evidence dashboard (TestRail-style runs, cases, steps, screenshots, reviewer results) and return its URL. browser_steps captures evidence automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['capture', 'runs', 'dashboard'] },
        tabId,
        project: { type: 'string' }, run: { type: 'string' },
        case: { type: 'string', description: 'capture: test case title (created if missing)' },
        caption: { type: 'string', description: 'capture: banner text, e.g. "Validation message on stage move"' },
        status: { type: 'string', enum: ['pass', 'fail', 'blocked', 'info'], description: 'capture: banner colour / step status' },
        detail: { type: 'boolean', description: 'capture: scroll the first error message into view first' },
        caseStatus: { type: 'string', enum: ['passed', 'failed', 'blocked', 'retest'], description: 'capture: also set the case result' },
      },
      required: ['action'],
    },
    run: async (a) => {
      if (a.action === 'dashboard') return { url: await ensureDashboard(), evidenceRoot: EVIDENCE_ROOT };
      if (a.action === 'runs') {
        const runs = listRuns();
        return runs.length ? runs.map((r) => `${r.project}/${r.id}: ${r.title} - ${Object.entries(r.totals || {}).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ') || 'no cases'} (${r.cases} case(s), started ${r.startedAt})`).join('\n') : `no runs in ${EVIDENCE_ROOT}`;
      }
      if (a.action !== 'capture') throw new Error('action must be capture, runs or dashboard');
      const run = EvidenceRun.open({ project: a.project, run: a.run });
      const c = run.caseNamed(a.case || 'Ad-hoc evidence');
      const n = c.data.steps.length + 1;
      const status = a.status || 'info';
      const shot = await c.capture((m, p, t) => bridge.request(m, p, t), { n, status, caption: a.caption || `#${n} ${status}`, detail: !!a.detail, tabId: a.tabId });
      if (!shot?.file) throw new Error(`no screenshot: ${shot?.error || 'unknown error'}`);
      c.addStep({ n, name: a.caption || '', action: 'capture', status: { pass: 'passed', fail: 'failed', blocked: 'blocked' }[status] || 'passed', durationMs: 0, line: a.caption || '', screenshot: shot.file, url: shot.url, marked: shot.marked });
      if (a.caseStatus) c.finish(a.caseStatus); else run.save();
      return { saved: shown(c, shot.file), marked: shot.marked };
    },
  },
  {
    name: 'browser_options',
    description: 'List the options of a picklist/combobox/lookup dropdown (opens it if closed). Target by field label, ref, text or selector.',
    inputSchema: { type: 'object', properties: { tabId, label: { type: 'string', description: 'Field label' }, ...target } },
    run: (a) => bridge.request('options', a),
  },
  {
    name: 'browser_type',
    description: 'Type text into a specific element (ref/text/selector). Clears it first by default. Uses trusted keyboard input. For filling forms by label prefer browser_fill.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId, ...target,
        value: { type: 'string', description: 'Text to type.' },
        clear: { type: 'boolean', description: 'Clear existing content first (default true).' },
        submit: { type: 'boolean', description: 'Press Enter afterwards.' },
        slowly: { type: 'boolean', description: 'Type key by key (triggers per-key handlers, e.g. search-as-you-type).' },
        method: { type: 'string', enum: ['auto', 'dom'] },
      },
      required: ['value'],
    },
    run: (a) => bridge.request('type', a),
  },
  {
    name: 'browser_select',
    description: 'Select option(s) in a native <select> by value or label. For Lightning picklists use browser_fill.',
    inputSchema: { type: 'object', properties: { tabId, ...target, values: { type: 'array', items: { type: 'string' } } }, required: ['values'] },
    run: (a) => bridge.request('select', a),
  },
  {
    name: 'browser_press_key',
    description: 'Press a key or combo (Enter, Escape, Tab, ArrowDown, Backspace, Control+A, Shift+Tab, ...), optionally focusing an element first.',
    inputSchema: { type: 'object', properties: { tabId, key: { type: 'string' }, repeat: { type: 'integer' }, ...target }, required: ['key'] },
    run: (a) => bridge.request('key', a),
  },
  {
    name: 'browser_hover',
    description: 'Move the mouse over an element (menus, tooltips).',
    inputSchema: { type: 'object', properties: { tabId, ...target } },
    run: (a) => bridge.request('hover', a),
  },
  {
    name: 'browser_scroll',
    description: 'Scroll an element into view (ref/text/selector), or scroll the page by dy pixels / direction.',
    inputSchema: { type: 'object', properties: { tabId, ...target, dy: { type: 'integer' }, direction: { type: 'string', enum: ['up', 'down'] } } },
    run: (a) => bridge.request('scroll', a),
  },
  {
    name: 'browser_screenshot',
    description: 'LAST RESORT. Screenshot for VISUAL UI/UX REVIEW ONLY (layout, styling, alignment, visual regressions). Never use it to read data, check values, find elements or confirm an action worked: browser_snapshot, browser_get_text and the action results already return that as text, far cheaper. Viewport, full page, or one element (ref/text/selector).',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'The UI/UX aspect being reviewed visually (required), e.g. "modal layout on narrow width".' },
        tabId, ...target, fullPage: { type: 'boolean' }, format: { type: 'string', enum: ['png', 'jpeg'] }, quality: { type: 'integer' },
      },
      required: ['reason'],
    },
    run: (a) => bridge.request('screenshot', a, 60_000),
  },
  {
    name: 'browser_get_text',
    description: 'Visible text of the page (all frames, through shadow DOM) or of one element. Good for reading record details, tables, error messages.',
    inputSchema: { type: 'object', properties: { tabId, ...target, maxChars: { type: 'integer', description: 'default 20000' }, loadAll: { type: 'boolean', description: 'Scroll the whole page first (lazy loading).' } } },
    run: (a) => bridge.request('getText', a, 180_000),
  },
  {
    name: 'browser_wait_for',
    description: 'Wait until text appears/disappears, a selector appears/disappears, the URL contains a string, or the network is idle. Without conditions it just waits timeoutMs. text found only in a toast/alert left over from an earlier action does not count (allowStale: true accepts it).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId, text: { type: 'string' }, allowStale: { type: 'boolean', description: 'Accept text that is only in an old alert left from an earlier action.' }, textGone: { type: 'string' }, selector: { type: 'string' }, selectorGone: { type: 'string' },
        option: { type: 'string', description: 'A visible dropdown option (lookup result, picklist value, menu item) containing this text.' },
        urlIncludes: { type: 'string' }, networkIdle: { type: 'boolean' }, timeoutMs: { type: 'integer', description: 'default 15000, max 120000' },
      },
    },
    run: (a) => bridge.request('waitFor', a, Math.min(a.timeoutMs || 15_000, 120_000) + 15_000),
  },
  {
    name: 'browser_evaluate',
    description: 'Evaluate a JavaScript expression in the page (top frame, page world) and return the JSON result. Promises are awaited.',
    inputSchema: { type: 'object', properties: { tabId, expression: { type: 'string' }, timeoutMs: { type: 'integer' } }, required: ['expression'] },
    run: (a) => bridge.request('evaluate', a, 130_000),
  },
  {
    name: 'browser_console',
    description: 'Console messages and uncaught exceptions captured in the tab (captured from the moment Claude opened/attached to it).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId, level: { type: 'string', enum: ['debug', 'log', 'info', 'warning', 'error'], description: 'Minimum level.' },
        pattern: { type: 'string', description: 'Regex filter on the message.' }, limit: { type: 'integer' }, clear: { type: 'boolean' },
      },
    },
    run: (a) => bridge.request('console', a),
  },
  {
    name: 'browser_network',
    description: 'Network requests captured in the tab (method, status, type, url, duration). failedOnly=true for errors (>=400 / failed). Pass requestId to fetch a response body (e.g. an Aura/Apex error payload).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId, failedOnly: { type: 'boolean' }, pattern: { type: 'string', description: 'Regex on URL' },
        types: { type: 'array', items: { type: 'string' }, description: 'e.g. ["XHR","Fetch","Document"]' },
        requestId: { type: 'string' }, maxChars: { type: 'integer' }, limit: { type: 'integer' }, clear: { type: 'boolean' },
      },
    },
    run: (a) => bridge.request('network', a),
  },
  {
    name: 'browser_dialog',
    description: 'Accept or dismiss a JavaScript alert/confirm/prompt/beforeunload dialog that is blocking the tab.',
    inputSchema: { type: 'object', properties: { tabId, accept: { type: 'boolean' }, promptText: { type: 'string' } } },
    run: (a) => bridge.request('dialog', a),
  },
  {
    name: 'browser_upload',
    description: 'Set files on a file input (or a component containing one, e.g. lightning-file-upload). Paths are absolute local paths.',
    inputSchema: { type: 'object', properties: { tabId, ...target, paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] },
    run: (a) => bridge.request('upload', a, 120_000),
  },
];

// ---------------------------------------------------------------------------
// MCP wiring
// ---------------------------------------------------------------------------
const INSTRUCTIONS = `SF Test Bridge: test Salesforce in the developer's own browser, with their own login, while they build (dev, sandboxes, POCs).
REQUIRED: call browser_guide first, once per session. It holds the user's instructions (purpose, your role, rules, when to stop and ask). All other browser tools refuse until it has been read.
Any command that changes data or the page also needs a brief agreed with the user (browser_brief); reading needs none.`;
const server = new Server({ name: 'sf-test-bridge', version: SERVER_VERSION }, { capabilities: { tools: {}, prompts: {} }, instructions: INSTRUCTIONS });

// Guided start (a slash command in Claude Code): asks for what's missing,
// then reads the instructions and records the brief.
const PROMPTS = [{
  name: 'start-test',
  description: 'Start a test with SF Test Bridge: give what you know; Claude asks only for what is missing, then records the brief.',
  arguments: [
    { name: 'org', description: 'Org URL or name (sandbox / dev / scratch)' },
    { name: 'target', description: 'What to test (feature, change, object, page)' },
    { name: 'expected', description: 'What counts as working' },
    { name: 'data', description: 'May Claude create or change test data? (read-only / write)' },
  ],
}];
server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));
server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  if (req.params.name !== 'start-test') throw new Error(`unknown prompt ${req.params.name}`);
  const a = req.params.arguments || {};
  const known = ['org', 'target', 'expected', 'data'].map((k) => `- ${k}: ${a[k] ? a[k] : '(not given)'}`).join('\n');
  return {
    description: 'Start a test with SF Test Bridge',
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `I want to test something with SF Test Bridge.\n\nWhat I've given so far:\n${known}\n\n`
          + 'First call browser_guide and follow its instructions. If anything in section 5 (intake) is missing or unclear, ask me all of it at once as numbered questions with options or defaults, and do nothing in the browser yet. '
          + 'When the brief is complete, restate it in two lines, record it with browser_brief, and start.',
      },
    }],
  };
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
  if (!tool) return { isError: true, content: [{ type: 'text', text: `unknown tool ${req.params.name}` }] };
  const args = req.params.arguments || {};
  // The user's instructions must be read first (once per session, and again after they change).
  const refusal = gate(tool.name, charterRead);
  if (refusal) {
    logAction('sf-test-bridge', tool.name, args, false, refusal);
    return { isError: true, content: [{ type: 'text', text: refusal }] };
  }
  if (WRITE_TOOLS.has(tool.name)) { acted.last = Date.now() - 2000; acted.first ??= acted.last; }
  try {
    const result = await tool.run(args);
    logAction('sf-test-bridge', tool.name, args, true, result);
    if (result && typeof result === 'object' && result.image) {
      const { image, mimeType, ...meta } = result;
      return { content: [{ type: 'image', data: image, mimeType }, { type: 'text', text: JSON.stringify(meta) }] };
    }
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 1);
    return { content: [{ type: 'text', text }] };
  } catch (e) {
    logAction('sf-test-bridge', tool.name, args, false, e.message);
    return { isError: true, content: [{ type: 'text', text: e.message }] };
  }
});

await server.connect(new StdioServerTransport());
process.stdin.on('close', () => { bridge.close(); process.exit(0); });
