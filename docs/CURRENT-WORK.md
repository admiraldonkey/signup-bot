# Current Development State

This document records the exact current implementation checkpoint.

Durable architecture belongs in [`ARCHITECTURE.md`](ARCHITECTURE.md).

Long-lived engineering and product decisions belong in [`DECISIONS.md`](DECISIONS.md).

Future work belongs in [`ROADMAP.md`](ROADMAP.md).

Administrator-facing behaviour belongs in [`ADMIN-GUIDE.md`](ADMIN-GUIDE.md).

---

# Current Repository Checkpoint

The P0 foundation and reliability phase is complete.

The first major P1 event-template milestone is also complete:

```text
reconciled template source model
        |
        v
administrator-managed reusable template
        |
        v
one-off occurrence generation
        |
        v
ordinary independent event
```

The implemented `/template` surface now supports:

```text
create
generate
edit
set-ping-roles
set-organisers
reminder-add
reminder-edit
reminder-remove
reminder-clear
list
show
set-active
```

Template generation has been manually smoke-tested through Discord as well as covered by unit and PostgreSQL-backed integration tests.

The next major development area is:

```text
P1
Recurring Event Generation
```

---

# Implemented Template Source Model

Reusable template source state is stored through:

```text
event_templates
    |
    +---- event_template_ping_roles
    |
    +---- event_template_organiser_defaults
    |
    +---- event_template_reminders
    |
    +---- optional role_request_preset_id
```

A template can define reusable defaults for:

```text
event type
optional audience / region
name
description
timezone
optional normal local start time
duration
signup behaviour
signup-close offset
detailed-deadline presentation
publication mode
publication offset where applicable
publication destination behaviour
ordered ping roles
optional primary / backup organisers
reminder definitions
zero or one reusable role-request preset
```

Templates use reversible active/inactive lifecycle state.

Inactive templates remain inspectable and editable but cannot generate new events.

Hard deletion is not required for normal template administration.

---

# Implemented Template Administration

Template administration is implemented through reusable service boundaries in:

```text
src/templates/event-template-admin-service.ts
```

and Discord adapters in:

```text
src/commands/template.ts
```

Core administration supports:

```text
create
list
show
activate / deactivate
edit parent configuration
replace ping-role collection
replace organiser defaults
add / edit / remove / clear reminders
```

Mutation semantics are explicit.

For nullable fields:

```text
omitted
    -> preserve existing value

explicit clear
    -> remove stored value
```

For collection-style state:

```text
replacement collection
    -> complete intended set
```

Existing generated events are not rewritten when their source template changes.

---

# Implemented One-Off Generation

One-off generation is implemented in:

```text
src/templates/event-template-generation-service.ts
```

Primary service boundary:

```text
generateEventFromTemplate(...)
```

Administrator-facing generation is exposed through:

```text
/template generate
```

The command accepts:

```text
template-id
date
optional time override
```

If `time` is omitted, the template's configured local start time is used.

If the template has no default local start time, an occurrence-specific `time` must be supplied.

The command resolves the requested local date/time in the template timezone before entering the persistence boundary.

The generation service continues to accept only an absolute:

```text
startsAt: Date
```

It does not itself interpret local wall-clock input.

---

# Shared Date and Time Parsing

One-off event creation and template generation now share:

```text
src/time/event-date-time.ts
```

The parser uses Luxon with named IANA timezones.

It rejects:

```text
malformed dates
impossible local times
ambiguous daylight-saving overlap times
```

For example, a local time which occurs twice during an autumn clock change is rejected rather than silently choosing one offset.

This shared parser is also relevant groundwork for recurrence.

Recurring generation must preserve intended local wall-clock behaviour across daylight-saving transitions.

---

# Atomic Generation Boundary

Template generation creates one ordinary persistent event and its snapshotted runtime state inside one authoritative PostgreSQL transaction.

The flow is:

```text
event_templates parent FOR SHARE
        |
        v
validate source and occurrence
        |
        v
resolve guild defaults
        |
        v
createStoredEventInTransaction(...)
        |
        +---- event core
        +---- ping roles
        +---- optional organiser assignments
        +---- core scheduled actions
        |
        v
createEventReminderInTransaction(...) x N
        |
        v
applyRoleRequestPresetToEventInTransaction(...)
        |
        v
commit
```

