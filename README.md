# SF Test Bridge

Lets Claude Code (or any MCP client) test Salesforce in **your own Chrome or Edge**, using the logins and SSO sessions you already have. Claude reads pages as text, fills fields by their label, runs whole test cases in one call, and saves annotated screenshots as test evidence.

```
Claude Code --stdio--> MCP server (mcp-server/) --ws://127.0.0.1:17345--> browser extension (extension/) --> your tabs
```

Works with any Salesforce Lightning org, and the basic tools work on any website. Plain Node.js with no OS-specific code, so it should run on Windows, macOS and Linux (developed and tested on Windows).

## Requirements

- [Node.js](https://nodejs.org) 20 or newer
- Chrome or Edge 120 or newer (Brave and other Chromium browsers should work; Firefox does not)
- [Claude Code](https://claude.com/claude-code), or another MCP client

## Setup

**1. Get the code and install dependencies**

```
git clone <this-repo-url> sf-test-bridge
cd sf-test-bridge/mcp-server
npm install
```

**2. Load the extension**

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the `extension/` folder.

The extension ID is always `kokfnnhacmipalbbndbpnbhpfhilopef`, because the `key` in the manifest pins it. The MCP server accepts connections only from that ID.

**3. Register the MCP server with Claude Code**

Use the full path to `mcp-server/src/index.js` on your machine:

```
# Windows
claude mcp add --scope user browser -- node C:/path/to/sf-test-bridge/mcp-server/src/index.js

# macOS / Linux
claude mcp add --scope user browser -- node /path/to/sf-test-bridge/mcp-server/src/index.js
```

For other MCP clients, add the same command to the client's config:

```json
{ "mcpServers": { "browser": { "command": "node", "args": ["/path/to/sf-test-bridge/mcp-server/src/index.js"] } } }
```

**4. Restart Claude Code and check**

- The extension's toolbar icon shows **on** once it is connected.
- Ask Claude: *"Run browser_status"*. It should list your browser.

**5. Log in to Salesforce yourself**, in that browser. The bridge never logs in or handles passwords; it works inside your session.

Then ask Claude something like: *"Open my org, create an Account named Test Co, and check that it saved."*

## Tools

| Tool | What it does |
|---|---|
| `browser_open`, `browser_navigate`, `browser_tabs`, `browser_close` | Open and manage tabs. Each Claude session's tabs open in its own window and a "Claude · <session>" tab group |
| `browser_end_session` | The session's browser work is done: release (or close) its tabs |
| `browser_guide` | **Required first, once per session**: your instructions for the agent (purpose, role, rules, when to stop and ask) plus the current state |
| `browser_brief` | Record the brief agreed with you (org, what to test, expected result, read-only or write). Required before any write |
| `browser_doctor` | Check the setup and say what to fix |
| `browser_snapshot`, `browser_get_text` | Read the page as text, including shadow DOM (LWC) and iframes |
| `browser_click` | Click by visible text, a ref from a snapshot, or CSS |
| `browser_fill` | Fill fields by label: text, date, checkbox, radio, picklist, lookup, multi-select. Optional `submit: "Save"` |
| `browser_record_action` | Click a record action, including ones under **Show more actions** |
| `browser_path` | Read and move the Salesforce Path, and fill its key fields |
| `browser_steps` | Run a whole test case (several actions with expected results) in one call; returns PASS/FAIL per step |
| `browser_evidence` | Save annotated screenshots for test reports and open the evidence dashboard |
| `browser_wait_for`, `browser_options`, `browser_type`, `browser_select`, `browser_press_key`, `browser_hover`, `browser_scroll`, `browser_window` | Waiting and lower-level input |
| `browser_console`, `browser_network`, `browser_dialog`, `browser_evaluate`, `browser_upload` | Debugging and testing helpers |
| `browser_screenshot` | Visual UI review only. Every other tool returns text |
| `browser_status`, `browser_reload_extension` | Bridge status; reload the extension after editing its code |

Each action's result includes what happened afterwards: URL, toasts, field errors, the open modal, console errors and failed requests.

### Example: one test case in one call

```json
{"steps": [
  {"action": "navigate", "url": "https://yourdomain.lightning.force.com/lightning/o/Account/new"},
  {"action": "fill", "fields": [{"label": "Account Name", "value": "Test Co"}], "submit": "Save", "expect": {"toast": "was created"}},
  {"action": "get_text", "expect": {"text": "Test Co"}}
]}
```

`expect` takes `toast`, `error`, `fieldError`, `text`, `textGone`, `url`, `outcome` and `current` (Path stage). The run stops at the first failed step.

## Test evidence dashboard

`browser_steps` saves an annotated screenshot after each step into `evidence/<project>/<run>/<case>/`. It marks the element acted on, errors in red and toasts in green. Claude gets back only the file path, not the image.

To view the evidence, run `node dashboard/server.js` and open http://127.0.0.1:17380, or ask Claude to start the dashboard. It shows runs, cases and steps with their screenshots, and a reviewer can mark a case passed, failed, blocked or retest, with a comment.

## Logs and privacy

Everything stays on your machine. Nothing is sent anywhere except between the MCP server and the extension on `127.0.0.1`. Two logs are written by default:

| Log | Where | Contents |
|---|---|---|
| **Action log** | `~/.sf-test-bridge/actions.jsonl` | One line per tool call. Typed text and sensitive-looking fields are redacted |
| **Raw traffic log** | `mcp-server/logs/extension-raw-<date>.log` | Every message between the MCP server and the extension, **unredacted**: page text, field values and screenshots (as base64) from the pages Claude works on |

> **Note:** the raw traffic log and `evidence/` can contain data from your org, such as customer records. Treat them as confidential, don't share or commit them (both are in `.gitignore`), and delete old ones when you no longer need them. Use `BROWSER_BRIDGE_RAW_LOG_DIR` to move the raw log and `BROWSER_BRIDGE_ACTION_LOG` to move or turn off (`off`) the action log.

## Safety

- Claude can act only on tabs **it opened**, or tabs **you share** from the extension popup ("Let Claude control this tab").
- **Pause** in the popup stops all commands at once.
- **Allowed sites** in the popup limit where Claude can act (see below).
- The bridge never types into password fields, never runs scripts on login pages, and blocks access to cookies.
- The MCP server listens on `127.0.0.1` only. Web pages cannot connect to it. Other local Claude sessions join with a token stored in `~/.sf-test-bridge/token`.
- While Claude controls a tab, Chrome shows a "started debugging this browser" bar. That is expected: the debugger API is what makes clicks and typing behave like a real user's.
- The extension asks for access to all sites so it can work with any org domain. It acts only on the tabs described above.

### Instructions for the AI agent, and briefs

Every AI agent session **must read your instructions once** before it can use the browser: until it calls `browser_guide`, every browser tool refuses. The instructions say why the tool is installed, the agent's role and responsibilities, what it must never do, and to **stop and ask numbered questions** when a request is too vague to test, instead of trying random things.

- **They are yours.** On first use they are written to `~/.sf-test-bridge/charter.md`. Edit that file with any editor; sessions that already read it are asked to read it again on their next tool call. `node mcp-server/src/cli.js charter diff` shows your changes, `charter reset` restores the default. Product updates never overwrite your file.
- **Editing them can't weaken the safety limits.** These are enforced in code whatever the text says: no logins or credential handling, the site lists, session lanes, and briefs.

**Briefs.** Anything that changes data or the page needs a **brief** agreed with you first, recorded with `browser_brief`: the org, what to test, what counts as working, and whether test data may be created or changed (`read-only` or `write`). Reading needs no brief.

- Changes covered: fill, typing (except into search boxes), select, key presses other than navigation keys, record actions such as Follow or Delete (Edit, New and Clone only open a form), Path moves, upload, evaluate, accepting a dialog other than "Leave site?", and clicking buttons such as Save, Next, Finish, Submit, Delete, Approve or Follow.
- With a brief, the session **stays in that org**: other orgs are refused.
- A write brief for an org whose address looks like **production** (no sandbox, developer or scratch part) is refused unless you explicitly allowed it.
- The popup's Control tab shows each session's brief ("may write", "read-only", "no brief").
- The CLI and the test suite are for people and are not gated.

In Claude Code, the `start-test` prompt (listed with the browser server's commands) starts a test the guided way: give what you know, and Claude asks only for what's missing.

`browser_doctor` (or `node mcp-server/src/cli.js doctor`) checks the setup and says what to fix:
- the extension is connected, and its version matches the MCP server,
- not paused,
- the site lists, and whether newer defaults exist,
- the window is wide enough for Lightning,
- your instructions file,
- the optional Salesforce CLI.

### Production orgs and destructive actions

- **Production is read-only for AI agents.** The org type comes from the address: sandbox, developer and scratch orgs have their own parts in the hostname, and anything else counts as production. You can correct it in the popup (Control tab, "Org type"). Any change an agent tries in a production org is refused until you allow writes there for 15, 30 or 60 minutes (Control tab). **Stop** ends the window early.
- **Destructive actions need your approval**, in any org: Delete, Mass Delete or Update, Change Owner, Merge and Convert.
  - The agent's call stops at once, and the toolbar icon shows a red **?**.
  - The popup shows the request with **Approve** and **Deny**.
  - An approval covers that action on that page for 2 minutes, including the confirm button. The agent then repeats the call.
- The popup shows the result of each action ("Approved.", "Not done: ..."), and each decision is recorded in the hub's traffic log.
- **Organization policy.** IT can set these through Chrome's policy for this extension (`extension/managed_schema.json`):
  - `allowList` / `blockList`, which replace the user's lists (shown locked in the popup),
  - `productionWrites: "never"`,
  - `orgSetupReading: false`.

### Debug logs (root cause of failures)

When a test fails, the debug log usually says why. SF Test Bridge reads it through **your own Salesforce CLI login** (`sf`, logged in by you). It doesn't work without the CLI: the browser's session can't read logs.

- **Set up once per org, by you.** Popup > Control > Debug logs > **Set up…**, or `node mcp-server/src/cli.js debuglog setup` in a terminal.
  - Choose the org from the CLI's list. Nothing is preselected, and production orgs are refused.
  - You see exactly what will be created: a debug level at full detail, and a trace flag for your CLI user.
  - Click **Create and test**. A one-line `System.debug` test proves the logs arrive.
  - If anything fails, everything created is removed again.
- **Start / Stop / Remove** in the popup, at any time. A logging window lasts 15, 30 or 60 minutes, and Salesforce ends it by itself.
  - **Remove** deletes exactly the records the setup created.
  - The logs that were already written stay in the org, where Salesforce ages them out.
- **Claude can't set up or start debug logs.** It can read the status, analyze, stop and remove (`browser_debuglog`). When a `browser_steps` test fails while logging is on, its result includes the root cause:
  - the exception, fatal error, validation rule or flow error,
  - the class or trigger and line, matched to your local source,
  - the database work and variable values just before the failure.
- **Where the logs go.** Full logs stay on your machine (under `evidence/debug-logs/`). What reaches Claude is only the extract, with emails and phone numbers masked.
- **Same user as the browser.** Logs are written for the CLI's user, so the browser must be logged in as that same user.

### What changed, and why (change trace)

Most of the time nothing fails: you save a record, and something else changes, or doesn't. The change trace answers "what changed on this record, and what changed it" from the debug logs alone.

- **Finding the right log.** A busy page writes dozens of logs. The trace keeps only those:
  - written between the action and the moment you ask,
  - running when the record was last saved (its LastModifiedDate, one date read with your CLI),
  - and that touch the record and change data, found by searching each log.

  Async work (Queueable jobs, a flow's async path) writes its own log later; it's included when it touches the record.
- **What you get, per record.** For each field: before → after, and what set it:
  - a flow element (with its line in the flow file),
  - an Apex line in a trigger or class (with the code),
  - a workflow rule,
  - or the save itself (your input).

  Related records changed in the same transaction (for example Contacts updated by an Account trigger) are listed too. An Apex call from the page names the LWC that imports it. A failed save says its changes were rolled back.
- **Timeline.** The full order of events: Apex calls from the page, triggers, flows with the outcome each decision took, record updates, async jobs queued, errors. It's saved as `trace.md` (readable, shareable) and `trace.json` (for other tools and agents).
- **Capture (popup or Claude).** Finds the logs of a change, also one that doesn't come from your own click: an API call, an integration, a scheduled flow, a colleague's edit.
  1. Press **Start capture** on the Debug logs card. Logging turns on if it's off, and the record open in the tab is watched.
  2. Do the action, or wait for the job. Nothing runs while the popup is closed; it catches up when you open it.
  3. The logs of every user since Start are listed: those with the record first, then those with an error (and its line), then those that change data; the rest are folded away. Type in **Find** (record ids, values, flow, element or class names): the downloaded logs are searched as you type, matches are highlighted, nothing is hidden. **Check** fetches new logs.
  4. **Explain** shows what one log changed and why. **Download** saves it. **Stop** ends the window (optional).
  5. **Send to Claude** saves the ticked logs' trace, every log of the window and an index with the time marks; then ask Claude to investigate your capture.

  Claude can start, stop, search and read the same capture (`browser_debuglog` `capture_start`, `capture_stop`, `capture_search`, `capture_view`); the popup shows when Claude did. Claude never turns logging on and can't add logging for other users.

  Salesforce only writes logs for users with logging on, so the capture also watches the record: when it changed but no log has it, the popup names the user who changed it (for example the user a scheduled flow runs as), and **Log *that user* too** adds logging for them until yours ends. Stop and Remove take it away again.
- **Fast reads.** Logs and record dates are read in the bridge server through your Salesforce CLI's own library and login (read-only requests; the session stays inside the library), with the CLI itself as fallback. Changes in the org (logging on and off) always go through the CLI.
- **Claude:** `browser_debuglog` with `trace` (optionally a `recordId` and `terms`), or `browser_steps` with `trace: true`; the capture actions above.
- **Not in scope:** performance profiling and full call trees. For those, open the log in [Apex Log Analyzer](https://marketplace.visualstudio.com/items?itemName=FinancialForce.lana) (Certinia).
- **Known limits** (seen in a real org):
  - A scheduled flow ran as another user (the org's default automation user), so nothing was logged until logging was added for that user.
  - The schedule time in a flow's file is the org's local time, whatever the "Z" says.
  - A REST update can write two logs: one with only the before-save flows, then the save (seen once of three times).
  - A save stopped by a validation rule writes no log; the error on the page is the evidence.
  - A before-save flow that fails has no error line in its log.
  - Values longer than a few words are cut in the log.
  - Anonymous Apex run from the CLI is logged at lower detail.
  - Downloaded logs are kept on your machine, so repeated searches are fast. Nothing is deleted automatically: Remove clears them, or delete the folder `~/.sf-test-bridge/log-cache`.

### Checking what you changed

`sf_verify_change` checks your diff in the real org. It reads the git diff of your Salesforce DX project: uncommitted and untracked changes by default, or `since` a ref, or a list of files. Then it works out what each change is, and:

- **checks it against the org's setup** (read-only, needs the org's setup permission): is it deployed, with the same label, type, required flag and picklist values, and is it on the edit layout? Your org's **namespace** is handled: `Discount__c` in the source is `ns__Discount__c` in the org.
- **runs read-only UI checks:** each changed field shows on the New form, and its picklist offers the deployed values. The form is cancelled afterwards.
- **plans the behaviour tests** that need test data: validation rules (condition, message, where it shows), record-triggered flows (object, timing, entry criteria), Apex triggers, LWC (where it's used), quick actions and Paths. The agent runs them with `browser_steps`, under a write brief.

It returns a report, plus a snippet for the pull request or ticket in which only what actually ran is ✅ or ❌. Planned tests show as 🧪 "to test".

To run it after every deploy, you can add a Claude Code hook that asks Claude to run `sf_verify_change` once `sf project deploy` succeeds. It's not installed by default.

### Reading the org's setup

`browser_org_info` reads an object's fields, picklist values for each record type, the edit layout and record types, with **your own browser login** through Salesforce's UI API. It only reads, needs no extra setup, and doesn't use the org's daily API limit.

- **Off for each org until you allow it** (popup Control tab, "Let Claude read this org's setup"). Settings lists the allowed orgs with **Revoke** and **Clear cache**.
- **Answers follow the user's own access.** What this user can't see is reported as such. Users without "API Enabled" get a plain note to read the page instead.
- **Cached for 1 hour** for each org and user under `~/.sf-test-bridge/orgs/`. Setup only, never record data.
- `browser_fill` uses it to:
  - accept a field's API name (`apiName`) instead of its label,
  - refuse a picklist value that isn't valid before anything is typed,
  - warn when text is longer than the field holds.
- `sf_project_info` reads what you built from the local Salesforce DX project (fields, validation rules, flows, triggers, LWC and where they're used, layouts, permission sets, Paths), with no org access.

### Several Claude sessions at once

Several Claude Code sessions (or other agents) can use the browser at the same time. They share one port; the first session's MCP server runs the hub and the others connect to it. Each session gets its own **lane**:

- The tabs it opened, plus the popups and new tabs those open. A tab you share from the popup belongs to the first session that uses it.
- Its own default tab. A tool called without `tabId` uses this session's last tab, never another session's.
- Its own window (or, with "open new tabs in the current window", its own tab group), titled **Claude · \<session\>**, each in a different colour.
- A session cannot act on another session's tabs. It gets an error telling it to open its own tab.
- Commands from different sessions run at the same time. They don't wait for each other.

The session name is the project folder name. Set `BROWSER_BRIDGE_SESSION` for the MCP server to choose another one.

**When a session's work is done** its lane ends, and the session's tabs are released (they stay open and Claude can no longer act on them) or closed, as set on the popup's **Settings** tab. A lane ends when:

- Claude calls `browser_end_session`, or
- the session exits (the hub notices its MCP server disconnecting), or
- it has been idle for 30 minutes (configurable, 0 = never), or
- you press **End** next to it on the popup's **Control** tab.

`browser_reload_extension` is refused while another session is running a command, because a reload stops every command in flight. Pass `force: true` to reload anyway.

### Allowed sites

Open the extension popup and go to the **Sites** tab. It has an **Allow** and a **Block** list; put one pattern on each line. **Test an address** shows whether Claude could act on a given URL with the lists as typed, before you save them.

- **Allow:** Claude may act only on pages that match one of these. If the list is empty, every site is allowed.
- **Block:** Claude may never act on pages that match one of these, even if they also match the allow list.

| Pattern | Matches |
|---|---|
| `abc.my.salesforce.com` | every page on that host (not `abc.my.salesforce.com.other.com`) |
| `abc.my.salesforce.com/_ui/common/apex/debug` | pages whose path starts with that |
| `*.lightning.force.com` | every subdomain of `lightning.force.com` |
| `*/_ui/common/apex/debug` | that path on any host |
| `abc.my.salesforce.com/setup/*/Users` | `*` in the path matches anything |
| `/apexcsipage/` | a regular expression, tested on the full URL |

Matching ignores upper and lower case. Lines starting with `#` are comments.

**Default lists.** On first start the extension fills both lists with defaults that work for any org: production, sandboxes, and developer and scratch orgs. **Reset to defaults** in the popup puts them back. They are defined in `extension/sitepolicy.js`.

- **Allowed by default:** the pages a sales or service user works in:
  - record pages and related lists (`/lightning/r/`)
  - object home, list views and New record (`/lightning/o/`)
  - Home, Chatter and other standard pages (`/lightning/page/`)
  - custom tabs (`/lightning/n/`)
  - switching apps (`/lightning/app/`)
  - quick actions and component pages (`/lightning/action/`, `/lightning/cmp/`)
  - search
  - Visualforce pages shown inside Lightning
  - file previews
- **Blocked by default:** the Setup menu and admin and developer tools:
  - Setup, Object Manager, Data Cloud Setup and Salesforce Go (`/lightning/setup/` and the `*.salesforce-setup.com` domain)
  - Web Console, and the classic Developer Console
  - Agentforce Vibes
  - Flow Builder, Lightning App Builder, Experience Builder and Process Builder
  - Login As
  - `frontdoor.jsp`
  - raw API pages (`/services/`)

With the defaults, open a record, list or home URL directly (for example `https://yourdomain.lightning.force.com/lightning/o/Account/list`). The bare org address is not in the allow list.

How the lists are applied:

- A command on a tab that is on a page outside the allowed sites is refused before anything happens on the page.
- `browser_open` and `browser_navigate` check the target URL first.
- If an action takes the tab onto a blocked page (a link, a redirect, or a menu item such as **Edit Page**), its result is withheld. On that page Claude can only go back, navigate to an allowed URL, close the tab, or answer the page's "Leave site?" prompt. Any other dialog it can only cancel.
- Iframes are checked too. Claude cannot read or act inside an iframe from a site outside the lists.
- Only you can change the lists, from the popup. Claude can see them through `browser_status`, but it cannot change them.

## Settings

All optional, set as environment variables for the MCP server (for example with `-e NAME=value` in `claude mcp add`):

| Variable | Default | Purpose |
|---|---|---|
| `BROWSER_BRIDGE_PORT` | `17345` | Port between the MCP server and the extension. Set the same port in the extension popup |
| `BROWSER_BRIDGE_CHARTER` | `~/.sf-test-bridge/charter.md` | Your instructions for AI agents (created from the default on first use) |
| `BROWSER_BRIDGE_SESSION` | project folder name | Name of this session's lane (tab group "Claude · <name>") |
| `BROWSER_BRIDGE_DASHBOARD_PORT` | `17380` | Evidence dashboard port |
| `BROWSER_BRIDGE_EVIDENCE_DIR` | `evidence/` | Where evidence is saved |
| `BROWSER_BRIDGE_EVIDENCE` | `steps` | `steps`, `failures` or `off` |
| `BROWSER_BRIDGE_ACTION_LOG` | `~/.sf-test-bridge/actions.jsonl` | Action log file, or `off` |
| `BROWSER_BRIDGE_RAW_LOG_DIR` | `mcp-server/logs/` | Raw traffic log folder |
| `BROWSER_BRIDGE_EXTENSION_ID` | `kokfnnhacmipalbbndbpnbhpfhilopef` | Extension ID to accept, if you load the extension with your own key |

If you run Chrome and Edge at the same time, the most recently connected one is used. `browser_status` with `use: "<id>"` switches.

## Tests

```
cd mcp-server && npm test          # offline, no browser needed
```

Full suite against your org (browser open with the extension, logged in):

```
# macOS / Linux
SF_ORG_URL=https://yourdomain.lightning.force.com node tests/e2e-salesforce.mjs

# Windows PowerShell
$env:SF_ORG_URL="https://yourdomain.lightning.force.com"; node tests/e2e-salesforce.mjs
```

The end-to-end suite drives your real browser against a **test or developer org**, because it creates records and then deletes them (all named "Bridge E2E …"). A few tests need extra custom fixtures (a screen flow, an LWC action, custom fields), which are not in this repo; those tests are skipped when the fixtures are missing. To run only some tests, add a name filter: `node tests/e2e-salesforce.mjs fill lookup`.

## Command line (without an MCP client)

`node mcp-server/src/cli.js doctor` checks the setup; `node mcp-server/src/cli.js charter [diff|reset]` shows, compares or restores the agent instructions.

CLI calls share one lane named `cli`, so `open` in one call and `snapshot` in the next act on the same tab. Run `BROWSER_BRIDGE_SESSION=<name>` to give the CLI its own separate lane, and `node mcp-server/src/cli.js endSession '{}'` to end it.

```
node mcp-server/src/cli.js status
node mcp-server/src/cli.js open '{"url":"https://example.com"}'
node mcp-server/src/cli.js snapshot '{}'
node mcp-server/src/cli.js fill '{"fields":[{"label":"Stage","value":"Closed Won"}],"submit":"Save"}'
node mcp-server/src/cli.js steps @steps.json
```

## Project layout

| Path | What it is |
|---|---|
| `extension/` | The browser extension (Manifest V3) |
| `mcp-server/` | The MCP server, the local hub, the CLI, the step runner and the evidence store |
| `dashboard/` | Evidence dashboard (no dependencies) |
| `tests/` | Offline tests and the end-to-end Salesforce suite |

## Limits

- `browser_evaluate` runs in the top frame only. Reading, clicking and typing work in every frame.
- `browser_upload` can't reach file inputs inside cross-origin iframes.
- Allowed sites stop Claude from reading or acting through the page's scripts. A screenshot of an allowed page still shows the pixels of a blocked iframe inside it.
- Firefox and Safari are not supported.

## License

[MIT](LICENSE)
