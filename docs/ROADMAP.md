# Development Roadmap

This document tracks **future development** for the Holdfast Event Bot.

It is intentionally not a changelog and should not grow by retaining detailed descriptions of completed work.

For current implemented behaviour, use:

- [`../README.md`](../README.md)
- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`ADMIN-GUIDE.md`](./ADMIN-GUIDE.md)
- [`TESTING-GUIDE.md`](./TESTING-GUIDE.md)

For durable architectural rationale and non-obvious invariants, use:

- [`DECISIONS.md`](./DECISIONS.md)

For the exact current development checkpoint and next implementation task, use:

- [`CURRENT-WORK.md`](./CURRENT-WORK.md)

---

## Priority levels

| Priority | Meaning                                                           |
| -------- | ----------------------------------------------------------------- |
| **P1**   | Current or near-term major development                            |
| **P2**   | Useful medium-term product, administration, or architectural work |
| **P3**   | Later, optional, integration, analytics, or quality-of-life work  |

Priority is not a promise of exact implementation order.

Real operational problems, regressions, or newly discovered architectural dependencies may justify changing the sequence.

---

# Current direction

The foundational event-management platform is established.

Implemented areas include persistent event lifecycle, publication, attendance, organiser workflows, reminders, event-level role requests, reusable role-request presets, durable scheduling, recovery behaviour, audit logging, and PostgreSQL-backed reliability testing.

The next major development phase is:

```text
P1
Event Templates
```

followed by:

```text
P1
Recurring Event Generation
```

Reliability remains an ongoing engineering requirement rather than a separate broad rewrite phase.

New work should preserve existing concurrency, snapshot, scheduler, recovery, and authoritative-state guarantees as it is introduced.

---

# P1 — Event Templates

## Objective

Make the implemented reusable template source model and one-off generation service usable and maintainable through administrator-facing workflows.

The underlying generation architecture is established:

```text
template
    |
    | atomic generation
    v
ordinary independent event
```

Remaining P1 template work is primarily administration and editing.

---

## P1.2 — Template administration and lifecycle

Build reusable service boundaries for:

```text
create
list
show
set-active
```

before adding Discord command adapters.

Requirements:

- explicit guild ownership
- active/inactive lifecycle
- inactive templates remain inspectable
- inactive templates remain editable where intended
- inactive templates cannot generate
- unchanged lifecycle mutation is idempotent
- deactivation does not modify generated events
- provenance remains intact
- hard deletion is not required for the first implementation

Template mutation services must take:

```text
event_templates parent FOR UPDATE
```

before changing parent or child reusable source state.

This must serialise correctly against generation's:

```text
event_templates parent FOR SHARE
```

lock.

Use deterministic PostgreSQL integration tests for the mutation/generation race.

---

## P1.11 — Template editing

Implement reusable editing services for template source state.

Normal editing means:

```text
edit template
    |
    v
future generated events use new configuration

existing generated events remain unchanged
```

Editing should cover the source configuration required for practical administration, including:

```text
core event defaults
publication configuration
ping-role collection
organiser defaults
reminder definitions
optional role-request preset
```

Mutation APIs should distinguish deliberately between:

```text
omitted
    -> preserve

explicit clear
    -> remove nullable state

replacement collection
    -> replace complete intended set
```

Child collection mutation must use the template parent lock rather than independently locking only child rows.

Do not introduce implicit propagation to existing generated events.

---

## P1.12 — Template preview

Consider an administrator preview before activation or generation.

Useful preview information may include:

- event type
- audience
- normal start time
- timezone
- duration
- signup settings
- publication timing
- organiser defaults
- role-request configuration
- reminder schedule
- ping audience

This is useful but should not block the minimum viable administrator workflow if implementation does not naturally require it.

---

## P1.13 — Administrator-facing one-off generation

Expose the implemented one-off generation service through an administrator-facing workflow.

The adapter must:

