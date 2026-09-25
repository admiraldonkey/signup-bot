# Current Development State

This document records the exact current implementation checkpoint.

Durable architecture belongs in [`ARCHITECTURE.md`](ARCHITECTURE.md).

Long-lived engineering and product decisions belong in [`DECISIONS.md`](DECISIONS.md).

Future work belongs in [`ROADMAP.md`](ROADMAP.md).

Administrator-facing behaviour belongs in [`ADMIN-GUIDE.md`](ADMIN-GUIDE.md).

---

# Current Repository Checkpoint

The P0 foundation and focused reliability phase are complete.

The main P1 reusable-template and recurring-generation milestone is also implemented end-to-end.

The current shape is:

```text
reusable template source
        |
        +---- optional recurrence series
        |
        v
bounded occurrence generation
        |
        v
ordinary independent event snapshot
        |
        v
normal event lifecycle
```

The implementation now includes:

```text
template source administration
one-off generation
recurrence administration
immutable recurrence occurrence identity
bounded automatic materialisation
durable recurrence sweep ownership
generated-event provenance
administrator recurrence inspection
normal publication / reminder / organiser / role-request behaviour
```

The complete recurrence workflow has been manually smoke-tested through the real Discord development environment.

The branch has also been verified through the automated unit, PostgreSQL integration, coverage, TypeScript, build, and runtime-module boundaries.

---

# Implemented `/template` Surface

The administrator-facing `/template` command now supports:

```text
create
list
show
edit
set-active

set-ping-roles
set-organisers

reminder-add
reminder-edit
reminder-remove
reminder-clear

generate
show-generated

recurrence-create
recurrence-list
recurrence-show
recurrence-edit
recurrence-set-active
```

The Discord command layer remains an adapter over reusable template and recurrence services.

Authoritative persistence and concurrency behaviour live below the command handler.

---

# Template Source Model

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

A template may define reusable defaults for:

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

Generated events are not rewritten when their source template later changes.

---

# One-Off Generation

One-off generation is implemented through:

```text
src/templates/event-template-generation-service.ts
```

using:

```text
generateEventFromTemplate(...)
```

The administrator-facing adapter is:

```text
/template generate
```

The command resolves an occurrence-local date/time using the template timezone before entering the authoritative persistence boundary.

Generation snapshots reusable source configuration into one ordinary persistent event transactionally.

Generated state may include:

```text
core event fields
publication state
ping-role snapshots
optional organiser assignments
event reminders
role-request preset snapshots
durable scheduled actions
template provenance
```

Immediate publication, where requested for one-off generation, occurs only after the database transaction commits.

---

# Template Revision Provenance

Generated events retain:

```text
events.template_id
events.template_source_updated_at
```

`template_id` identifies the reusable source template.

`template_source_updated_at` records the exact locked template revision used during generation.

This lets administrator inspection distinguish:

```text
current template revision
older template revision
unknown historical provenance
```

A null historical source revision is treated as unknown.

It is not inferred from event creation time.

---

