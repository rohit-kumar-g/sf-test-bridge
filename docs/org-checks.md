# Checking your changes against the org

Verify a deployment against the real org, and read an object's setup with your own browser login.

## Checking what you changed

`sf_verify_change` checks your diff in the real org. It reads the git diff of your Salesforce DX project: uncommitted and untracked changes by default, or `since` a ref, or a list of files. Then it works out what each change is, and:

- **checks it against the org's setup** (read-only, needs the org's setup permission): is it deployed, with the same label, type, required flag and picklist values, and is it on the edit layout? Your org's **namespace** is handled: `Discount__c` in the source is `ns__Discount__c` in the org.
- **runs read-only UI checks:** each changed field shows on the New form, and its picklist offers the deployed values. The form is cancelled afterwards.
- **plans the behaviour tests** that need test data: validation rules (condition, message, where it shows), record-triggered flows (object, timing, entry criteria), Apex triggers, LWC (where it's used), quick actions and Paths. The agent runs them with `browser_steps`, under a write brief.

It returns a report, plus a snippet for the pull request or ticket in which only what actually ran is ✅ or ❌. Planned tests show as 🧪 "to test".

To run it after every deploy, you can add a Claude Code hook that asks Claude to run `sf_verify_change` once `sf project deploy` succeeds. It's not installed by default.

## Reading the org's setup

`browser_org_info` reads an object's fields, picklist values for each record type, the edit layout and record types, with **your own browser login** through Salesforce's UI API. It only reads, needs no extra setup, and doesn't use the org's daily API limit.

- **Off for each org until you allow it** (popup Control tab, "Let Claude read this org's setup"). Settings lists the allowed orgs with **Revoke** and **Clear cache**.
- **Answers follow the user's own access.** What this user can't see is reported as such. Users without "API Enabled" get a plain note to read the page instead.
- **Cached for 1 hour** for each org and user under `~/.sf-test-bridge/orgs/`. Setup only, never record data.
- `browser_fill` uses it to:
  - accept a field's API name (`apiName`) instead of its label,
  - refuse a picklist value that isn't valid before anything is typed,
  - warn when text is longer than the field holds.
- `sf_project_info` reads what you built from the local Salesforce DX project (fields, validation rules, flows, triggers, LWC and where they're used, layouts, permission sets, Paths), with no org access.

---

[← Back to the README](../README.md)