- resolve the requested occurrence date/time into an absolute `startsAt`
- preserve the template timezone/local-time semantics
- authorise the administrator
- validate Discord-specific role/channel inputs where relevant
- call the reusable generation service
- handle service results clearly
- audit successful generation
- perform immediate publication only after the generation transaction commits
- avoid reproducing generation persistence logic in the command handler

Command-adapter tests should verify Discord parsing/result handling.

PostgreSQL integration tests remain authoritative for generation correctness.

Update `ADMIN-GUIDE.md` when this administrator-facing workflow is introduced.

---

# P1 — Recurring Event Generation

## Objective

Generate future ordinary event occurrences from reusable templates.

Do not model a recurring series as one event row whose date repeatedly changes.

The intended shape is:

```text
template / series
        |
        v
recurrence calculation
        |
        v
ordinary persistent event occurrences
```

One-off template generation should be stable before recurrence becomes authoritative.

---

## P1.14 — Standards-based recurrence representation

Prefer a recognised recurrence model such as RFC 5545 RRULE where practical.

Example:

```text
FREQ=WEEKLY
BYDAY=MO
```

Evaluate a mature recurrence library rather than implementing calendar recurrence arithmetic manually.

Required concerns include:

- weekly schedules
- named timezone context
- daylight-saving changes
- exclusions
- start/end bounds
- occurrence counting

---

## P1.15 — Rolling generation horizon

Do not materialise an unlimited future series.

Generate occurrences within a bounded rolling horizon.

A working design candidate discussed so far is approximately:

```text
21 days
```

This is not yet a fixed product requirement.

The final horizon may be configurable or changed after operational experience.

Benefits of bounded generation include:

- manageable database size
- bounded scheduled-action volume
- easier template edits
- easier series changes
- fewer unnecessary hypothetical events
- natural future-only application of template changes

---

## P1.16 — Generate before public announcement

A recurring occurrence should normally exist before publication time.

Preferred sequence:

```text
occurrence enters generation horizon
        |
        v
persistent event created
        |
        +---- organisers snapshotted
        |
        +---- role-request configuration snapshotted
        |
        +---- reminders created
        |
        +---- scheduled actions created
        |
        +---- administrator can inspect/edit
        |
        v
normal publication time arrives
```

Do not wait until publication time to create the event for the first time.

This gives administrators time to inspect or customise a particular occurrence before Discord presentation becomes public.

---

## P1.17 — Immutable occurrence identity

A recurring occurrence needs an immutable schedule identity separate from mutable event timing.

Do not use:

```text
event.startsAt
```

as the sole occurrence identity.

Example failure:

```text
Monday occurrence generated
        |
        v
administrator moves it to Tuesday
        |
        v
generator runs again
        |
        v
original Monday slot appears absent
        |
        v
duplicate generated
```

A moved event must remain recognisable as the occurrence originally generated for that schedule slot.

---

## P1.18 — Idempotent occurrence generation

Running generation repeatedly for the same horizon must not create duplicates.

Use a durable uniqueness rule based on the series/template identity and immutable occurrence identity.

Conceptually:

```text
series
+
occurrence key
=
one generated occurrence
```

Cover concurrent generators with deterministic PostgreSQL-backed tests.

---

## P1.19 — Individual occurrence edits remain local

Editing one generated event must not rewrite:

- the template
- recurrence rule
- neighbouring occurrences
- already-generated future occurrences unless an explicit bulk action exists

A moved occurrence remains associated with its original series slot through immutable occurrence identity.

---

## P1.20 — Individual occurrence cancellation

Administrators must be able to cancel one generated event without cancelling the recurring series.

A cancelled event remains the occurrence record for that slot.

The generator must not interpret cancellation as:

```text
occurrence missing
    -> regenerate it
```

---

## P1.21 — Series/template disable behaviour

Disabling recurrence should normally mean:

