# Debug logs, change trace and capture

Root cause of a failed test, and "what changed on this record, and what changed it", from Salesforce debug logs read through your own Salesforce CLI.

## Debug logs (root cause of failures)

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

## What changed, and why (change trace)

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
- **Log any user.** **Log a user…** on the Debug logs card adds logging for any active user, whatever their licence: an integration or API-only user, Automated Process, Platform Integration User, a site guest or a portal user.
  - With the search box empty it lists the users background work usually runs as (integration and API users, Automated Process, Platform Integration). Type a name, username or email to find anyone else. Each user shows their licence.
  - Added users show as chips under **Also logging**; **×** stops one. Their logging lasts as long as yours, and is renewed with it.
  - If your own logging is off, adding a user turns it on first.
  - Only the trace flags the bridge created are ever removed. A user someone else already logs is reported, not changed.
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

---

[← Back to the README](../README.md)
