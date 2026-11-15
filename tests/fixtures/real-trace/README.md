# Real debug logs for the change-trace tests

Captured from a Developer Edition org with automation built for this purpose (triggers, a handler class, a Queueable, an invocable class, an LWC calling Apex, a before-save and an after-save flow with an async path and a fault). Org id, user, username and namespace are replaced.

- `07LjV000003OUjBUAW` (common.api.soap.DirectSoap): S1 pre-save check: before-save flow, field not found (namespace), no error line
- `07LjV000003OUrFUAW` (N/A): noise: async log with profiling only
- `07LjV000003OUsrUAG` (/aura): S1b UI save Rating Cold->Hot: before-save flow, triggers, Contact cascade, after-save flow, invocable
- `07LjV000003OUuTUAW` (N/A): S1b async flow path
- `07LjV000003OV2XUAW` (common.api.soap.DirectSoap): S2 pre-save check
- `07LjV000003OV2YUAW` (/aura): S2 UI save AnnualRevenue: trigger score, queueable queued
- `07LjV000003OV49UAG` (QueueableHandler): S2 Queueable job
- `07LjV000003OVAbUAO` (/aura): S4 LWC quick action -> Apex setRating
- `07LjV000003OVCDUA4` (N/A): S4 async flow path
- `07LjV000003OVDqUAO` (/aura): S5 addError (name with BLOCK)
- `07LjV000003OVH4UAO` (/aura): S6 after-save flow fault (REQUIRED_FIELD_MISSING)
- `07LjV000003OVKHUA4` (Api): S8 anonymous Apex from the CLI (lower detail)
- `07LjV000003OwynUAC` (/aura): B1 UI inline edit Rating Cold->Cold: saved, automation ran, nothing changed
- `07LjV000003OxA5UAK` (common.api.soap.DirectSoap): B2 pre-save check: the only log with the before-save flow (Set_Tier_Gold)
- `07LjV000003OxA6UAK` (/aura): B2 UI inline edit Rating Cold->Hot: save log without the before-save flow
- `07LjV000003OxDJUA0` (N/A): B2 async flow path
- `07LjV000003Oza5UAC` (/services/data/v68.0/sobjects/Account/001jV00000L8HHJQA3): C1 REST update Rating: pre-save check log (before-save flow only)
- `07LjV000003Oza6UAC` (/services/data/v68.0/sobjects/Account/001jV00000L8HHJQA3): C1 REST update Rating Warm->Cold: the save
- `07LjV000003OyKgUAK` (N/A): C1 async flow path
- `07LjV000003OzbhUAC` (/services/data/v62.0/actions/custom/flow/acmens__Bridge_Trace_Autolaunched): C2 autolaunched flow called through REST (update by filter)
- `07LjV000003OzdJUAS` (N/A): C2 noise: async log without the record
- `07LjV000003P0UXUA0` (acmens__Bridge_Trace_Scheduled-5): C4 scheduled flow job (picks the records), as another user
- `07LjV000003P0W9UAK` (ApexContextImpl): C4 scheduled flow ran as another user: the run (ApexContextImpl)
- `07LjV000003P0XlUAK` (N/A): C4 async flow path, as the other user
- `07LjV000003P1IXUA0` (/acmens/bridgetrace): M1 Apex REST endpoint (operation = its URL mapping)
- `07LjV000003P1QbUAK` (Batch Apex): M2 Batch Apex start
- `07LjV000003P1TpUAK` (Batch Apex): M2 Batch Apex finish: LimitException (no @future from a batch)
- `07LjV000003P1SEUA0` (SerialBatchApexRangeChunkHandler): M2 Batch Apex execute chunk (the update)
- `07LjV000003P1f7UAC` (Platform Event Process): M4 platform-event flow, logged as Automated Process
- `07LjV000003P1wrUAC` (/services/data/v62.0/composite/sobjects): M7 composite update: pre-save check
- `07LjV000003P1wsUAC` (/services/data/v62.0/composite/sobjects): M7 composite update of an Account and 2 Contacts
- `07LjV000003P205UAC` (FutureHandler): M8 @future method
- `07LjV000003P2jFUAS` (Bridge Trace Matrix 1794727758164): M3 scheduled Apex job (operation = the job name)
- `07LjV000003PPmIUAW` (/aura): P1 UI edit from the popup capture: Parent Account set from empty

`project/` holds the metadata the logs refer to. Validation-rule failures from the UI wrote no log at all in this org, so there is none here.
