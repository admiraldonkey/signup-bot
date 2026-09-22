# Current Development State

**Last reconciled:** 22 September 2026

This document is the short-form handoff for the active development checkpoint.

It is not a changelog.

Durable project context belongs in:

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

The current major phase is:

```text
P1
Event Templates
```

The following P1 foundations are implemented:

```text
P1.1 schema reconciliation
transaction-aware event creation
transaction-aware reminder creation
transaction-aware role-request preset application
atomic one-off template generation
generation snapshot independence
deterministic template source-lock concurrency coverage
```

Template administrator commands are not yet implemented.

Recurrence is not yet implemented.

---

# Implemented Template Source Model

Reusable template source state lives in:

```text
event_templates

event_template_ping_roles

event_template_organiser_defaults

event_template_reminders
```

A template may reference:

```text
zero or one role_request_preset
```

through:

```text
event_templates.role_request_preset_id
```

Generated events retain:

```text
events.template_id
```

as source provenance.

The old template-specific reusable role-option architecture has been removed.

---

# Implemented One-Off Generation

Generation is implemented in:

```text
src/templates/event-template-generation-service.ts
```

Primary public boundary:

```text
generateEventFromTemplate(...)
```

The caller supplies an already-resolved absolute:

```text
startsAt: Date
```

The generation service does not interpret template `local_start_time`.

Local wall-clock/date resolution belongs to the future administrator or recurrence adapter.

---

# Atomic Generation Boundary

Authoritative generation occurs in one PostgreSQL transaction.

Conceptually:

```text
template FOR SHARE
        |
        v
validate guild/source ownership
        |
        v
resolve reusable source defaults
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
commit atomically
```

A failure during generation must not leave partial:

```text
events
event_ping_roles
event_organiser_assignments
event_reminders
preset applications
role-request state
scheduled_actions
```

Preset-application domain failures that occur after generation has begun abort the entire transaction before being converted into a normal generation result.

---

# Transaction-Aware Reusable Services

Generation composes:

```text
createStoredEventInTransaction(...)

createEventReminderInTransaction(...)

applyRoleRequestPresetToEventInTransaction(...)
```

Their existing public wrappers continue to own independent transactions for ordinary callers.

This keeps existing behaviour unchanged while allowing one larger authoritative generation transaction.

---

# Publication Semantics

Template publication source intent supports:

```text
manual
scheduled
immediate
```

Scheduled generation:

```text
creates ordinary unpublished event
creates publish_event durable action
```

Manual generation:

```text
creates ordinary unpublished event
does not create publish_event action
```

Immediate generation:

```text
creates ordinary unpublished event
does not publish to Discord inside transaction
returns requiresImmediatePublication = true
```

The calling adapter must perform immediate publication only after the generation transaction commits.

Discord publication remains an external side effect.

---

# Publication Destination Snapshot

A template may store a fixed:

```text
publication_channel_id
```

If non-null:

```text
use template destination
```

If null:

```text
resolve current guild default attendance/publication channel
```

The resolved destination is copied into the generated event.

Template reminders with:

```text
channel_id = null
```

inherit that resolved publication destination once at generation time.

Later guild-default or template changes do not move an existing generated event or reminder.

---

# Generated Event Independence

Generated events are ordinary event-owned state.

PostgreSQL integration coverage verifies that later changes to reusable source state do not rewrite the generated event.

Covered source changes include:

```text
template core fields
template ping roles
template organiser defaults
template reminders
referenced preset options
guild default attendance channel
```

The generated event retains its original snapshots.

---

# Template Ping Roles

Generation copies:

```text
event_template_ping_roles
```

into ordinary:

```text
event_ping_roles
```

including readable role-name snapshots.

Runtime publication uses the event-owned collection.

---

# Template Organiser Defaults

Supported reusable slots are:

```text
primary
backup
```

`cover` remains runtime recovery state.

When organisers are enabled:

```text
template defaults
    -> ordinary dormant event_organiser_assignments
```

When organisers are disabled at guild level:

```text
template generation still succeeds
no organiser assignments are created
```

Organiser feature disablement must never make templates generally unusable.

---

# Template Reminders

Generation copies reusable reminder definitions into:

```text
event_reminders
```

plus their normal durable:

```text
event_reminder:<id>
```

scheduled actions.

Supported template timing references currently match ordinary reminder behaviour:

```text
event_start
signup_close
```

Fixed reminder destinations remain fixed.

Null template reminder destinations resolve once through the generated event publication destination.

---

# Template Role Requests

Templates reuse the existing role-request preset architecture.