If role-request preset application fails after generation has begun, the surrounding generation transaction aborts before the failure is returned as a normal domain result.

Partial generated state must not commit.

---

# Generated Event Independence

A generated occurrence becomes an ordinary event-owned snapshot.

After generation:

```text
template
    -> reusable source / provenance

event
    -> authoritative runtime state
```

Later changes to:

```text
template core fields
template ping roles
template organiser defaults
template reminders
referenced role-request preset
guild default publication destination
```

do not rewrite an event which has already been generated.

Individual generated events can therefore be edited or cancelled without changing their source template.

Generated events retain:

```text
events.template_id
```

as provenance only.

It is not a live runtime configuration relationship.

---

# Template Lock Contract

Generation takes:

```text
event_templates parent FOR SHARE
```

Template mutation takes:

```text
event_templates parent FOR UPDATE
```

Child-table mutation must participate through the parent lock.

This ensures generation sees either:

```text
complete old source graph
```

or:

```text
complete new source graph
```

rather than a partial mixture.

Deterministic PostgreSQL-backed tests cover important generation/mutation races.

---

# Occurrence Preparation Revision Guard

`/template generate` must inspect template-local timing metadata before calling the generator.

That creates a narrow interval in which another administrator could edit the template.

The command therefore passes the inspected:

```text
template.updatedAt
```

as:

```text
expectedTemplateUpdatedAt
```

Generation compares that revision after acquiring its parent source lock.

If the template changed between inspection and generation:

```text
template_changed
```

is returned and the administrator is asked to retry.

This prevents an occurrence start instant resolved using an old timezone or local-time configuration from being combined with a newer source snapshot.

Template child mutations update the parent revision so the check represents the complete source aggregate.

---

# Publication Semantics

Templates support:

```text
manual
scheduled
immediate
```

## Manual

Generation creates an ordinary unpublished event.

No automatic publication action is created.

The administrator can later run:

```text
/event publish
```

## Scheduled

Generation creates an ordinary unpublished event and a durable:

```text
publish_event
```

scheduled action.

The event can still be manually published early.

## Immediate

Generation commits the complete authoritative event first.

Only after commit does the Discord adapter call the normal:

```text
publishStoredEvent(...)
```

path.

Discord publication therefore remains outside the generation transaction.

If immediate Discord publication fails, the generated event remains stored as an unpublished event and can be retried through:

```text
/event publish
```

The event is not deleted merely because the post-commit Discord side effect failed.

---

# Publication Destination Snapshot

Template publication destination behaves as follows:

```text
fixed template publication channel
    -> snapshot that channel

no fixed template publication channel
    -> resolve current guild default during generation
    -> snapshot resolved channel
```

The generated event owns the resulting publication destination.

Later guild or template changes do not silently relocate it.

Template reminder definitions with no fixed channel similarly resolve to the generated event's publication destination when the occurrence is generated.

---

# Template Organiser Defaults

Templates support reusable:

```text
primary
backup
```

organiser defaults.

A backup requires a primary.

The same Discord member cannot occupy both slots.

Where an Event Organiser role is configured, the Discord administrator adapter validates selected members against it.

If the organiser subsystem is disabled when generation occurs:

```text
generation still succeeds
organiser assignments are omitted
```

The reusable defaults remain stored for future occurrences if the feature is re-enabled.

Generated organiser assignments use the normal dormant unpublished-event model and activate through ordinary publication behaviour.

---

# Template Reminders

Template reminder definitions support timing relative to:

```text
event start
signup close
```

Definitions can use:

```text
fixed channel
```

or:

```text
generated event publication destination
```

as their destination.

Individual reminder source rows can be added, edited, removed, or cleared through `/template`.

Generation snapshots them into ordinary:

```text
event_reminders
```

plus durable scheduler actions.

Later template reminder changes do not rewrite existing generated reminders.

---

# Template Role Requests

P1 supports:

```text
zero or one reusable role-request preset per template
```

Generation uses the established preset-application transaction boundary.

It does not create a second template-specific role-request runtime model.

