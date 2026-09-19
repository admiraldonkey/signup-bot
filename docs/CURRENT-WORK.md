# Current Development State

**Last reconciled:** 19 September 2026

This document is the short-form handoff for the active development checkpoint.

It is not a changelog and should not accumulate detailed descriptions of completed milestones.

For durable project context, use:

- [`../README.md`](../README.md)
- [`README.md`](./README.md)
- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`DECISIONS.md`](./DECISIONS.md)
- [`ROADMAP.md`](./ROADMAP.md)
- [`TESTING-GUIDE.md`](./TESTING-GUIDE.md)
- [`ADMIN-GUIDE.md`](./ADMIN-GUIDE.md)

If this file grows substantially because completed work is being retained, rewrite it around the new checkpoint.

---

# Current Repository Checkpoint

The P0 foundation and reliability phase is complete.

The project currently has established implementations for:

- persistent event creation and lifecycle
- immediate, manual, and scheduled publication
- attendance signups
- actual attendance recording and comparison
- announcements and persistent reminders
- organiser nomination, escalation, cover, and safety workflows
- organiser feature controls
- event-level role requests
- qualification and supervision rules
- scheduled role-request opening and closing
- role-request message recovery
- reusable role-request presets
- preset editing and lifecycle management
- preset application using event-level snapshot semantics
- durable PostgreSQL-backed scheduled work
- PostgreSQL-backed audit logging
- Discord presentation recovery for key message types
- regression-first reliability coverage
- deterministic PostgreSQL concurrency testing

The final focused pre-template reliability reviews are also complete:

```text
deleted Event Administration channel
    -> definitive destination failure
    -> no guessed fallback channel
    -> scheduler distinguishes permanent failure from retryable errors

deleted Event Organiser role
    -> notification audience unavailable
    -> claimable admin message can still post
    -> delivery = posted_without_ping
    -> @everyone is never used as fallback
```

The next major development phase is:

```text
P1
Event Templates
```

---

# Immediate Objective

## P1.1 — Reconcile existing event-template schema scaffolding

Before implementing template commands or generation behaviour, inspect the current repository's template-related schema and migration history.

The repository contains template concepts that predate several important architectural developments.

Do not assume that existing template scaffolding represents the final design.

The reconciliation must compare existing template state against the architecture now established by:

```text
createStoredEvent()

event lifecycle

publication scheduling

event ping-role snapshots

organiser assignments

reminders

role-request presets

preset application

event-level role-request snapshots

durable scheduled actions

audit behaviour
```

The output of P1.1 should deliberately answer:

```text
Which existing template tables/fields remain useful?

Which old assumptions are obsolete?

What new tables or relationships are required?

Where does reusable template state end?

Where does event-owned snapshot state begin?

How does a generated event retain source-template provenance?

How should template lifecycle affect future generation?

How should templates reference reusable role-request configuration?

How should template reminder definitions become event_reminders?
```

Do not start by adding slash commands.

Establish the data model and snapshot contract first.

---

# Event Template Direction

A template is reusable source configuration for creating an ordinary event.

Conceptually:

```text
template
    |
    | generate
    v
ordinary persistent event
```

A generated event must not continuously consult its source template at runtime.

After generation:

```text
template
    -> provenance only

event
    -> owns runtime state
```

This means an existing generated event must remain independent when:

- the template name changes
- template defaults change
- organisers on the template change
- template reminder definitions change
- template audience changes
- referenced reusable configuration changes
- the template is deactivated

Normal template edits should affect future generation by default.

---

# Required Template Snapshot Boundaries

P1 design must explicitly review each of these.

## Event defaults

Candidate template defaults include:

- event type
- region
- timezone
- name
- description
- local start time
- duration
- signup behaviour
- signup-close timing
- detailed-response timing
- publication timing
- publication destination behaviour

The current normal event duration default is approximately:

```text
60 minutes
```

Do not reintroduce older two-hour assumptions.

---

## Ping roles

Template ping roles should become ordinary event-level role snapshots.

Generated events should retain the audience captured at generation time rather than reading current template roles whenever they publish.

---

## Organisers

Template organiser defaults should become ordinary dormant event organiser assignments.

They must then use the existing organiser workflow.