```text
stop future generation
    |
    v
already-generated events remain intact
```

Do not automatically cancel existing generated events unless an administrator explicitly requests that separate action.

---

## P1.22 — Recurrence schedule changes

When recurrence configuration changes:

- already-generated events should normally remain unchanged
- not-yet-generated occurrence calculation should use the new rule

If future regeneration or reconciliation becomes useful, make it an explicit scoped operation.

---

## P1.23 — Daylight-saving behaviour

Recurring local event times must preserve intended local wall-clock meaning.

Example:

```text
Every Monday at 20:00 Europe/London
```

should remain a 20:00 London event across daylight-saving transitions.

Do not implement recurrence by repeatedly adding fixed UTC durations where that changes the intended local time.

---

## P1.24 — Recurrence scheduler architecture

Decide how rolling occurrence generation is triggered.

Possible approaches include:

- periodic durable scheduler work
- startup plus periodic sweep
- dedicated recurrence-generation scheduled actions

The selected design must be:

- restart-safe
- idempotent
- bounded
- concurrency-safe
- observable
- deterministic in tests
- independent from arbitrary wall-clock sleeps

---

# P1 — Confirmed Organiser Unavailability

## Objective

Allow an organiser who has already confirmed responsibility to report that they can no longer run the event.

This remains an important unfinished organiser workflow.

Primary flow:

```text
Confirmed Primary
        |
        v
Unavailable
        |
        +---- viable Backup
        |       |
        |       v
        |   activate Backup
        |
        +---- no viable Backup
                |
                v
            General Cover
```

Confirmed backup or cover flow:

```text
Confirmed Backup/Cover
        |
        v
Unavailable
        |
        v
General Cover
```

Requirements:

- preserve assignment history
- remove current ownership safely
- activate the next viable path
- cancel obsolete scheduled actions
- respect event cancellation/completion
- respect organiser feature disable
- reconcile warning/cover presentation
- audit the transition
- handle races with timeout and cover operations

Reuse the existing organiser assignment, escalation, cover, and safety model.

Do not introduce a parallel emergency-organiser subsystem.

---

# P1 — Remaining Server-Level Feature Controls

## P1.25 — Role-request parent feature switch

Consider a guild-level switch for the role-request subsystem.

A parent switch could express:

```text
role requests disabled for this server
```

without destroying existing event-type or preset configuration.

Before implementation define:

- whether existing open groups remain usable
- what happens to pending opening/closing actions
- whether preset application is blocked
- whether manual event-level configuration is blocked
- what happens after re-enable
- the locking relationship with in-flight role-request operations

Do not implement this as an unlocked boolean check if disable must serialise against active operations.

---

## P1.26 — Other feature switches

Possible future controls include:

- actual attendance reporting
- reminders
- announcements
- reusable role-request presets
- automatic organiser escalation if a real operational need emerges

Only add a feature switch when it solves a real server-level configuration requirement.

Avoid creating a settings matrix larger than the features it controls.

---

# P2 — Event-Level Role-Request Administration

Reusable preset administration is established.

Event-level role configuration may later gain richer mutation support.

## P2.1 — Event role-option editing

Potential operations:

- edit display name
- edit description
- change request restriction
- replace qualification roles
- change capacity
- deactivate/reactivate an option

Historical requests may already reference the option.

Prefer non-destructive lifecycle changes over deleting operational or historical state.

---

## P2.2 — Existing event request-group editing

Potential operations:

- edit group name
- edit description
- change displayed options
- change signup requirement
- move a future opening
- change closing rule
- replace notification roles
- change destination before publication
- deactivate a planned group
- reopen where domain rules permit it

Editing an already-published group is materially different from editing a reusable preset because it may already have:

```text
stored schedule
historical opening
Discord presentation
existing requests
```

Treat the problem accordingly.

---

## P2.3 — Explicit message move/repost administration

Automatic recovery already handles important deleted-message cases where the authoritative destination remains known.

