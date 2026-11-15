# Security policy

SF Test Bridge drives a real browser that is logged into Salesforce, so security reports are taken seriously.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability** ([direct link](https://github.com/rohit-kumar-g/sf-test-bridge/security/advisories/new)).

Include what you found, how to reproduce it, and the impact you expect. You'll get an acknowledgement within a few days, and a fix or a plan will be agreed with you before anything is disclosed.

## In scope

The safety guarantees described in [docs/safety.md](docs/safety.md), for example:

- an AI agent logging in, reading or typing credentials, or reaching cookies,
- an agent acting on tabs outside its own lane, or on sites outside the allowed lists,
- changes in a production org without the user's write window, or destructive actions without the user's approval,
- skipping the agent instructions or the brief,
- a web page or another local process controlling the browser through the bridge,
- org data leaving the user's machine.

## Out of scope

- What the logged-in Salesforce user can already do by themselves in the browser.
- Data in the local logs and evidence on the user's own machine (documented in [docs/safety.md](docs/safety.md#logs-and-privacy)).
- Problems in Salesforce, Chrome, Edge or the MCP client.

## Supported versions

Only the latest release gets security fixes.