After generation, role options, groups, qualification state, mappings and scheduled actions are ordinary event-owned state.

Later source-preset edits do not rewrite existing generated occurrences.

---

# Reminder Regression Fixed During Template Smoke Testing

Manual verification of template-generated event state exposed an existing event-reminder command bug.

Reminder commands previously loaded an event through an:

```text
INNER JOIN event_messages
```

attendance-message linkage.

A scheduled unpublished event has no attendance message yet, so a real event could incorrectly appear as:

```text
Event #... was not found in this server.
```

The lookup now preserves the authoritative event row through a left join and falls back to the event's snapshotted publication destination where no attendance-message linkage exists yet.

A command-level PostgreSQL-backed regression test protects scheduled unpublished reminder creation.

This reinforces the existing invariant:

```text
unpublished event != nonexistent event
```

---

# Current Verification Baseline

Relevant template coverage includes:

```text
tests/integration/templates/event-template-schema.test.ts

tests/integration/templates/event-template-admin-service.test.ts

tests/integration/templates/event-template-generation-service.test.ts

tests/unit/commands/template.test.ts

tests/unit/time/event-date-time.test.ts
```

The reminder regression is protected by:

```text
tests/integration/commands/event-reminders.test.ts
```

The standard full gate remains:

```bash
npm run test:unit
npm run test:integration
npm run test:coverage
npm run typecheck
npm run typecheck:test
git diff --check
```

Manual Discord smoke testing remains appropriate when slash-command shape, selectors, permissions, publication or end-to-end presentation changes.

---

# Immediate Objective

The next major implementation area is:

```text
P1
Recurring Event Generation
```

Do not create a separate runtime event model for recurrence.

Recurring generation should reuse:

```text
template source configuration
        |
        v
generateEventFromTemplate(...)
        |
        v
ordinary persistent event
```

The first recurrence design work should reconcile:

```text
standards-based recurrence representation

named timezone / local wall-clock semantics

rolling generation horizon

immutable occurrence identity

duplicate prevention

series lifecycle

template lifecycle interaction

individual occurrence independence

restart-safe generation trigger
```

---

# Recurrence Constraints Already Established

Recurrence remains separate from the one-off template source aggregate.

A recurring occurrence must have immutable schedule identity separate from:

```text
events.startsAt
```

Moving an individual generated event must not make the original recurrence slot appear missing and cause a duplicate occurrence.

Repeated or concurrent generation for the same horizon must be idempotent.

Already-generated events remain independent snapshots.

Template or recurrence-rule changes should normally affect only occurrences not yet generated.

Disabling future recurrence should not implicitly cancel already-generated events.

Recurring local times must preserve intended local wall-clock meaning across daylight-saving changes.

Generation must remain bounded rather than materialising an unlimited future series.

---

# Deferred Administrator UX

The current event-level administration surface exposes detailed state through several specialised commands.

Template-generation smoke testing highlighted that inspecting a generated event may require separate commands for:

```text
event summary
reminders
role options
role-request groups
organiser state
```

A future:

```text
/event show
```

inspection command would provide a useful read-only summary of the event-owned snapshot.

This is an administrator UX improvement rather than a blocker for recurrence and belongs in the roadmap.

---

# Development Workflow

Continue using regression-first development.

For recurrence:

```text
schema / identity decision
        |
        v
migration + integration regression
        |
        v
service boundary
        |
        v
idempotency / concurrency coverage
        |
        v
scheduler integration
        |
        v
Discord administration
```

PostgreSQL remains authoritative.

Do not depend on process-local timers for recurrence generation.

Do not use timing sleeps as concurrency correctness tests where deterministic database locks or barriers can prove the ordering.

---

# Documentation Expectations

As P1 recurrence work begins:

- `ARCHITECTURE.md` describes implemented subsystem boundaries
- `DECISIONS.md` records durable choices and reasons
- `ROADMAP.md` contains unfinished future work
- this document records the exact current checkpoint
- `ADMIN-GUIDE.md` describes the implemented `/template` workflow
- `TESTING-GUIDE.md` records established template tests and recurrence expectations

The immediate next code work should begin from the recurrence design and persistence boundary rather than adding recurrence behaviour directly to Discord handlers.