Administrators may later benefit from explicit operations to:

- move an event presentation intentionally
- move a role-request group intentionally
- rebuild after a destination channel was replaced
- force presentation recreation after repairing permissions

Such operations must preserve authoritative database linkage and concurrency guarantees.

---

# P2 — Actual Attendance Participation Context

## Objective

Extend actual attendance beyond simple present/not-present state.

Potential event-specific context includes:

```text
participant
supervisor
organiser
server_admin
other
```

Reporting could then distinguish actual presence from the capacity in which somebody attended.

This should improve signup comparison semantics.

For example:

```text
participant + no signup
    -> likely walk-in

supervisor + no signup
    -> present
    -> not automatically a signup problem

organiser + no signup
    -> present
    -> not automatically a signup problem
```

Bulk attendance recording should normally default to `participant` unless another context is supplied.

Discord roles may help suggest context at recording time, but runtime role membership should not become permanent historical truth by inference alone.

---

# P2 — Cancellation Notifications

Extend event cancellation with optional notification of affected people.

Potential audiences include:

- Attending members
- Tentative members
- current organiser
- other operationally-relevant users

Notification delivery must remain separate from the authoritative cancellation transition.

A Discord delivery failure must not undo cancellation.

---

# P2 — Event Duplication

A convenient one-off duplication workflow may still be useful after templates exist.

Potential command:

```text
/event duplicate
```

Reasonable configuration to copy may include:

- event configuration
- ping roles
- fresh dormant organiser nominees
- role options
- qualification rules
- request groups
- reminder definitions

Do not copy historical/live state such as:

- signup responses
- actual attendance
- role requests
- organiser response history
- reminder delivery history
- audit history
- Discord message IDs
- completed scheduled-action state

Reassess urgency after templates are in practical use.

---

# P2 — Supervisor Availability Warnings

Where volunteers require supervision, organisers could receive warnings such as:

```text
Captain volunteers requiring supervision: 3
Qualified Supervisor volunteers available: 0
```

The system should inform the human organiser rather than automatically allocate supervisors.

---

# P2 — Reminder Improvements

Potential reminder extensions include:

- publication-relative reminders
- role-request-opening-relative reminders
- role-request-closing-relative reminders
- easier duplication
- richer destinations
- template-defined reminder sets
- recurrence-aware defaults
- additional timing references where a real use case exists

Missed reminders should remain auditable rather than simply disappearing.

---

# P2 — `/event` Command Structure Review

The `/event` command contains a broad administrator surface.

If Discord limits or real administrator usability make the current structure awkward, review whether some operations should move into dedicated command families.

Possible direction:

```text
/event
    create
    edit
    list
    publish
    cancel
    refresh

/organiser
    ...

/roles
    ...

/reminder
    ...
```

Any redesign should:

- preserve underlying services
- preserve authorisation
- preserve audit semantics
- avoid unrelated domain changes
- avoid breaking established workflows without a real benefit

Do not move code solely to obtain prettier slash-command names.

---

# P2 — Health and Diagnostics

As recoverable and scheduled workflows grow, administrator diagnostics may become useful.

Potential diagnostics include:

- scheduler health
- pending action counts
- failed actions
- overdue actions
- stale processing actions
- failed publication
- failed role-group publication
- missing Discord messages
- missing channels
- missing roles
- invalid reusable configuration
- reminder failures
- organiser anomalies
- database connectivity

Possible surfaces include:

```text
/health
```

or a future administrative portal.

Diagnostics should report state.

Automatic repair should only occur through explicit operations with understood semantics.

---

# P2 — Privacy and Data Management

Before substantially wider deployment, formalise policies and administrator tooling for stored data.

Relevant areas include:

- attendance history
- signup history
- role requests
- organiser history
- audit retention
- member deletion requests
- exports
- portal access
- administrator permissions

Avoid collecting data merely because Discord exposes it.