Do not create template-specific runtime organiser state.

---

## Role requests

Templates should build on the existing role-request preset system.

Do not create a second reusable role-request graph.

The exact template-to-preset relationship still requires design work.

Whatever model is selected must ultimately create normal event-level role-request state.

After snapshotting:

- event role options/groups belong to the event
- later preset edits do not rewrite the event
- later template edits do not rewrite the event
- normal role-request scheduler behaviour applies

---

## Reminders

Template reminder defaults should become ordinary:

```text
event_reminders
```

with ordinary durable scheduled actions.

Important P1 review:

Template-generated events may exist as:

```text
scheduled
unpublished
```

for a substantial period before public publication.

Review current signup-close reminder validity/rescheduling logic before using it for generated events.

A legitimate future reminder must not be treated as obsolete merely because publication or public signup activation has not happened yet.

---

## Publication

Template publication defaults should create ordinary event publication state and scheduled actions.

Generated events should remain manually inspectable/editable before their eventual publication time.

---

## Provenance

Generated events should retain source-template provenance for:

- administration
- debugging
- future recurrence identity
- reporting

Provenance must not create a live runtime dependency.

---

# Recurrence Direction

Recurring event generation comes after one-off template generation is stable.

Current intended shape:

```text
recurrence definition
        |
        v
bounded generator
        |
        v
ordinary event occurrences
```

Likely recurrence representation:

```text
RFC 5545 compatible RRULE
```

A mature recurrence library should be evaluated rather than implementing calendar recurrence manually.

A rolling horizon of approximately several weeks has been discussed.

Roughly:

```text
21 days
```

is a design candidate, not a fixed requirement.

---

# Critical Future Recurrence Invariant

Do not use mutable event start time as the sole occurrence identity.

A recurring occurrence needs an immutable identity for its original schedule slot.

Otherwise:

```text
generate Monday event
        |
        v
administrator moves it to Tuesday
        |
        v
generator checks Monday
        |
        v
"missing"
        |
        v
duplicate event
```

Occurrence identity must survive later event edits.

Generation must also be idempotent and concurrency-safe.

---

# Existing Architectural Invariants P1 Must Preserve

## PostgreSQL is authoritative

Discord presentation is external and fallible.

Do not make Discord messages, channels, or components authoritative domain state.

---

## Generated state must be independently owned

A generated event owns its runtime configuration.

Do not turn template configuration into a live dependency unless a future feature explicitly requires that relationship.

---

## Existing snapshots stay independent

Changes to reusable source configuration must not rewrite existing event snapshots.

This principle already applies to role-request presets and should guide templates.

---

## Durable work remains durable

Publication, reminders, organiser actions, role-request opening/closing, and completion use PostgreSQL-backed scheduled actions.

Template generation must create or coordinate durable actions through established boundaries rather than creating separate in-memory timers.

---

## Discord side effects require deliberate ordering

Discord calls cannot be transactional with PostgreSQL.

For any new template/recurrence workflow involving Discord:

1. identify the authoritative database decision
2. define when the external side effect happens
3. revalidate state where races matter
4. define cleanup/reconciliation after a losing race
5. preserve retryability for transient failures
6. distinguish permanent unavailable destinations from unexpected failures

---

## Guild ownership must remain explicit

Reusable configuration must be scoped to its owning guild.

Template, preset, event, organiser, and role relationships must not permit cross-guild mutation through foreign IDs.

---

## Idempotency matters

Repeated generation, retry, or administration commands should not create duplicate state.

When a request is already satisfied, prefer a clear unchanged/idempotent result rather than inventing a mutation.

---

## Cancellation and completion remain final

New scheduled/template logic must not revive:

- cancelled events
- completed events
- retired organiser ownership
- obsolete scheduled actions
- closed role-request groups

---

# Schema and Migration Rules

Schema work must follow the existing migration model.

Schema source:

```text
src/db/schema.ts
```

Versioned migrations:

```text
drizzle/
```

After an intentional schema change:

```bash
npm run db:generate
```

Review generated SQL before committing it.

Do not edit old migrations that may already have been applied.

Schema work should include relevant migration-chain coverage.

---

# Development Workflow

## Inspect current code first