# Generated Event Independence

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
recurrence rule
recurrence lifecycle
```

do not rewrite an event which already exists.

Individual generated events may therefore be edited, published, moved, or cancelled independently.

---

# Template Source Lock Contract

Generation takes:

```text
event_templates parent FOR SHARE
```

Template mutation takes:

```text
event_templates parent FOR UPDATE
```

Child-source mutation participates through the same parent lock.

The intended result is that generation observes either:

```text
complete old reusable source graph
```

or:

```text
complete new reusable source graph
```

never a partial edit.

Administrator-driven one-off occurrence preparation also uses an optimistic source-revision check.

If the template changes between local-time inspection and locked generation:

```text
template_changed
```

is returned and no event is generated from a mixed source revision.

---

# Recurrence Source Model

A template may own at most one recurrence series in P1.

The recurrence source is stored through:

```text
event_template_recurrences
```

Important source concepts include:

```text
template_id
recurrence_rule
start_date
active
created_by_user_id
```

Recurrence lifecycle is separate from template lifecycle.

A recurrence may therefore be inactive while its template remains active.

Disabling recurrence stops future automatic materialisation.

It does not cancel or alter events already generated from that series.

---

# Recurrence Representation

P1 uses a constrained RFC 5545 recurrence representation implemented through:

```text
src/templates/event-recurrence-rule.ts
```

Supported recurrence frequencies are:

```text
DAILY
WEEKLY
MONTHLY
YEARLY
```

The reusable domain parser also supports the constrained components currently accepted by the recurrence service:

```text
FREQ
INTERVAL
BYDAY
BYMONTHDAY
BYMONTH
WKST
```

Time-of-day and timezone do not belong in the recurrence rule.

The template continues to own:

```text
timezone
local_start_time
```

The recurrence rule supplies local calendar dates.

This separation preserves intended local wall-clock event time across daylight-saving changes.

---

# Administrator Recurrence Model

The normal Discord recurrence creation/editing surface intentionally exposes a simpler model:

```text
frequency
interval
start-date
```

The command currently offers:

```text
Daily
Weekly
Monthly
Yearly
```

Editing only the start date preserves the stored recurrence pattern.

Changing interval requires frequency to be supplied as well so an administrator does not accidentally discard advanced stored recurrence components.

The raw canonical rule remains visible through `/template recurrence-show`.

---

# Immutable Recurrence Occurrence Identity

Generated recurrence provenance is stored in:

```text
event_recurrence_occurrences
```

The immutable logical key is:

```text
recurrence_id
+
occurrence_date
```

The occurrence date is the original recurrence-local calendar slot.

It is deliberately separate from mutable:

```text
events.starts_at
```

This prevents the classic duplicate failure:

```text
Monday slot generated
        |
        v
administrator moves event to Tuesday
        |
        v
next recurrence sweep checks Monday
        |
        v
original Monday slot still exists
        |
        v
no duplicate
```

The generated event remains linked to its original recurrence slot even after ordinary event editing.

---

# Recurrence Generation Boundary

Recurring generation is implemented through:

```text
src/templates/event-template-recurrence-generation-service.ts
```

The per-slot service:

```text
generateRecurringOccurrence(...)
```

locks in the established order:

```text
event template
    -> recurrence
```

The service revalidates that the requested occurrence still belongs to the current recurrence rule before generating it.

It then reuses the existing template-generation transaction boundary.

Occurrence provenance and event creation are committed atomically.

Repeated or concurrent generation of the same logical slot therefore converges on one event.

---

# Rolling Recurrence Horizon

Automatic recurrence uses:

```text
src/templates/event-template-recurrence-horizon-service.ts
```

The implemented horizon is exactly:

```text
10 template-local calendar days
```

meaning:

```text
today
through
today + 9 days
```

The ten-day horizon supports the currently allowed seven-day publication/reminder/role-request lead times with three days of operational headroom.

The horizon captures one logical `now` for a sweep.

Each recurrence slot is still generated in its own transaction.

Expected stale or no-longer-useful slots are classified explicitly rather than aborting unrelated future slots.

---

# Recurring Publication Semantics

Automatic recurrence supports templates using:

```text
Manual
Scheduled
```

publication.

For Manual publication:

```text
occurrence generated
        |
        v
ordinary unpublished event
```

For Scheduled publication:

```text
occurrence generated
        |
        v
ordinary event
        |
        v
durable publish_event action
```

Automatic recurrence deliberately rejects:

```text
Immediate
```

publication because recurring occurrences are materialised in advance.

The interaction rules are:

```text
create active recurrence on Immediate template
    -> rejected

activate recurrence on Immediate template
    -> rejected

change template to Immediate while recurrence active
    -> rejected

inactive recurrence + Immediate template
    -> allowed

reactivate after returning template to Manual/Scheduled
    -> allowed
