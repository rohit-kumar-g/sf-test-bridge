# Configuration, sessions and the command line

Environment variables, running several Claude sessions at once, and using the bridge without an MCP client.

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

## Several Claude sessions at once

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

---

[← Back to the README](../README.md)
