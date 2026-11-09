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
| `browser_open`, `browser_navigate`, `browser_tabs`, `browser_close` | Open and manage tabs. Claude's tabs open in their own window and a "Claude" tab group |
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
- The bridge never types into password fields, never runs scripts on login pages, and blocks access to cookies.
- The MCP server listens on `127.0.0.1` only. Web pages cannot connect to it. Other local Claude sessions join with a token stored in `~/.sf-test-bridge/token`.
- While Claude controls a tab, Chrome shows a "started debugging this browser" bar. That is expected: the debugger API is what makes clicks and typing behave like a real user's.
- The extension asks for access to all sites so it can work with any org domain. It acts only on the tabs described above.

## Settings

All optional, set as environment variables for the MCP server (for example with `-e NAME=value` in `claude mcp add`):

| Variable | Default | Purpose |
|---|---|---|
| `BROWSER_BRIDGE_PORT` | `17345` | Port between the MCP server and the extension. Set the same port in the extension popup |
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
- Firefox and Safari are not supported.

## License

[MIT](LICENSE)
