# Safety, privacy and allowed sites

What the bridge will and will not do, the rules every AI agent must follow, and what stays on your machine.

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

## Allowed sites

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

## Logs and privacy

Everything stays on your machine. Nothing is sent anywhere except between the MCP server and the extension on `127.0.0.1`. Two logs are written by default:

| Log | Where | Contents |
|---|---|---|
| **Action log** | `~/.sf-test-bridge/actions.jsonl` | One line per tool call. Typed text and sensitive-looking fields are redacted |
| **Raw traffic log** | `mcp-server/logs/extension-raw-<date>.log` | Every message between the MCP server and the extension, **unredacted**: page text, field values and screenshots (as base64) from the pages Claude works on |

> **Note:** the raw traffic log and `evidence/` can contain data from your org, such as customer records. Treat them as confidential, don't share or commit them (both are in `.gitignore`), and delete old ones when you no longer need them. Use `BROWSER_BRIDGE_RAW_LOG_DIR` to move the raw log and `BROWSER_BRIDGE_ACTION_LOG` to move or turn off (`off`) the action log.

---

[← Back to the README](../README.md)