```

One-off `/template generate` continues to support Immediate publication.

---

# Durable Recurrence Sweeping

Automatic recurrence does not use event-owned:

```text
scheduled_actions
```

for pre-event recurrence work.

A recurrence sweep exists before the next event exists, while `scheduled_actions` require an event ID.

Durable sweep state therefore belongs to:

```text
event_template_recurrences
```

through fields including:

```text
next_sweep_at
sweep_claim_token
last_sweep_started_at
last_sweep_completed_at
last_sweep_outcome
last_sweep_diagnostic
```

The runtime scheduler is implemented in:

```text
src/scheduler/recurrence-scheduler.ts
```

and the durable worker in:

```text
src/templates/event-template-recurrence-sweep-service.ts
```

---

# Recurrence Claiming and Recovery

Runtime polling is discovery only.

Ownership is established by a conditional PostgreSQL update.

Conceptually:

```text
due recurrence discovered
        |
        v
conditional UPDATE
        |
        +---- loses -> no work
        |
        +---- wins
                |
                v
          unique claim token
                |
                v
          process horizon
```

The currently implemented policy uses:

```text
15-second process-local discovery polling

5-minute durable recurrence sweep cadence

15-minute stale-claim recovery threshold

maximum 10 recurrence sweeps per run
```

These values are operational policy rather than public recurrence identity.

A stale claim may be recovered by another worker.

Per-occurrence idempotency still prevents duplicate event creation during stale recovery.

Sweep completion is fenced by the exact claim token.

A stale worker therefore cannot overwrite newer recurrence operational state.

---

# Recurrence Operational Status

The latest sweep result is persisted as one of:

```text
success
partial_failure
failure
skipped
```

with an optional diagnostic.

`/template recurrence-show` exposes:

```text
recurrence lifecycle
template lifecycle
recurrence source
next sweep
latest sweep outcome
latest diagnostic
```

`/template recurrence-list` also identifies a last sweep which failed or partially failed.

One bad recurrence does not stop unrelated due recurrence series from being processed.

---

# Recurrence Source Mutation

Editing recurrence source state:

```text
updates the source
makes the recurrence immediately sweepable
clears stale sweep result state
supersedes an older in-flight claim
```

Reactivation similarly makes the recurrence immediately eligible.

Deactivation supersedes current claim ownership and prevents later automatic sweeps while inactive.

Already-generated events remain unchanged in every case.

---

# Reminder Publication Guard

Recurring and scheduled template events may exist for a substantial period before public publication.

Reminder execution therefore explicitly protects unpublished events.

A reminder which becomes due while its event is still unpublished must not:

```text
send publicly
consume retry attempts
be incorrectly marked missed
be silently completed because signup state is not yet public
```

The scheduler parks still-valid reminder work until its reference boundary.

Successful event publication wakes already-due valid reminders transactionally.

This behaviour is covered by integration regressions in the event scheduler and publication suites.

---

# Runtime `rrule` Compatibility Regression

Manual startup testing exposed a runtime module-interop issue which the normal TypeScript and Vitest paths did not detect.

`rrule` 2.8.1 exposes a CommonJS Node entry point whose `RRule` export is not safely available through native Node synthetic named-export detection.

The recurrence rule module therefore loads the dependency explicitly through Node's CommonJS compatibility boundary rather than relying on:

```text
import { RRule } from "rrule"
```

A dedicated regression:

```text
tests/unit/templates/event-recurrence-runtime.test.ts
```

launches the recurrence module through the real Node + `tsx` ESM runtime.

This protects the exact startup path which originally failed.

---

# Verification Baseline

Relevant recurrence and template coverage includes:

```text
tests/integration/templates/event-template-schema.test.ts
tests/integration/templates/event-recurrence-schema.test.ts

tests/integration/templates/event-template-admin-service.test.ts
tests/integration/templates/event-template-generation-service.test.ts
tests/integration/templates/event-template-generated-events-service.test.ts