Retention decisions should balance legitimate operational requirements against unnecessary permanent member profiling.

---

# P2 — Targeted Architecture Improvements

Further refactoring should be driven by concrete development pressure.

Potentially useful work includes:

- reducing oversized command adapters when changes touch them
- splitting scheduler executors if breadth becomes difficult to maintain
- extracting shared loading logic where genuine duplication exists
- preserving common authorisation helpers
- strengthening service-level integration tests
- documenting lock order near race-sensitive transactions

Avoid architecture projects whose only justification is aesthetic abstraction.

In particular, avoid introducing:

- generic repository layers without a real need
- broad framework rewrites
- speculative dependency injection
- microservices
- abstraction motivated only by line count

---

# P3 — Portal Integration

A future web portal could expose:

- upcoming events
- event details
- template management
- recurring-series management
- attendance history
- signup-versus-attendance comparison
- role requests
- organiser administration
- member history
- event statistics
- diagnostics

If collaboration with an existing community bot or portal is practical, prefer integration over creating redundant systems.

A portal should consume reusable application/domain boundaries.

It should not reproduce Discord slash-command parsing as business logic.

---

# P3 — Integration With Existing Attendance Tooling

If another community system remains authoritative for actual attendance, future integration should prefer:

1. reusing or importing authoritative attendance data
2. a dedicated adapter/service boundary
3. explicit stable event identity mapping
4. explicit guild/user identity mapping
5. avoiding duplicate attendance capture

Do not couple independently-evolving database schemas accidentally.

---

# P3 — Migration and Transplant Support

If major subsystems are later moved into another bot or platform:

1. identify the portable service boundary
2. document required domain concepts
3. map event identity
4. map guild identity
5. map user identity
6. map permissions and destinations
7. create destination-specific migrations deliberately

Portability does not mean copying this repository's schema wholesale into another application.

---

# P3 — Cross-Server Event Support

The community operates across more than one Discord server.

A future model might support:

```text
one canonical event
        |
        +---- presentation in server A
        |
        +---- presentation in server B
        |
        +---- shared participation state
```

This requires deliberate modelling of:

- canonical event identity
- guild ownership
- multiple Discord presentation records
- administrator permissions
- cross-server members
- notification audiences
- channel configuration
- qualification roles
- signup authority
- role-request authority

Do not implement naïve mirrored messages before the domain model can represent multiple presentation surfaces.

---

# P3 — Export and Interoperability

Potential export formats include:

- CSV
- JSON
- spreadsheet output
- portal/API adapters

Potential export areas include:

- actual attendance
- signup responses
- signup-versus-attendance reports
- role requests
- event summaries
- historical reporting

Exports should use authoritative database/domain state.

Do not reconstruct information by scraping rendered Discord messages when PostgreSQL already stores the data.

---

# P3 — Improved Discord Presentation

Current Discord presentation is functional rather than final.

Future presentation work may improve:

- event readability
- attendance summaries
- organiser information
- role-request presentation
- template administration
- pagination
- compactness
- mobile usability

Keep presentation replaceable over stable services.

Avoid a large UI redesign while important domain workflows are still evolving.

---

# P3 — Pagination

Introduce bounded displays where actual Discord limits or usability justify them.

Likely candidates include:

- large event lists
- role-request organiser views
- attendance-response lists
- attendance history
- audit history
- large preset definitions
- future template lists

Do not introduce a pagination framework everywhere pre-emptively.

---

# P3 — Role Capacity and Waitlists

Role options already contain a capacity concept.

Before enforcing capacity, decide what it means.

Possible interpretations include:

```text
organiser guidance only
automatic waitlist
hard request limit
soft warning threshold
```

The current system records volunteer interest.

It does not guarantee assignment.

Capacity behaviour must not accidentally turn:

```text
request
```

into:

```text
guaranteed role
```

---

# P3 — Automated Role Allocation

