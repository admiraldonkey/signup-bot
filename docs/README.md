# Project Documentation

This directory contains the detailed documentation for the Holdfast Event Bot.

The documents intentionally serve different purposes.

If several files appear to discuss the same subsystem, prefer the document whose role matches the question being asked rather than treating every file as another changelog.

---

## Documentation map

| Document                                 | Primary audience            | Purpose                                                                                                                    |
| ---------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md)   | Developers                  | Current subsystem architecture, persistence model, data flow, scheduling, concurrency, recovery, and structural invariants |
| [`DECISIONS.md`](./DECISIONS.md)         | Developers                  | Durable architectural/product decisions and the reasons behind non-obvious behaviour                                       |
| [`ROADMAP.md`](./ROADMAP.md)             | Contributors                | Future development only                                                                                                    |
| [`CURRENT-WORK.md`](./CURRENT-WORK.md)   | Active development sessions | Current checkpoint, immediate objective, and implementation constraints handoff                                            |
| [`TESTING-GUIDE.md`](./TESTING-GUIDE.md) | Developers                  | Unit/integration/manual testing strategy and verification workflow                                                         |
| [`ADMIN-GUIDE.md`](./ADMIN-GUIDE.md)     | Discord administrators      | Current setup commands, event administration workflows, operational behaviour, and troubleshooting                         |

The root [`README.md`](../README.md) is the public project overview.

---

# Where to start

## I want to understand the project quickly

Read:

1. [`../README.md`](../README.md)
2. [`ARCHITECTURE.md`](./ARCHITECTURE.md)

The root README explains what the bot does and highlights the engineering approach.

The architecture document provides the detailed current model.

---

## I am continuing active development

Read:

1. [`CURRENT-WORK.md`](./CURRENT-WORK.md)
2. [`ROADMAP.md`](./ROADMAP.md)
3. the relevant sections of [`ARCHITECTURE.md`](./ARCHITECTURE.md)
4. relevant entries in [`DECISIONS.md`](./DECISIONS.md)
5. [`TESTING-GUIDE.md`](./TESTING-GUIDE.md)

Then inspect the current code and tests for the subsystem being changed.

`CURRENT-WORK.md` should tell you exactly what the next task is.

---

## I am changing administrator-facing Discord behaviour

Also read:

- [`ADMIN-GUIDE.md`](./ADMIN-GUIDE.md)

Update it in the same feature milestone when commands, responses, setup requirements, or administrator workflows change.

---

## I am changing schema, concurrency, snapshots, recovery, or scheduler behaviour

Read:

- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`DECISIONS.md`](./DECISIONS.md)
- [`TESTING-GUIDE.md`](./TESTING-GUIDE.md)

These areas contain behaviour that may look unnecessarily defensive until the relevant race or recovery requirement is understood.

---

# Document responsibilities

## `ARCHITECTURE.md`

This is the authoritative description of the **current implemented architecture**.

It should answer questions such as:

- What owns this state?
- Which table is authoritative?
- How do subsystems interact?
- What is snapshotted?
- What remains a live relationship?
- What scheduler action owns future work?
- How are Discord failures handled?
- What locking/concurrency contract applies?

Planned architecture may be included where useful, but it must be labelled clearly as planned rather than current implementation.

---

## `DECISIONS.md`

This is the durable design-decision record.

Keep information here when future developers need to understand **why** the system intentionally behaves a certain way.

Suitable examples include:

- snapshot-versus-live-reference decisions
- lock/serialization contracts
- lifecycle semantics
- destructive-versus-reversible administration choices
- decisions that reject an apparently simpler alternative

Historical decisions may remain when they still explain the current system.

Superseded decisions should be labelled accordingly rather than disappearing without context.

---

## `ROADMAP.md`

This tracks **future work**.

Completed implementation detail should leave the roadmap after its durable meaning has been captured in:

- architecture
- decisions
- administrator documentation
- testing documentation
- tests
- Git history

The roadmap should not become a project changelog.

---

## `CURRENT-WORK.md`

This is the development handoff.

It should remain short enough to orient a fresh development conversation without reconstructing months of history.

Keep:

- current checkpoint
- immediate objective
- critical constraints
- relevant upcoming architecture
- expected workflow/tests
- concise fresh-chat handoff

Do not keep detailed completed-feature history here.

When the checkpoint changes substantially, rewrite the document around the new state.

---

## `TESTING-GUIDE.md`

This documents the established testing approach.

It should describe:

- unit/integration boundaries
- PostgreSQL/Testcontainers expectations
- regression-first bug fixing
- deterministic race testing
- migration verification
- manual Discord smoke-test criteria
- full verification gate
- subsystem-specific testing patterns that remain relevant

Temporary future-test plans should move out once the feature is implemented.

---

## `ADMIN-GUIDE.md`

This describes the current administrator-facing product.

It should document:

- guild setup
- slash commands
- administrator workflows
- lifecycle behaviour
- warnings
- troubleshooting
- operational recovery

It should not retain obsolete statements about commands or features that are already implemented.

---

# Documentation maintenance rules

After a substantial feature milestone:

1. update current architecture if behaviour changed
2. record durable design decisions where required
3. update administrator guidance for user-facing changes
4. update testing guidance if a new testing pattern was established
5. remove completed work from the roadmap
6. rewrite the current-work handoff around the new checkpoint

Avoid adding the same implementation history to every document.

The repository already has Git for historical diffs and tests for behavioural history.

Documentation should make the current system easier to understand.

---

# Current development phase

The foundational event-management, organiser, role-request, reusable preset, scheduler, recovery, and reliability work is established.

Current major development phase:

```text
P1 — Event Templates
```

Immediate task:

```text
P1 — establish transaction-aware service boundaries for atomic one-off template generation
```

The P1.1 template-schema reconciliation is complete. Administrator-facing template commands and generation behaviour are not yet implemented.

See:

- [`CURRENT-WORK.md`](./CURRENT-WORK.md)
- [`ROADMAP.md`](./ROADMAP.md)