Before proposing a P1 patch:

1. inspect the current branch
2. inspect `src/db/schema.ts`
3. inspect existing template-related migrations
4. inspect event creation services
5. inspect relevant tests
6. inspect current architecture/decision records

Do not rely on old conversation line numbers or stale snippets.

---

## Regression-first for defects

When a bug is discovered:

```text
red regression first
    |
    v
narrow production correction
```

Do not recreate a regression the developer reports is already present.

---

## Prefer direct service coverage

New reusable template services should receive direct PostgreSQL-backed integration coverage.

Particularly test:

- guild ownership
- child ownership
- validation
- transactions
- no-op behaviour
- snapshot independence
- scheduled-action creation
- locking
- concurrency

---

## Use deterministic database races

For concurrency-sensitive behaviour prefer:

- explicit PostgreSQL locks
- controlled barriers
- deliberate interleaving

Do not rely on timing sleeps when a race can be demonstrated deterministically.

---

## Keep Discord adapters thin where practical

Command handlers should coordinate Discord input/output.

Reusable template creation, mutation, generation, and recurrence behaviour should live behind service boundaries where that improves clarity and testability.

Do not introduce abstractions without a real boundary.

---

# Testing Expectations

Normal development sequence:

```text
targeted test
    |
    v
affected suite
    |
    v
typechecks
    |
    v
broader integration coverage
    |
    v
full gate
```

Normal PR-ready gate:

```bash
npm run test:unit
npm run test:integration
npm run test:coverage
npm run typecheck
npm run typecheck:test
git diff --check
```

Schema work additionally requires:

- migration review
- relevant migration-chain tests
- verification that generated migrations preserve existing state

Use manual Discord smoke tests only where behaviour materially depends on real Discord surfaces.

---

# Documentation Expectations During P1

When template work establishes new durable behaviour:

- update `ARCHITECTURE.md`
- add or amend `DECISIONS.md` for durable design choices
- keep `ROADMAP.md` focused on remaining work
- rewrite this file around the current checkpoint as P1 advances
- update `ADMIN-GUIDE.md` when commands become user-facing
- update `TESTING-GUIDE.md` when new testing patterns or subsystem expectations become established

Do not let detailed completed-template history accumulate here.

---

# P1.1 Recommended Starting Sequence

The first fresh development session should proceed approximately as follows:

```text
1. Sync main and create a focused P1.1 branch

2. Inspect template-related tables in src/db/schema.ts

3. Inspect migrations that introduced or changed template fields

4. Trace createStoredEvent() and current event creation transactions

5. Trace:
       publication setup
       ping-role snapshots
       organiser assignment creation
       reminder creation
       preset application
       scheduled-action creation

6. Compare existing template scaffolding with those boundaries

7. Write down proposed retained/removed/new schema

8. Record any durable design decisions

9. Only then begin migration/service implementation
```

Likely first branch name:

```text
feat/event-template-schema
```

or another narrowly equivalent P1.1 name.

---

# Fresh-Chat Handoff

A new development conversation should be able to start with:

```text
We are continuing development of my Holdfast Discord event-management bot.

Repository:
https://github.com/admiraldonkey/signup-bot

Please inspect the current main branch and read:
- README.md
- docs/README.md
- docs/CURRENT-WORK.md
- docs/ROADMAP.md
- docs/ARCHITECTURE.md
- docs/DECISIONS.md
- docs/TESTING-GUIDE.md

Read docs/ADMIN-GUIDE.md when administrator-facing commands or Discord UX are relevant.

Current objective:
P1.1 — reconcile the repository's existing event-template schema scaffolding against the established event architecture before implementing template behaviour.

Use the current repository and reconciled documentation as authoritative.

Continue the existing regression-first workflow.

Provide:
- exact file paths and insertion/replacement locations
- complete pasteable code for new files or substantial changes
- commands to run
- expected red/green results
- sensible commit points

Use British English.

Do not preserve old template scaffolding merely because it already exists.
Do not edit old applied migrations.
Preserve PostgreSQL authority, snapshot independence, durable scheduling, guild ownership, and existing concurrency guarantees.
```

If older conversation context conflicts with the current repository or reconciled documentation, use the current repository as the development baseline.