tests/integration/templates/event-template-recurrence-service.test.ts
tests/integration/templates/event-template-recurrence-generation-service.test.ts
tests/integration/templates/event-template-recurrence-horizon-service.test.ts
tests/integration/templates/event-template-recurrence-sweep-service.test.ts

tests/integration/events/event-publication.test.ts

tests/integration/scheduler/event-scheduler.test.ts
tests/integration/scheduler/scheduler-retry.test.ts

tests/unit/commands/template.test.ts
tests/unit/templates/event-recurrence-rule.test.ts
tests/unit/templates/event-recurrence-runtime.test.ts
tests/unit/scheduler/recurrence-scheduler.test.ts
tests/unit/time/event-date-time.test.ts
```

The normal full pre-PR gate is:

```bash
npm run test:unit
npm run test:integration
npm run test:coverage
npm run typecheck
npm run typecheck:test
npm run build
git diff --check
```

The production build is now included explicitly because TypeScript type compatibility alone does not prove third-party module interoperability under the actual Node runtime.

---

# Manual Discord Verification

The P1 recurrence workflow has been manually tested through the real development Discord environment.

Verified behaviour includes:

```text
bot startup and slash-command registration
recurrence creation
recurrence inspection
automatic horizon materialisation
Manual recurring publication
expected immutable occurrence dates
repeat-sweep idempotency
recurrence deactivation
source editing without historical rewrite
Immediate-publication activation rejection
reactivation after returning to Manual publication
new-source future materialisation
template-source revision inspection
template lifecycle interaction
clean scheduler shutdown
```

The manual test also confirmed that already-generated events remain independent when the recurrence source changes.

---

# Current Immediate Objective

The implementation work for this P1 recurrence branch is complete.

The remaining branch-close work is:

```text
reconcile durable documentation
        |
        v
run final full verification gate
        |
        v
review final branch diff
        |
        v
open / prepare PR
```

No further recurrence architecture should be added merely to make the branch larger.

Any defect discovered during final verification should become a focused regression and narrow fix.

---

# Next Product Work

After this branch is merged, unfinished product work remains in [`ROADMAP.md`](ROADMAP.md).

The next substantial P1 candidate is:

```text
Confirmed Organiser Unavailability
```

where an organiser who has already confirmed can report that they can no longer run an event and safely trigger the established backup/general-cover progression.

Remaining server-level feature controls are also still P1 work.

A non-mutating template preview remains an optional administrator UX improvement.

Exact implementation order may still change if operational issues or dependencies justify doing so.

---

# Deferred Administrator UX

A richer read-only:

```text
/event show
```

inspection command remains a P2 roadmap item.

It should provide a useful event-owned snapshot without changing event state.

It is not a recurrence blocker and must not be duplicated elsewhere in the roadmap.

---

# Development Workflow

Continue using regression-first development.

For meaningful domain work:

```text
reproduce / define behaviour
        |
        v
add focused regression
        |
        v
confirm RED where applicable
        |
        v
implement narrow change
        |
        v
run targeted tests
        |
        v
run affected subsystem tests
        |
        v
run full gate before PR readiness
```

PostgreSQL remains authoritative.

Discord messages remain projections.

Important future work must remain restart-safe.

Concurrency behaviour should be proven using deterministic locks, barriers, conditional writes, or other explicit ownership boundaries rather than timing sleeps.

Completed work should move out of `ROADMAP.md` rather than accumulating there as a historical changelog.

---

# Documentation Expectations

The documentation roles at this checkpoint are:

```text
README.md
    -> public project overview

ARCHITECTURE.md
    -> implemented architecture and invariants

DECISIONS.md
    -> durable rationale and non-obvious decisions

ROADMAP.md
    -> unfinished future work only

CURRENT-WORK.md
    -> exact current repository checkpoint

ADMIN-GUIDE.md
    -> implemented Discord administrator behaviour

TESTING-GUIDE.md
    -> established development and verification workflow
```

Keep these responsibilities separate so future work can identify what is implemented without reconstructing it from old roadmap entries.
