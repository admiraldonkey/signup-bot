# Current Development State

**Last reconciled:** 21 September 2026

This document is the short-form handoff for the active development checkpoint.

It is not a changelog. Durable project context belongs in:

- [`../README.md`](../README.md)
- [`README.md`](./README.md)
- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`DECISIONS.md`](./DECISIONS.md)
- [`ROADMAP.md`](./ROADMAP.md)
- [`TESTING-GUIDE.md`](./TESTING-GUIDE.md)
- [`ADMIN-GUIDE.md`](./ADMIN-GUIDE.md)

---

# Current Repository Checkpoint

The P0 foundation and reliability phase is complete.

Established implementations include:

- persistent event creation and lifecycle
- immediate, manual, and scheduled publication
- attendance signups and actual-attendance recording
- organiser nomination, escalation, cover, and safety workflows
- organiser feature controls
- persistent reminders
- event-level role requests
- reusable role-request presets
- preset editing and lifecycle management
- preset application using event-owned snapshot semantics
- scheduled role-request opening and closing
- durable PostgreSQL-backed scheduled work
- PostgreSQL-backed audit logging
- Discord presentation recovery for key message types
- regression-first reliability coverage
- deterministic PostgreSQL concurrency testing

The current major development phase is:

```text
P1
Event Templates
```

P1.1 schema reconciliation is complete.

Migration:

```text
0021_reconcile-event-template-schema
```

established the template source model and removed the obsolete pre-preset template scaffolding.

Template administrator commands and generation behaviour are **not yet implemented**.

---

# Completed P1.1 Data Model

A template is reusable source configuration for creating an ordinary persistent event.

The authoritative source aggregate is:

```text
event_templates
```

with reusable child state in:

```text
event_template_ping_roles
event_template_organiser_defaults
event_template_reminders
```

The template may reference:

```text
zero or one role_request_preset
```

through:

```text
event_templates.role_request_preset_id
```

The old:

```text
template_role_options
```

graph has been removed.

Templates do not own a second reusable role-request architecture.

---

# Template Source Fields

The reconciled template source model contains reusable defaults for:

- owning guild
- event type
- optional audience
- optional role-request preset
- name
- description
- timezone
- optional local start time
- duration
- signup enabled/disabled
- signup-close offset
- detailed-deadline presentation
- publication intent
- optional scheduled-publication offset
- optional fixed publication channel
- active/inactive lifecycle
- creator
- timestamps

The normal template duration default is:

```text
60 minutes
```

Do not reintroduce the historical two-hour assumption.

---

# Publication Source Intent

Templates store explicit source-level publication intent:

```text
manual
scheduled
immediate
```

Rules:

```text
scheduled
    -> publish_minutes_before_start required

manual
    -> publish_minutes_before_start null

immediate
    -> publish_minutes_before_start null
```

This source intent must map into the existing event publication architecture.

Generated events must continue to use ordinary:

```text
publicationChannelId
publishMinutesBeforeStart
publish_event scheduled action
publishStoredEvent(...)
```

or deliberately evolved equivalents.

Do not introduce a second runtime publication model for templates.

Immediate publication remains an external Discord side effect and therefore cannot occur inside the authoritative PostgreSQL generation transaction.

---

# Generated Event Snapshot Boundary

Generation must produce an ordinary event which owns its runtime state.

Conceptually:

```text
template
    |
    | generate
    v
ordinary event
    |
    +---- event defaults
    +---- publication state
    +---- ping-role snapshots
    +---- organiser assignments where applicable
    +---- event_reminders
    +---- role-request snapshots
    +---- scheduled_actions
```

After commit:

```text
template
    -> source/provenance

event
    -> authoritative runtime state
```

Later template edits must not rewrite existing generated events.

Later preset edits must not rewrite existing event-level role-request snapshots.

---

# Template Provenance

Generated events retain:

```text
events.template_id
```

as source provenance.

The foreign key now uses:

```text
ON DELETE RESTRICT
```

rather than clearing the relationship automatically.

Template lifecycle should therefore normally use reversible:

```text
active / inactive
```

state rather than hard deletion.

A generated event must never consult its current template definition for ordinary runtime behaviour merely because `template_id` exists.

---

# Ping Roles

Reusable template ping roles live in:

```text
event_template_ping_roles
```

with:

- Discord role ID
- readable role-name snapshot
- explicit ordering

Generation must copy them into ordinary:

```text
event_ping_roles
```

The generated event then owns that collection independently.

---

# Organiser Defaults

Reusable organiser defaults live in:

```text
event_template_organiser_defaults
```

Supported source slots are:

```text
primary
backup
```

`cover` is runtime recovery state and does not belong in reusable template configuration.

A template may contain **zero organiser defaults**.

This is important because organiser functionality is optional at guild level.

Generation requirements:

```text
organisers enabled
    + template organiser defaults
        -> create ordinary dormant event_organiser_assignments

organisers disabled
        -> generation must still succeed
        -> do not create organiser assignments
```

Disabling organiser functionality must never make templates generally unusable.

If organiser defaults exist, a backup must not be allowed to become an independent organiser workflow outside the established primary/backup lifecycle.

---

# Role Requests

Templates reuse the established role-request preset system.

P1 currently supports:

```text
template
    -> zero or one role_request_preset
```

Generation must snapshot the referenced preset through the existing preset application architecture.

It must produce ordinary event-owned:

```text
event_role_options
event_role_option_qualification_roles
role_request_groups
role_request_group_options
role_request_group_notification_roles
event_role_request_preset_applications
scheduled_actions
```

as applicable.

Do not recreate template-specific role-option tables or runtime behaviour.