Generation validates and snapshots the configured preset through:

```text
applyRoleRequestPresetToEventInTransaction(...)
```

Generated state may include:

```text
event_role_options
event_role_option_qualification_roles
role_request_groups
role_request_group_options
role_request_group_notification_roles
event_role_request_preset_applications
scheduled_actions
```

Later preset edits do not rewrite generated event state.

No second template-specific reusable role-request graph should be introduced.

---

# Guild Ownership

Generation treats reusable IDs as untrusted until ownership is validated.

Current generation validates:

```text
template owner guild
event type owner guild + active state
audience owner guild + active state
role-request preset ownership/usability through preset application
```

A template from another guild is treated as unavailable to the caller.

---

# Template Lock Contract

Generation takes:

```text
event_templates parent
    -> FOR SHARE
```

Template mutation must take:

```text
event_templates parent
    -> FOR UPDATE
```

before mutating either parent metadata or child reusable source state.

This provides the source-snapshot contract:

```text
generation sees complete old graph
or
generation sees complete new graph
```

never a partially-edited mixture.

A deterministic PostgreSQL integration test verifies that a correctly parent-locked editor cannot interleave with an in-flight generation snapshot.

Do not replace this contract with unlocked child-table mutations.

---

# Reminder Prerequisite

Signup-close reminders remain valid for long-lived unpublished scheduled events.

Current protected behaviour includes:

```text
scheduled
+ unpublished
+ signups enabled
+ future signup close
    -> future signup-close reminder remains valid

closed
    -> signup-close reminder is invalid
```

This regression was completed before template generation began relying on reminder scheduling.

---

# Immediate Objective

The next implementation area is:

```text
template administration and lifecycle services
```

Do not begin with Discord command handlers.

Establish reusable service boundaries first.

The initial administration layer should cover:

```text
create template

inspect one template

list templates for a guild

active / inactive lifecycle

parent FOR UPDATE mutation contract
```

Template editing of reusable source fields and child collections should build on that parent-lock contract rather than writing child tables independently.

Administrator-facing Discord commands can then become thin adapters over those services.

---

# Template Lifecycle Direction

Templates already persist:

```text
active
```

and generated-event provenance uses:

```text
events.template_id
    ON DELETE RESTRICT
```

Therefore normal lifecycle should remain reversible:

```text
active
inactive
```

rather than destructive deletion.

Deactivation must:

```text
stop future generation
preserve the template
preserve provenance
preserve already-generated events
```

Inactive templates should remain inspectable and editable where intended.

---

# Template Editing Direction

Normal template editing should mean:

```text
edit reusable source
        |
        v
future generation uses new source

existing generated events remain unchanged
```

Mutation services must lock the template parent:

```text
FOR UPDATE
```

before changing parent or child source state.

For optional and collection state, keep mutation semantics explicit:

```text
omitted
    -> preserve

explicit clear
    -> remove nullable value

replacement collection
    -> replace complete intended collection
```

Do not introduce implicit propagation into existing generated events.

---

# Recurrence Remains Separate

Recurrence remains future work.

One-off generation is now established and should become administrator-usable before recurrence becomes authoritative.

Future recurrence should still produce ordinary events through the established generation architecture rather than creating a second runtime occurrence model.

Occurrence identity must remain separate from mutable:

```text
events.starts_at
```

---

# Development Workflow

For each implementation slice:

1. inspect the current pushed branch
2. change the service/domain layer first
3. add PostgreSQL integration coverage for persistence and locking
4. use regression-first development for defects
5. use deterministic PostgreSQL barriers for concurrency behaviour
6. run targeted tests
7. expand to affected subsystem tests
8. run production and test typechecks
9. run the full verification gate at meaningful commit/PR boundaries
10. update documentation only when behaviour or durable decisions change

Normal full gate:

```bash
npm run test:unit
npm run test:integration
npm run test:coverage
npm run typecheck
npm run typecheck:test
git diff --check
```

Manual Discord smoke testing becomes relevant once template administrator commands or other real Discord presentation behaviour are added.

---

# Documentation Expectations

As P1 advances:

- `ARCHITECTURE.md` describes implemented subsystem boundaries
- `DECISIONS.md` records durable choices and reasons
- `ROADMAP.md` contains future work only
- this document tracks the exact current checkpoint
- `ADMIN-GUIDE.md` changes when administrator-facing template behaviour exists
- `TESTING-GUIDE.md` should reflect established template testing contracts rather than temporary plans

The next code change should establish the template administration service boundary below the Discord command layer.