Automatic role allocation is not a current priority.

A meaningful allocation system would need to consider:

- qualification
- supervision
- attendance availability
- multiple requested roles
- capacity
- event needs
- request timing
- organiser judgement
- team composition

The volunteer-request model should remain until there is a strong operational reason to automate allocation.

If allocation is introduced later, organisers should retain meaningful control.

---

# P3 — Advanced Analytics

Potential future analytics include:

- signup accuracy by event type
- attendance trends
- participation frequency
- role volunteering trends
- organiser coverage
- no-show patterns
- walk-in patterns
- template usage
- recurrence attendance trends

Analytics should remain informational.

Context matters for Tentative responses, supervisors, organisers, technical problems, and exceptional event circumstances.

Do not turn aggregate reporting into automatic disciplinary scoring.

---

# P3 — Additional Integrations

Possible external systems include:

- existing community attendance tooling
- existing community portal
- Google Sheets
- other event systems

External systems should connect through clear adapters or service boundaries.

Provider-specific assumptions should not spread through core event-management behaviour.

---

# Development principles across the roadmap

These are not roadmap features.

They apply to all future implementation work.

## PostgreSQL remains authoritative

Discord messages, channels, roles, DMs, and interactions are external presentation/input surfaces.

Persistent domain state remains authoritative in PostgreSQL.

---

## Regression-first bug fixing

For discovered bugs:

```text
reproduce
    |
    v
add failing regression
    |
    v
confirm intended failure
    |
    v
implement narrow correction
    |
    v
run focused coverage
    |
    v
run full gate
```

Do not skip the regression merely because the correction appears obvious.

---

## Test services directly where the database matters

New reusable service boundaries should receive PostgreSQL-backed integration tests where behaviour depends on:

- ownership
- locks
- transactions
- persistence
- idempotency
- scheduled actions
- concurrency

---

## Use real PostgreSQL for database integration tests

Continue using Testcontainers.

Do not replace lock-sensitive or transaction-sensitive coverage with an in-memory approximation.

---

## Test races deterministically

Prefer:

- explicit database locks
- controlled promises/barriers
- deliberate interleavings

over arbitrary sleeps.

A concurrency test should prove the intended ordering.

---

## Order Discord side effects around authoritative decisions deliberately

Discord calls cannot participate in a PostgreSQL transaction.

Every workflow involving external side effects should define:

- the authoritative database decision
- when Discord is called
- what is revalidated afterwards
- what happens on Discord failure
- how a losing concurrent side effect is reconciled or removed

---

## Preserve snapshot independence

Reusable configuration should not become a live dependency for existing events unless a feature explicitly requires that relationship.

When generating or applying reusable state, decide which values become event-owned snapshots.

---

## Prefer small coherent PRs

Useful boundaries include:

```text
domain/service foundation
Discord adapter
reliability follow-up
complete feature milestone
```

A PR should tell one understandable story where practical.

---

## Full verification before PR-ready work

The normal full gate is:

```bash
npm run test:unit
npm run test:integration
npm run test:coverage
npm run typecheck
npm run typecheck:test
git diff --check
```

Use manual Discord smoke tests where behaviour materially depends on:

- command registration
- Discord components
- channel selectors
- role selectors
- permissions
- mentions
- DMs
- Discord-specific error behaviour

---

## Documentation maintenance

After substantial milestones:

- update `ARCHITECTURE.md` when current structure or invariants change
- update `DECISIONS.md` when a durable design choice changes or is introduced
- update `ADMIN-GUIDE.md` when administrator behaviour changes
- update `TESTING-GUIDE.md` when testing strategy changes
- keep this roadmap focused on future work
- rewrite `CURRENT-WORK.md` around the new checkpoint rather than appending history indefinitely

Completed roadmap items should leave this document once their durable information has been captured elsewhere.

Git history and regression tests are the historical record. The roadmap is for what remains to be built.