Guild ownership of the referenced preset must be validated before generation.

Inactive or otherwise unusable preset graphs must fail validation rather than create partial generated state.

---

# Template Reminders

Reusable reminder definitions live in:

```text
event_template_reminders
```

Supported timing references initially match ordinary event reminders:

```text
event_start
signup_close
```

Generation must create ordinary:

```text
event_reminders
```

and their normal durable scheduled actions.

Template reminder `channel_id` semantics are:

```text
non-null
    -> fixed reusable template destination

null
    -> resolve generated event publication destination
    -> snapshot that resolved channel into event_reminders.channel_id
```

Runtime reminder execution must never need to read the template again.

---

# Reminder Prerequisite Completed

The pre-generation reminder review identified a real defect.

Previously, signup-close reminders were considered invalid whenever:

```text
event.status != open
```

which incorrectly cancelled legitimate reminders for:

```text
status = scheduled
publishedAt = null
```

A PostgreSQL integration regression now protects this case.

Current intended behaviour includes:

```text
scheduled
+ signups enabled
+ future signup close
    -> future signup-close reminder remains valid

closed
    -> signup-close reminder is cancelled
```

Template generation may now rely on long-lived unpublished scheduled events without that particular reminder lifecycle defect.

---

# Recurrence Remains Separate

Recurrence is deliberately not part of the reconciled template schema.

One-off template generation must become stable first.

Future recurrence should conceptually remain:

```text
template
    |
    +---- recurrence definition
              |
              v
       bounded generator
              |
              v
       ordinary event occurrences
```

Likely future direction remains an RFC 5545-compatible recurrence representation and a bounded rolling horizon.

Occurrence identity must remain distinct from mutable event start time.

---

# Immediate Objective

The next implementation task is to establish the transaction-aware service boundaries required for **atomic one-off template generation**.

Do not add template slash commands yet.

The required authoritative transaction is conceptually:

```text
lock / validate template source
        |
        v
resolve source defaults
        |
        v
create ordinary event
        |
        +---- ping-role snapshots
        +---- optional organiser assignments
        +---- reminder snapshots/actions
        +---- role-request preset snapshots/actions
        +---- core event scheduled actions
        |
        v
commit everything together
```

A failure during authoritative generation must not leave behind:

- an event without its required snapshots
- partial organiser assignments
- partial reminders
- partial preset application
- partial role-request groups
- partial scheduled actions

Discord side effects happen after commit through the existing publication/revalidation principles.

---

# Required Service-Boundary Work

Current public services own transactions independently.

Template generation therefore must not simply call several independently committing services in sequence.

The next work should inspect and deliberately evolve:

```text
createStoredEvent()

applyRoleRequestPresetToEvent(...)

reminder creation / scheduled-action creation
```

towards transaction-aware reusable boundaries.

Expected shape:

```text
public operation
    -> db.transaction(tx =>
         internal transaction-aware operation(tx, ...)
       )

template generation
    -> db.transaction(tx => {
         internal event creation
         reminder snapshot creation
         preset snapshot application
         other generated state
       })
```

Names are not predetermined.

Prefer clear reusable boundaries over abstractions created merely for symmetry.

Existing public behaviour must remain unchanged during the refactor.

---

# Locking and Concurrency Direction

Template generation should use the same source-snapshot principle already established for presets.

Expected direction:

```text
template generation
    -> template parent FOR SHARE

template mutation
    -> template parent FOR UPDATE
```

Generation should therefore observe either:

```text
complete old template graph
```

or:

```text
complete new template graph
```

never a mixture.

Referenced role-request presets retain their established locking contract.

Use deterministic PostgreSQL barriers/locks for concurrency tests rather than timing sleeps.

---

# Guild Ownership

Reusable source relationships must remain explicitly guild-scoped.

Before generation, validate that relevant reusable records belong to the same guild as the template, including:

- event type
- audience
- role-request preset
- template child records through their parent

Do not trust foreign IDs merely because the database relationship exists.

---

# Schema and Migration Rules

Schema source:

```text
src/db/schema.ts
```

Current template reconciliation migration:

```text
drizzle/0021_reconcile-event-template-schema.sql
```

Do not edit migrations that may already have been applied.

For future schema work:

```bash
npm run db:generate
```

Review generated SQL manually.

Use concise explicit database identifiers where generated foreign-key, constraint, or index names risk approaching PostgreSQL's 63-byte identifier limit.

Relevant migration behaviour should receive PostgreSQL-backed migration-chain coverage.

---

# Development Workflow

For each implementation slice:

1. inspect the current pushed branch
2. inspect the exact services being changed
3. add regression-first coverage for defects
4. add direct service/integration coverage for new behaviour
5. use deterministic PostgreSQL locking for concurrency-sensitive behaviour
6. run targeted tests first
7. run the affected broader suite
8. run typechecks
9. run the full verification gate at meaningful commit/PR boundaries

Normal full gate:

```bash
npm run test:unit
npm run test:integration
npm run test:coverage
npm run typecheck
npm run typecheck:test
git diff --check
```

Manual Discord smoke testing is only warranted when behaviour materially reaches Discord commands, components, permissions, selectors, mentions, DMs, or presentation.

---

# Documentation Expectations

As P1 advances:

- update `ARCHITECTURE.md` when implemented boundaries change
- update `DECISIONS.md` for durable choices
- keep `ROADMAP.md` focused on remaining work
- rewrite this handoff when the checkpoint changes
- update `ADMIN-GUIDE.md` only when administrator-facing behaviour changes
- update `TESTING-GUIDE.md` only when a genuinely new testing pattern becomes established

The next code change should remain below the Discord command layer.
