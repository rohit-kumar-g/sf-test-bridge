# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The extension and the MCP server share one version number.

## [0.3.0] - 2026-11-15

### Added
- **Log a user** (Debug logs card): add debug logging for any active user, whatever their licence: integration and API-only users, Automated Process, Platform Integration User, site guests, portal users. Search by name, username or email; with no text, the users background work usually runs as. Added users show as chips, and **×** stops one.
- `.mcp.json` (Claude Code) and `.vscode/mcp.json` (VS Code) register the MCP server when you work inside this repository.
- Continuous integration on GitHub Actions (Linux and Windows, Node.js 20 and 22), contribution guide, security policy, code of conduct, and issue and pull request templates.

### Changed
- Renewing your own debug logging now renews the logging of the users you added, too.
- Adding a user from the popup turns your own logging on first when it's off.
- The README is now a short overview; the reference documentation lives in [`docs/`](docs/).

### Fixed
- Inactive users are refused with a clear message instead of getting a trace flag that never logs anything.

## [0.2.0] - 2026-11-15

### Added
- **Agent instructions and briefs:** every agent session reads your instructions first (`browser_guide`); anything that changes data needs a brief agreed with you (`browser_brief`); vague requests get numbered questions.
- **Org type and production rules:** production is read-only for agents unless you open a write window; destructive actions need your approval; `browser_doctor` checks the setup.
- `browser_org_info`: an object's fields, picklist values, layouts and record types, read with your own login and your consent per org.
- `sf_verify_change`: checks a local change against the org.
- **Debug logs** through your own Salesforce CLI, set up from the popup: root cause of a failed step.
- **Change trace:** what changed on a record and why (flow element, trigger or Apex line, workflow rule, the LWC that called the Apex).
- **Capture** (popup or Claude): the logs of any change, including API calls, scheduled flows, platform events, batch jobs and other users; instant search, Explain, Download, Send to Claude.

## [0.1.0] - 2026-11-09

### Added
- First public release: MCP server, Chrome/Edge extension and evidence dashboard. Claude reads pages as text, fills fields by label, runs test cases in one call and saves annotated screenshots as test evidence.

[0.3.0]: https://github.com/rohit-kumar-g/sf-test-bridge/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/rohit-kumar-g/sf-test-bridge/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/rohit-kumar-g/sf-test-bridge/releases/tag/v0.1.0
