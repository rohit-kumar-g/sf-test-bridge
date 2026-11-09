#!/usr/bin/env node
// MCP server (stdio) exposing browser tools backed by the SF Test Bridge
// extension running in the user's real Chrome/Edge profile.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Bridge } from './hub.js';
import { ACTION_LOG, logAction } from './actionlog.js';
import { runSteps, STEP_ACTION_NAMES } from './steps.js';
import { EvidenceRun, EVIDENCE_ROOT, listRuns, shown } from './evidence.js';
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
const bridge = new Bridge({
  port: PORT,
  allowedOrigins: (process.env.BROWSER_BRIDGE_EXTRA_ORIGINS || '').split(',').filter(Boolean),
}).start();

// ---------------------------------------------------------------------------
// tool schemas
// ---------------------------------------------------------------------------
const tabId = { type: 'integer', description: 'Tab id (from browser_open / browser_tabs). Defaults to the tab used last.' };
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
  required: ['label', 'value'],
};

const TOOLS = [
  {
    name: 'browser_status',
    description: 'Show bridge status: which browser(s) are connected, hub role, controlled tabs. Pass use=<extension id> to switch between several connected browsers.',
    inputSchema: { type: 'object', properties: { use: { type: 'string' } } },
    run: async (a) => {
      if (a.use) await bridge.request('hub.use', { id: a.use });
      const hub = await bridge.request('hub.status');
      let browser = null;
      if (hub.extensions?.length) browser = await bridge.request('status', { __waitMs: 0 }).catch((e) => ({ error: e.message }));
      return { thisProcess: bridge.role, actionLog: ACTION_LOG, ...hub, browser };
    },
  },
  {
    name: 'browser_reload_extension',
    description: 'Reload the browser extension from disk (after its code changed). Waits until it reconnects.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const r = await bridge.request('reload', {});
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
    description: 'List tabs Claude controls (all=true also lists the user\'s other tabs, which Claude cannot act on unless the user shares them from the extension popup).',
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
    run: (a) => bridge.request('fill', a, 180_000),
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
      },
      required: ['steps'],
    },
    run: async (a) => (await runSteps(
      (m, p, t) => bridge.request(m, p, t), a,
      (action, params, ok, res) => logAction('sf-test-bridge (browser_steps)', `browser_${action}`, params, ok, ok ? res : res),
    )).text,
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
const INSTRUCTIONS = `Browser tools that drive the user's real Chrome/Edge profile (existing logins and SSO apply).
- Work from text, not pixels: read pages with browser_snapshot (refs for actions) or browser_get_text; every action result already reports url, toasts/alerts, field errors, open modal, new console errors and failed requests.
- Use browser_screenshot ONLY to review visual UI/UX (layout, styling); never to read data or confirm results.
- Salesforce: browser_record_action for record actions (falls back to the "Show more actions" menu), browser_fill to fill fields by label (picklists, lookups, dates, checkboxes, radios) with submit:"Save"/"Next"/"Finish", browser_click with text for buttons; text targets search the topmost modal (LWC quick action, Flow) first.
- Prefer browser_steps to run a whole test case (navigate, click, fill, path, wait_for, get_text with expectations) in one call; browser_path reads and moves the Salesforce Path.
- A field shown read-only on a record page is filled through its inline-edit pencil automatically (pass submit:"Save").
- Claude can only act on tabs it opened with browser_open or tabs the user shared from the extension popup.`;
const server = new Server({ name: 'sf-test-bridge', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
  if (!tool) return { isError: true, content: [{ type: 'text', text: `unknown tool ${req.params.name}` }] };
  const args = req.params.arguments || {};
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
