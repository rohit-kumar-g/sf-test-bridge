# Contributing to SF Test Bridge

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Before you start

- **Bugs and ideas:** open an [issue](https://github.com/rohit-kumar-g/sf-test-bridge/issues/new/choose) using the templates. Run `browser_doctor` (or `node mcp-server/src/cli.js doctor`) first and include its output.
- **Security issues:** don't open a public issue; see [SECURITY.md](SECURITY.md).
- **Bigger changes:** open an issue first so we can agree on the approach before you write the code.

## Development setup

```bash
git clone https://github.com/rohit-kumar-g/sf-test-bridge.git
cd sf-test-bridge/mcp-server
npm install
```

Load `extension/` as an unpacked extension (see the [README](README.md#quick-start)). Opening Claude Code in the repository folder picks up `.mcp.json`, which runs the server from your checkout.

- After changing **extension** code: `node mcp-server/src/cli.js reload` (or the reload button on `chrome://extensions`).
- After changing **MCP server** code: reconnect the `browser` server in Claude Code (`/mcp`) or restart it. The hub reloads `debuglog.js` by itself.

There is no build step: plain JavaScript (ES modules in the server, Manifest V3 in the extension), and only two runtime dependencies (`@modelcontextprotocol/sdk`, `ws`). Please keep it that way unless there's a strong reason.

## Tests

```bash
cd mcp-server && npm test          # offline, no browser or org needed
```

Every pull request must pass `npm test`; CI runs it on Linux and Windows. The tests are plain Node scripts with `node:assert` in `tests/`. The debug log tests use a stand-in for the Salesforce CLI (`tests/fixtures/fake-sf.mjs`) and scrubbed real logs (`tests/fixtures/real-trace/`).

The end-to-end suite drives your real browser against a **test or developer org**: it creates records and deletes them afterwards (all named "Bridge E2E …"). Never run it against production.

```bash
# macOS / Linux
SF_ORG_URL=https://yourdomain.lightning.force.com node tests/e2e-salesforce.mjs

# Windows PowerShell
$env:SF_ORG_URL="https://yourdomain.lightning.force.com"; node tests/e2e-salesforce.mjs
```

A few end-to-end tests need custom fixtures (a screen flow, an LWC action, custom fields) that are not in this repository; they're skipped when missing. To run only some tests, add a name filter: `node tests/e2e-salesforce.mjs fill lookup`.

## Project layout

| Path | What it is |
|---|---|
| `extension/` | The browser extension (Manifest V3): background worker, content script, popup, site policy |
| `mcp-server/src/` | The MCP server (`index.js`), the local hub, the CLI, the step runner, debug logs and change trace, the evidence store |
| `dashboard/` | Evidence dashboard (no dependencies) |
| `docs/` | User documentation |
| `tests/` | Offline tests, fixtures and the end-to-end Salesforce suite |

## Guidelines

- **Safety rules are enforced in code, not in prompts.** A change must not let an agent log in, handle credentials, act outside its lane or the site lists, write to production without the user's window, or skip a brief or an approval. Add a test when you touch these paths.
- **Keep user-facing text short and plain** (popup, tool results). Ids, levels and details belong in the logs.
- **No personal or org data in the repository:** no org addresses, usernames, emails, customer data, evidence or logs. Test fixtures must be scrubbed.
- Update the docs in `docs/` and the [CHANGELOG](CHANGELOG.md) (under a new or `Unreleased` heading) in the same pull request.
- Bump the version in **both** `extension/manifest.json` and `mcp-server/package.json` for a release; `browser_doctor` compares them.

## Pull requests

1. Fork, and create a branch from `main`.
2. Make the change, with tests.
3. Run `npm test` in `mcp-server/`.
4. Open the pull request and fill in the template.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE), and to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
