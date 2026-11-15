# Tools and test evidence

Every tool the MCP server offers, how a whole test case runs in one call, and the evidence dashboard.

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

---

[← Back to the README](../README.md)
