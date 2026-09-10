# Testing Guide

**Last reconciled:** 10 September 2026

## Purpose

This document describes the automated and manual testing workflow for the Holdfast Event Bot.

It is intended for:

- day-to-day development
- bug reproduction
- regression-first fixes
- database and migration changes
- concurrency-sensitive work
- scheduler changes
- Discord command and interaction changes
- pre-PR verification
- deployment smoke testing
- future collaborators joining the repository

The project now has a substantial automated test suite.

Statements in older documentation that the project has little or no automated coverage are obsolete.

The current approach combines:

- Vitest unit tests
- PostgreSQL-backed integration tests
- Testcontainers
- the real committed migration chain
- V8 coverage
- production TypeScript checking
- test TypeScript checking
- deterministic concurrency regressions
- targeted manual Discord smoke testing

Automated tests establish repeatable domain and persistence behaviour.

Manual Discord testing remains important where correctness depends on the real Discord platform.

Neither replaces the other.

For current administrator commands, see:

```text
docs/ADMIN-GUIDE.md
```

For architectural and behavioural context, also read:

```text
docs/ARCHITECTURE.md
docs/DECISIONS.md
docs/CURRENT-WORK.md
docs/ROADMAP.md
```

---

# Testing Philosophy

The project follows several recurring principles.

## Test behaviour, not implementation trivia

Tests should preserve meaningful behaviour such as:

```text
Cancelled event remains cancelled

Only one organiser becomes current

Preset application sees one coherent preset graph

Deleted Discord message recovery creates one authoritative replacement

Stale scheduler worker cannot overwrite a rescheduled action
```

Avoid tests that exist only to prove that a particular helper function was called if the real behavioural outcome can be established more directly.

Command-adapter tests are an exception where verifying service arguments is often the correct boundary.

---

## PostgreSQL behaviour should be tested with PostgreSQL

When correctness depends on:

- transactions
- row locks
- uniqueness constraints
- foreign keys
- conditional updates
- `ON CONFLICT`
- isolation
- migration behaviour
- concurrent ownership
- scheduler claims

use the PostgreSQL-backed integration suite.

Do not replace those behaviours with an in-memory database or mocked persistence layer.

---

## Bugs should become regressions

A meaningful bug should usually leave behind a test that would fail if the same behaviour were reintroduced.

The preferred sequence is:

```text
Reproduce problem
      |
      v
Write failing regression
      |
      v
Confirm failure is for the intended reason
      |
      v
Implement the narrow fix
      |
      v
Confirm regression turns green
      |
      v
Add positive or companion coverage where useful
      |
      v
Run related subsystem tests
      |
      v
Run full verification gate
```

The red regression should be observed before changing production code.

It does **not** normally need to be committed as a permanently failing revision.

Older project guidance recommending a separate committed red revision has been superseded.

---

## Race tests should be deterministic

Do not attempt to prove concurrency behaviour primarily with arbitrary delays such as:

```ts
await sleep(100);
```

A test that passes only because one task "probably got there first" is not strong race coverage.

Prefer:

- explicit PostgreSQL locks
- open transactions
- promises used as barriers
- controlled mock boundaries
- conditional writes
- known scheduler ownership state

The test should deliberately create the interleaving it intends to verify.

---

## Test the legitimate path too

A regression that blocks stale or invalid behaviour should usually have a positive companion case showing that the legitimate operation still succeeds.

For example:

```text
Cancellation races attendance response
    -> stale response rejected

Normal open event
    -> attendance response succeeds
```

or:

```text
Preset application races admin edit
    -> application sees one coherent graph

Normal valid preset
    -> application succeeds
```

This reduces the risk of "fixing" a race by preventing all useful behaviour.

---

# Test Stack

The current testing stack is:

```text
Vitest
TypeScript
PostgreSQL 17
Testcontainers
Docker
V8 coverage
```

Unit and integration tests run as separate Vitest projects.

Both use the Node test environment.

---

# Repository Test Layout

The broad layout is:

```text
tests/
├── integration/
├── support/
└── unit/
```

## Unit tests

Located under:

```text
tests/unit/**/*.test.ts
```

These run through:

```text
vitest.config.ts
```

---

## Integration tests

Located under:

```text
tests/integration/**/*.test.ts
```

These run through:

```text
vitest.integration.config.ts
```

The integration configuration:

- starts a disposable PostgreSQL environment through global setup
- applies the committed migration chain
- shares that database for the integration project
- runs test files serially
- allows individual tests to perform explicit concurrency where required

Test-file parallelism is deliberately disabled because the integration suite shares one disposable database and tests may reset application state.

---

# Available Commands

## Unit tests

```bash
npm run test:unit
```

Runs:

```text
tests/unit
```

Use this for:

- pure helpers
- command adapters
- Discord response formatting
- option parsing
- mocked external side effects
- small deterministic domain behaviour that does not require PostgreSQL

---

## Integration tests

```bash
npm run test:integration
```

Runs the PostgreSQL-backed integration suite.

Use this for:

- service persistence
- database constraints
- scheduler state
- event lifecycle transitions
- organiser ownership
- role requests
- reusable presets
- migrations
- concurrency
- transaction rollback
- database-side idempotency

---

## Combined coverage

```bash
npm run test:coverage
```

This runs both unit and integration projects and produces combined application-level V8 coverage.

Current reports include:

```text
terminal text report
coverage/ HTML report
```

Source coverage is collected from:

```text
src/**/*.ts
```

---

## Unit-only coverage

```bash
npm run test:coverage:unit
```

Useful when developing a command adapter or other unit-heavy change.

This does not replace the final combined coverage run.

---

## Integration-only coverage

```bash
npm run test:coverage:integration
```

Useful when concentrating on database/service behaviour.

This does not replace the final combined coverage run.

---

## Production typecheck

```bash
npm run typecheck
```

Checks production TypeScript using the normal project configuration.

---

## Test typecheck

```bash
npm run typecheck:test
```

Checks test TypeScript separately.

The two checks are intentionally distinct.

Test-specific compiler configuration should not weaken or obscure the production build configuration.

---

## Default test command

```bash
npm test
```

This invokes the default Vitest configuration.

At present that configuration represents the unit test project.

For deliberate development work, prefer the explicit commands:

```text
npm run test:unit
npm run test:integration
```

because they make the intended scope obvious.

---

## Watch mode

```bash
npm run test:watch
```

Useful for rapid local work on unit tests.

Do not use watch-mode success as a substitute for the full non-interactive verification commands before a PR.

---

# Running Targeted Tests

During implementation, do not repeatedly run the entire suite after every edit.

Start with the smallest meaningful scope.

---

## One unit test file

Example:

```bash
npx vitest run \
  tests/unit/commands/role-preset-group-set-active.test.ts
```

---

## Several related unit files

Example:

```bash
npx vitest run \
  tests/unit/commands/role-preset-group-set-active.test.ts \
  tests/unit/commands/role-preset-option-set-active.test.ts \
  tests/unit/commands/role-preset-set-active.test.ts
```

---

## One integration test file

Example:

```bash
npm run test:integration -- \
  tests/integration/role-requests/role-request-preset-admin-service.test.ts
```

---

## Several integration tests directly through Vitest

Example:

```bash
npx vitest run \
  --config vitest.integration.config.ts \
  tests/integration/role-requests
```

This is useful when expanding from one regression file to an entire subsystem.

---

# Recommended Development Test Sequence

For a normal feature:

```text
1. Typecheck relevant code

2. Run the smallest affected unit or integration test

3. Implement the next small slice

4. Re-run targeted tests

5. Expand to the affected subsystem

6. Run both TypeScript checks

7. Run the full unit suite

8. Run the full integration suite

9. Run combined coverage

10. Perform targeted Discord smoke testing if the Discord surface changed

11. Run git diff --check
```

A typical final automated gate is:

```bash
npm run test:unit
npm run test:integration
npm run test:coverage
npm run typecheck
npm run typecheck:test
```

Then:

```bash
git diff --check
```

All should be green before ordinary PR-ready work is considered complete.

---

# PostgreSQL Integration Environment

The integration suite uses Testcontainers to start:

```text
postgres:17-alpine
```

The database is disposable and exists only for the test run.

The global setup:

1. starts PostgreSQL
2. obtains the generated connection URI
3. applies database safety validation
4. runs the repository's real committed migrations
5. creates a private test-harness guard
6. supplies the safe connection details to the integration test project
7. stops the container after the project completes

---

# The Real Migration Chain Is Tested

The integration suite deliberately runs:

```text
drizzle/
```

migrations from an empty PostgreSQL database.

It does not use:

```text
drizzle-kit push
```

to construct the integration schema.

This is important because deployment also relies on versioned migrations.

A schema definition that looks correct in `src/db/schema.ts` is not enough if the committed migrations cannot reproduce it.

---

# Integration Database Safety

The integration harness includes safeguards against destructive test reset logic being pointed at an arbitrary database.

Do not bypass those protections to make a test easier to run.

If a safety check rejects the current database:

1. inspect the test environment
2. confirm Docker is running
3. confirm the integration suite is using its Testcontainers database
4. fix the environment or harness configuration

Do not weaken the guard.

Never point the integration suite at:

- a production database
- the live community database
- a hosted development database containing useful state
- another developer's persistent database

The integration database should be disposable.

---

# Integration Test Isolation

Integration test files share one disposable PostgreSQL instance for the project.

They are executed one file at a time.

Tests should still be independently repeatable.

Do not make one test rely on rows created by a previous test.

Each test should create the domain state it requires.

Where shared helpers create fixtures, their behaviour should remain explicit enough that a reader can understand which important state the test depends on.

---

# Timeouts

The integration suite allows more time for database and container setup than ordinary unit tests.

Current configuration uses approximately:

```text
Test timeout:     10 seconds
Hook timeout:     30 seconds
Teardown timeout: 30 seconds
```

Do not casually increase these limits because one test became flaky.

First determine whether the test:

- contains an uncontrolled wait
- deadlocks
- failed to release a barrier
- starts unnecessary infrastructure
- waits on a real external service
- has lost deterministic ownership

Longer timeouts can hide race-test defects.

---

# Unit Tests

Unit tests are appropriate when the subject does not require real PostgreSQL behaviour.

Good candidates include:

- timezone helpers
- pure date calculations
- formatting functions
- Discord command definitions
- option parsing
- Discord command routing
- response rendering
- service-result handling
- small deterministic transformations

Command tests commonly mock:

- Discord
- database-backed services
- audit output
- external notification functions

The goal is to verify the adapter boundary.

For example:

```text
Discord options
      |
      v
expected service input
      |
      v
expected Discord reply
```

---

# Command Adapter Tests

For slash commands, useful coverage includes:

- command/subcommand registration
- required versus optional command options
- Discord option names
- authorisation handling
- Discord-specific validation
- exact service inputs
- user-facing success output
- known service-result errors
- audit calls for actual mutations
- lack of mutation audit for idempotent no-ops

Where a command imports a mocked service module using named exports, test mocks should expose every imported named export required by that command module.

This prevents unrelated focused tests from failing during module initialisation after a new service function is imported.

---

# Direct Service Integration Tests

A newly-extracted database-backed service should normally receive direct integration tests.

This is especially important when the service establishes a reusable domain boundary.

Direct service tests should cover relevant behaviour such as:

- guild ownership
- object ownership
- correct persistence
- transaction rollback
- idempotency
- timestamps
- child preservation
- scheduler action creation
- concurrency locks
- invalid-state rejection

Do not rely exclusively on a command test if the real risk is in the transaction.

---

# Regression-First Bug Fixing

When a concrete bug is identified, follow this sequence.

## Step 1: reproduce it

Record:

- command or interaction used
- event ID
- preset ID if relevant
- role-option ID if relevant
- group ID if relevant
- reminder ID if relevant
- expected behaviour
- actual behaviour
- approximate time
- relevant Discord message or error

---

## Step 2: add the smallest meaningful regression

Prefer the lowest useful layer.

Examples:

```text
Pure formatting bug
    -> unit test

Command wiring bug
    -> command unit test

Database lifecycle bug
    -> integration test

Concurrency ownership bug
    -> deterministic integration test

Discord-only behaviour
    -> automated domain coverage where possible
       plus manual Discord reproduction
```

---

## Step 3: confirm RED

Run the new test before changing production behaviour.

The failure should demonstrate the intended defect.

A failing test caused by:

- a typo in the test
- bad SQL
- invalid fixture setup
- a missing mock
- an incorrect assumption

is not yet a valid regression.

Fix the test harness until the test fails for the actual product bug.

---

## Step 4: implement the narrow fix

Avoid combining an unrelated refactor with the first correction unless the refactor is necessary to fix the bug safely.

---

## Step 5: confirm GREEN

Run the regression again.

Then add or run positive companion coverage.

---

## Step 6: expand verification

Run:

```text
target file
affected subsystem
full unit/integration suite
coverage
both typechecks
```

as appropriate.

---

# Do Not Commit Broken Tests Merely to Prove They Were Red

The project previously used a convention of committing a failing regression separately.

That is no longer the normal workflow.

The important evidence is:

```text
the regression was run
it failed for the intended reason
the production change made it pass
```

Normal branch history should remain green unless there is a very deliberate reason to preserve a failing commit during active collaboration.

---

# Positive Companion Coverage

When a regression introduces stricter validation or locking, check the corresponding valid path.

Examples:

```text
Stale organiser confirmation rejected
Normal active organiser confirmation succeeds
```

```text
Cancelled event rejects attendance interaction
Open event accepts attendance interaction
```

```text
Inactive preset rejects application
Active valid preset applies successfully
```

```text
Group opening race creates one authoritative message
Normal scheduled opening publishes successfully
```

A negative test alone can accidentally validate an implementation that rejects everything.

---

# Concurrency Testing

Concurrency is a major part of this project.

Important races include:

- event edit versus cancellation
- publication versus publication
- manual publication versus scheduled publication
- attendance interaction versus closure
- attendance reopen versus stale close
- completion versus cancellation
- organiser response versus timeout
- organiser response versus replacement
- backup activation versus cover escalation
- simultaneous cover claims
- organiser feature disable versus normal organiser operation
- organiser safety deadline versus confirmation
- event-time edit versus claimed organiser safety action
- role request versus attendance change
- role request versus group closure
- role-request opening versus event edit
- concurrent role-request publication
- concurrent deleted-message recovery
- preset application versus preset mutation
- scheduler recovery versus stale worker completion

---

# Deterministic Race Pattern

A useful integration race often looks like:

```text
Operation A begins
      |
      v
Operation A reads old state
      |
      v
Operation A reaches authoritative lock/write
      |
      v
BLOCK
      |
      +-------------------------+
                                |
                         Operation B commits
                         newer authoritative state
                                |
      +-------------------------+
      |
      v
Release Operation A
      |
      v
Operation A must respect newer state
```

The exact mechanism may use:

- `SELECT ... FOR UPDATE`
- `SELECT ... FOR SHARE`
- an explicit open transaction
- a controlled promise around a Discord side effect
- a conditional `UPDATE`
- a unique constraint
- a scheduler attempt fence

---

# What a Race Regression Should Assert

Do not assert only that one promise rejected.

Check the resulting system.

Depending on the workflow, assert:

- final database state
- current ownership
- scheduled-action state
- attempt count
- message linkage
- absence of duplicate rows
- absence of stale audit output
- absence of stale Discord success effects
- correct user-facing result
- cleanup of losing candidate messages

The database result is normally the most important assertion.

---

# Lock Ordering Tests

When a new transaction touches several authoritative rows, first inspect neighbouring operations.

Determine the established lock order.

Do not create a new path that acquires the same rows in reverse order.

If the change introduces a meaningful new race surface, add a regression that demonstrates the intended ordering.

Examples of existing lock contracts include:

```text
Preset application
    -> preset parent FOR SHARE

Preset mutation
    -> preset parent FOR UPDATE
```

and:

```text
Normal organiser operation
    -> guild_settings FOR SHARE

Disable organisers
    -> guild_settings FOR UPDATE
```

The test should verify the domain guarantee rather than asserting merely that a particular SQL clause exists.

---

# Scheduler Testing

The scheduler is persistent and concurrency-sensitive.

Changes to scheduled actions should be tested at both levels:

```text
scheduler mechanics
domain executor behaviour
```

---

## Scheduler mechanics

Important areas include:

- due-action selection
- conditional claim
- attempt increment
- processing lock
- stale processing recovery
- retry delay
- attempt exhaustion
- terminal failure
- cancellation
- completion fencing
- authoritative rescheduling

---

## Current retry behaviour

The current retry progression begins:

```text
Attempt 1 -> retry after 1 minute
Attempt 2 -> retry after 2 minutes
Attempt 3 -> retry after 4 minutes
Attempt 4 -> retry after 8 minutes
Attempt 5 -> terminal failure
```

Tests should prevent an accidental sixth execution.

---

## Stale processing recovery

Verify both branches:

```text
stale processing action
attempts remain
    -> pending again
```

and:

```text
stale processing action
final attempt already consumed
    -> failed
```

---

## Stale-worker fencing

A critical scheduler regression pattern is:

```text
Worker claims attempt
      |
      v
Worker stalls
      |
      v
Action is recovered or authoritatively rescheduled
      |
      v
Old worker resumes
      |
      v
Old worker must not mark newer state completed
```

Test:

- completion fencing
- retry fencing
- reschedule fencing

where relevant.

---

## Administrative rescheduling

An administrator changing timing is not a failed scheduler attempt.

Tests should verify that authoritative rescheduling resets stale state where appropriate:

```text
status -> pending
attemptCount -> 0
lockedAt -> null
completedAt -> null
lastError -> null
```

and sets the new due time.

---

# Scheduler Domain Executors

Each scheduled action must re-check authoritative domain state.

A due row is not permission to blindly perform stale work.

Examples:

## Event publication

Test that a due publication action becomes harmless when the event is:

- already published
- cancelled
- completed
- otherwise no longer valid for publication

---

## Attendance closure

Test:

- normal scheduled close
- already-closed attendance
- manual close racing scheduler
- reopen followed by stale old close
- event cancellation

---

## Completion

Test:

- normal completion
- cancellation wins
- stale completion cannot revive or alter cancellation

---

## Reminders

Test:

- successful send
- rescheduling after event-time edit
- rescheduling after signup-close edit
- removal/cancellation
- missed reminder behaviour
- no late misleading send

---

## Organiser actions

Test:

- warnings
- response timeouts
- backup activation
- general cover escalation
- warning reconciliation
- safety deadline
- missing-organiser-at-start check
- event-time rescheduling
- late publication
- stale claimed action after event move

---

## Role-request group actions

Test:

- normal planned opening
- already-posted group
- opening time not yet reached
- expired request window
- normal close
- already-closed group
- event-start rescheduling
- manual immediate group without relative opening
- scheduler retry after unexpected Discord failure

---

# Mocking Guidelines

Mocks are appropriate when the mocked boundary is not what the test intends to prove.

Good mock candidates include:

- Discord message sends
- Discord message edits
- Discord DMs
- Discord channel fetches
- audit calls in command-adapter tests
- domain services in command-adapter tests
- deliberately controlled Discord boundaries in race tests

Use real PostgreSQL when testing:

- events
- attendance responses
- actual attendance
- organiser assignments
- role requests
- role-request groups
- presets
- scheduled actions
- audit persistence
- transactions
- ownership
- database constraints

A database correctness test should not pass merely because a mock was configured to return the desired state.

---

# Discord Error Classification Tests

Do not use a generic rejected promise to represent every Discord failure.

Where production behaviour distinguishes known Discord errors, tests should distinguish them too.

Important categories include:

```text
Unknown Message
Unknown Channel
Unknown Role
unexpected/transient failure
```

Example expected behaviours:

```text
Unknown Message
    -> message recovery may begin

Unknown Channel
    -> preserve database state
    -> do not guess a destination

Unexpected fetch failure
    -> propagate
    -> do not falsely recreate message
```

---

# Message Recovery Tests

Core recovery currently applies to:

- attendance/event messages
- role-request group messages

Important automated scenarios include:

## Edit in place

Stored message exists.

Expected:

```text
edit existing message
keep existing linkage
```

---

## Deleted message

Discord explicitly reports the message missing.

Expected:

```text
rebuild current payload
send replacement
conditionally store replacement linkage
```

---

## Concurrent recovery

Two recovery attempts create candidates.

Expected:

```text
one database linkage wins
losing Discord message is cleaned up
```

---

## Destination channel deleted

Expected:

```text
do not recreate elsewhere
do not alter domain state
```

---

## Unexpected fetch failure

Expected:

```text
propagate error
do not treat it as deletion
```

---

## Notification replay

Recovery must not re-ping the normal event or request-group audience.

Test `allowedMentions` or equivalent rendered payload behaviour where applicable.

---

# Preset Testing

Reusable role-request presets now have a substantial test surface.

Important areas include:

- creation
- listing
- details
- role-option creation
- qualification configuration
- request-group creation
- mappings
- channel resolution
- application
- durable action creation
- parent lifecycle
- option lifecycle
- group lifecycle
- guild isolation
- cross-preset child ownership
- idempotency
- application/mutation locking

---

# Preset Application Tests

Application tests should verify:

- event belongs to guild
- event type permits role requests
- preset belongs to guild
- preset is active
- active options are valid
- qualification rules are valid
- active groups are valid
- group mappings resolve to usable options
- signup requirements are compatible
- fixed channel is copied
- null preset channel resolves the current guild default
- notification metadata is snapshotted
- event-level options are created
- qualification roles are snapshotted
- event-level groups are created
- mappings are created
- source provenance is retained
- opening action is created
- closing action is created
- repeated same-preset application is idempotently rejected
- logical option-key conflicts are rejected cleanly
- transaction rollback prevents partial application

After application, tests should establish that runtime state is independent from later source-preset mutation.

---

# Preset Lifecycle Tests

## Parent preset

Test:

- deactivate
- reactivate
- child states preserved
- unchanged state is a no-op
- `updatedAt` does not change on no-op
- foreign guild cannot mutate it
- inactive preset cannot be applied

---

## Role option

Test:

- deactivate
- reactivate
- qualification rows preserved
- group mappings preserved
- group lifecycle state unchanged
- no-op timestamps preserved
- foreign guild rejected
- option from another preset rejected
- newly invalid active groups reported

---

## Request group

Test:

- deactivate
- reactivate
- option mappings preserved
- option lifecycle states unchanged
- configuration preserved
- no-op timestamps preserved
- foreign guild rejected
- group from another preset rejected

---

# Preset Application Versus Mutation Race

Future preset edit operations must retain this contract:

```text
Application
    -> parent preset FOR SHARE

Mutation
    -> parent preset FOR UPDATE
```

When adding each new mutation family, add direct integration coverage where useful to establish that application sees:

```text
all old values
```

or:

```text
all new values
```

but never a partially-edited graph.

This will be particularly important for:

- qualification-role replacement
- group-option mapping replacement
- multi-field group edits

---

# Organiser Testing

The organiser subsystem has several layers that should remain distinct in tests.

---

## Assignment

Test:

- primary nomination
- backup nomination
- replacement
- removal
- bot-user rejection
- invalid primary/backup combinations
- event ownership
- cancelled/completed event behaviour
- organiser feature disabled

---

## Dormant unpublished assignments

For unpublished events, verify:

```text
assignment exists
activatedAt is null
responseDeadlineAt is null
no premature response notification
```

Publication should activate the normal workflow only when event timing still allows it.

---

## Confirm and decline

Test:

- normal confirmation
- normal decline
- already-resolved assignment
- stale interaction
- cancellation race
- completion race
- timeout race
- replacement race
- feature-disable race

---

## Warning reconciliation

Test that stored pending warnings are reconciled when the assignment becomes:

- confirmed
- declined
- timed out
- replaced
- removed

Also cover event:

- cancellation
- completion

Deleted warning messages or channels should not undo assignment state.

---

## Primary timeout and backup escalation

Test:

```text
primary pending
    -> warning
    -> timeout
    -> backup activation
```

and:

```text
backup pending
    -> warning
    -> timeout
    -> general cover
```

Also cover:

- no backup exists
- backup already invalid
- organiser confirms while warning/send is in flight
- stale scheduled timeout after resolution

---

## General cover

Test:

- eligible organiser claim
- ineligible user
- competing claims
- backup confirmation racing cover claim
- stale cover request
- cover remains possible after event start while the event has not ended
- cover is rejected after `endsAt` even if persisted lifecycle still says `open`
- event cancellation
- event completion
- organisers disabled

Do not reintroduce the obsolete assertion that every post-start cover claim must fail.

The important distinction is:

```text
startsAt < now < endsAt
    -> cover may still be useful

endsAt <= now
    -> new organiser cover is obsolete
```

---

# Organiser cover-message reconciliation

Direct reconciliation coverage should verify:

```text
cover claim
    -> every outstanding tracked cover/start message resolves

T+0 missing-organiser alert
    -> older organiser_cover messages resolve
    -> new organiser_missing_at_start message remains live

known deleted message
    -> resolvedAt set
    -> deletedAt set

unexpected Discord failure
    -> error propagates
    -> tracked message remains unresolved

already-resolved message
    -> Discord is not fetched again
```

Scheduler and interaction wiring should separately prove that reconciliation is invoked after the authoritative domain transition.

Important ordering regressions include:

```text
T+0 alert sent
    -> T+0 linkage persisted
    -> older cover messages reconciled
```

and:

```text
event completion committed
    -> cover messages reconciled
```

This keeps Discord cleanup secondary to PostgreSQL authority.

---

## Organiser safety deadline

Test:

- unresolved primary retired at safety deadline
- unresolved backup retired at safety deadline
- confirmed organiser remains valid
- cover becomes authoritative
- scheduled nominee actions become obsolete
- event start edit moves safety deadline
- stale claimed safety action recalculates current deadline
- late publication after safety deadline does not start a fresh normal primary window

---

## Missing organiser at event start

Test separately from the earlier safety deadline.

The event-start action should:

- recognise an already-confirmed organiser
- alert when still unresolved
- avoid duplicate current ownership
- track the urgent Discord message
- supersede older general-cover presentation only after the new alert is durably linked
- remain safe after cancellation/completion
- become harmless when scheduler catch-up occurs after `endsAt`

---

## Post-end organiser scheduler catch-up

Explicitly test overdue organiser actions where:

```text
endsAt < now
status = open
complete_event has not yet caught up
```

Relevant paths include:

```text
organiser warning
organiser timeout
organiser safety deadline
missing organiser at start
cover claim context
authoritative cover claim
```

These regressions exist to prove that action ordering during restart cannot create new operational organiser state for an event that has already finished.

Keep positive companion coverage showing that organiser cover still works after `startsAt` but before `endsAt`.

---

## Feature locking

For organiser feature disable, use deterministic database concurrency tests.

The relevant intended ordering is:

```text
normal organiser operation
    -> shared guild-settings lock

disable organisers
    -> exclusive guild-settings lock
```

Test both orderings where practical:

```text
operation begins first
    -> completes coherently before disable

disable wins first
    -> later organiser operation is rejected
```

---

# Attendance Testing

## Signup responses

For signup-enabled events test:

```text
Attending
Tentative
Not Attending
```

Verify:

- one current response per user/event
- changing response replaces old state
- cancelled/completed lifecycle is respected
- closure is respected
- public message refreshes where appropriate

---

## Closure and reopen

Test:

- automatic close
- manual close
- close race
- reopen
- stale old close after reopen
- cancelled event cannot reopen
- completed event cannot reopen
- past event rules

---

## No-signup events

Test:

- no signup controls
- no signup deadline requirement
- actual attendance can still be recorded
- organisers can still function
- role requests can still function where permitted
- discrepancy reports do not invent signup problems

---

# Actual Attendance Testing

Test:

```text
/attendance record
/attendance add
/attendance remove
```

Important behaviour:

- full record replaces current actual-attendance set
- add changes one member without disturbing others
- remove changes one member without disturbing others
- event ownership is enforced
- historical reporting remains coherent

---

# Signup Versus Actual Attendance

Useful test matrix:

```text
Signed Attending + attended
Signed Attending + absent
Tentative + attended
Tentative + absent
Not Attending + attended
No signup + attended
Signup + no actual record
```

Expected principles:

- Tentative absence is contextual
- Attending absence is distinguishable
- Not Attending plus attendance is distinguishable
- no-signup walk-in is meaningful only for signup-enabled events
- no-signup events do not create artificial reliability issues

---

# Role-Request Testing

## Role options

Test:

- open option
- qualified-only option
- full qualification role
- supervision-required role
- invalid qualification configuration
- guild/event ownership
- event type with role requests disabled

---

## Shared role pool

Create:

```text
Group A
    Captain

Group B
    Captain
    Carpenter
```

Request Captain through Group A.

Verify:

- Group B reflects the same event-level Captain request
- organiser view shows one Captain request
- pressing Captain again in Group B does not create a duplicate
- the two messages do not represent separate volunteer pools

---

## Multi-select

From one member request:

```text
Captain
Carpenter
Gunboat Gunner
```

Verify all coexist.

A later role request must not replace the earlier ones.

---

## Duplicate request

Press a role button that already has a stored request.

Verify:

- original request remains
- no duplicate row appears
- request is not withdrawn
- response explains that the request already exists

---

## Explicit withdrawal

Through the member request-management flow:

- withdraw one request
- leave unrelated requests intact
- allow withdrawal after new requests have closed where intended
- re-request later
- verify new request receives a new position/time

---

## Qualification

For `qualified_only` roles test:

```text
fully qualified member
    -> request accepted

supervision-required member
    -> request accepted
    -> status visible to organiser

unqualified member
    -> rejected
    -> no request row
```

Use Discord role IDs/configuration rather than hardcoded community role-name assumptions.

---

## Signup-gated groups

For a group requiring positive signup:

```text
Attending
    -> may add request

Tentative
    -> may add request

Not Attending
    -> may not add request

No signup
    -> may not add request
```

Also verify that a group configured without the signup requirement still supports the intended early/no-signup workflow.

---

## Attendance changes after requesting

Test:

```text
member requests role
        |
        v
member changes to Not Attending
        |
        v
request remains stored
but becomes unavailable
        |
        v
member returns to Attending
        |
        v
same request becomes available again
```

The original request timestamp should not be reset merely because availability changed.

---

# Role-Request Group Timing Tests

Test closing:

- before event start
- at event start
- after event start

Test opening:

- before event start
- at event start where valid
- after event start where valid
- manually immediate group with no relative opening rule

---

## Lifecycle presentation

Verify administrative lifecycle states:

```text
future opening and no message
    -> Planned

opening reached but no message linked
    -> Pending publication

message linked and before close
    -> Open

closedAt set or close deadline reached
    -> Closed
```

Do not describe a merely due but unpublished group as open.

---

## Event-time edits

Verify:

```text
planned relative group
    -> opening moves
    -> closing moves

already-published group
    -> opening history remains
    -> closing moves

manual immediate group
    -> opening remains
    -> closing moves

closed group
    -> remains closed
```

Also inspect scheduled-action retry state where the action is authoritatively rescheduled.

---

# Role-Request Group Publication Tests

Automated coverage should distinguish expected outcomes such as:

- not found
- already posted
- inactive
- not open yet
- awaiting event publication
- window expired
- channel unavailable

Unexpected Discord failures should propagate and allow scheduler retry.

`awaiting-event-publication` is different.

It is an intentional domain deferral and must not consume the scheduler's Discord failure retry budget.

Test the event-publication matrix explicitly:

```text
published event
due group
    -> publish

unpublished event
manual publication
    -> wait

unpublished event
future scheduled publication
group opens before that publication
    -> publish

unpublished event
scheduled publication already due
    -> wait
```

Also test:

- channel permissions
- optional notification role
- missing notification role
- unmentionable notification role
- mention suppression on later refresh/recovery
- concurrent publication producing one authoritative linkage
- publication intent changing while Discord send is in flight
- stale candidate cleanup after the in-flight state change

For in-flight publication-intent races, assert that:

```text
Discord candidate may have been sent

PostgreSQL rejects stale linkage

candidate is deleted

group remains unlinked
```

---

## Deferred opening scheduler coverage

When automatic role-group publication returns:

```text
awaiting-event-publication
```

verify the scheduler changes the claimed opening action to:

```text
status = pending
dueAt = closesAt
attemptCount = 0
lockedAt = null
completedAt = null
lastError = null
```

Waiting for parent-event publication is not an execution failure.

Also verify successful event publication wakes an already-due, still-valid deferred opening.

The publication-side test should prove:

```text
due deferred group
    -> opening action dueAt becomes publishedAt

future group
    -> original opening dueAt remains unchanged
```

Include the processing-action companion case.

If event publication wins while an opening action is already:

```text
processing
```

the publication transaction may reset that action to fresh pending state.

The stale scheduler worker must then be fenced by the existing status/attempt ownership checks.

---

# Reminder Testing

Test all current reminder operations.

## Add

Verify:

- reference type
- offset
- resolved due time
- channel snapshot
- content
- ping-role option
- scheduled action

Current reference types include:

```text
event start
signup close
```

---

## Edit

Verify changing:

- offset
- reference
- content
- channel
- ping behaviour

reschedules or updates the durable work appropriately.

---

## Remove

Verify the reminder cannot later send.

---

## Event timing edits

Verify pending reminder timing follows the relevant reference point.

Already-sent reminders must not become pending again.

---

## Missed reminder

Create a state where the reminder is no longer useful.

Verify:

- Discord message is not sent misleadingly late
- reminder is recorded as missed
- useful audit/error context remains

---

# Future Template Reminder Regression

When event templates are implemented, add a regression before relying on existing reminder-rescheduling code.

Generated events may remain:

```text
scheduled
unpublished
```

for a long period.

A valid future signup-close reminder must not be cancelled merely because the event is not yet publicly open.

This is a known future test requirement.

---

# Audit Testing

Use direct persistence tests for audit behaviour where appropriate.

Command tests should verify audit calls for important administrator mutations.

Useful assertions include:

- guild
- actor
- action
- outcome
- target type
- target ID
- structured details

Automatic scheduled actions should use system/no-user attribution where appropriate.

Discord audit mirroring must not be required for the database audit row to exist.

For idempotent no-op lifecycle commands, do not falsely assert a successful mutation audit unless the product explicitly chooses to record attempted no-ops.

---

# Migration Testing

Any schema change should follow this workflow.

## 1. Edit the Drizzle schema

```text
src/db/schema.ts
```

---

## 2. Generate a migration

```bash
npm run db:generate
```

---

## 3. Inspect the generated SQL

Do not assume generated SQL is correct simply because generation succeeded.

Check:

- table names
- column types
- nullability
- defaults
- foreign-key behaviour
- indexes
- uniqueness
- constraint names

---

## 4. Check PostgreSQL identifier lengths

PostgreSQL identifiers are limited to 63 bytes.

Long generated constraint names can truncate into collisions.

If necessary, give constraints concise explicit names in the Drizzle schema.

---

## 5. Run integration tests from the real migration chain

```bash
npm run test:integration
```

The disposable database begins empty and receives the committed migrations.

This is the important proof that deployment-style schema creation works.

---

## 6. Run full verification

```bash
npm run test:unit
npm run test:integration
npm run test:coverage
npm run typecheck
npm run typecheck:test
```

---

# Applied Migration Rule

Do not rewrite an existing migration merely to make current local history prettier once that migration may have been applied elsewhere.

Create a new correction migration.

Historical migrations are part of the deployment path.

---

# Manual Discord Testing

Automated tests should cover domain and database behaviour wherever practical.

Manual testing is still required when correctness depends materially on Discord itself.

Good reasons for a manual test include:

- new slash command
- changed command options
- new button
- changed embed/message layout
- role selector
- channel selector
- Discord permissions
- role mentionability
- DMs
- fallback messaging
- real deleted-message behaviour
- cross-channel behaviour

A pure database helper usually does not need a Discord smoke test.

---

# Manual Test Environment

Where possible use:

- dedicated development Discord server
- development bot
- development PostgreSQL database
- disposable test events
- test Discord accounts where multiple actors are required

Do not perform destructive development testing against important community data unless there is a deliberate reason.

Record relevant IDs when a manual problem occurs.

Useful identifiers include:

- event ID
- preset ID
- preset option ID
- preset group ID
- event role-option ID
- role-request group ID
- reminder ID
- scheduled-action key where known

---

# Core Manual Event Smoke Test

For a substantial event change, useful checks include the following.

## Immediate event

Create an immediately published event.

Verify:

- event row created
- public message appears in expected channel
- times are correct
- ping roles are correct
- signup controls match configuration
- event ID is returned
- `/event list` reflects the event

---

## Unpublished event

Create a manually unpublished event.

Verify:

- event receives an ID
- no public attendance message appears
- administrative configuration remains possible
- `/event list` shows it as unpublished rather than nonexistent

---

## Scheduled publication

Create an event with publication due shortly.

Verify:

- it remains unpublished before due time
- it publishes once
- scheduled action becomes completed/obsolete correctly
- organiser activation occurs once where appropriate

---

## Manual early publication

For an event with scheduled publication:

```text
publish manually before due time
```

Verify:

- publication occurs immediately
- later scheduler execution does not create another public message
- organiser activation is not duplicated

---

## Cancellation before publication

Verify:

- event becomes cancelled
- no message is later published
- stale scheduled publication cannot revive it

---

# Signup Manual Test

For a published signup-enabled event:

- respond Attending
- respond Tentative
- respond Not Attending
- change one response
- inspect `/event responses`

Verify only one current response exists per user.

Also test:

- automatic close
- manual close
- reopen
- buttons after closure
- cancellation

---

# No-Signup Manual Test

Create an event with signups disabled.

Verify:

- no attendance-response controls appear
- no signup deadline is required
- organiser workflow can still operate
- role-request workflows can still operate where enabled
- reminders can still operate
- actual attendance can still be recorded

---

# Organiser Manual Test

Where organiser behaviour changed materially, test the relevant subset.

## Primary confirmation

Verify:

- dormant before publication where appropriate
- notification at activation
- confirm works
- warning/timeout no longer falsely claims pending
- backup does not later activate

---

## Primary decline

Verify:

- primary becomes declined
- backup activates
- backup receives its own prompt

---

## Primary timeout

Use short development timings.

Verify:

- warning appears
- timeout occurs
- warning reconciles
- backup or cover path activates

---

## Backup decline or timeout

Verify transition to general cover.

---

## Cover claim

Verify:

- eligible organiser can claim
- one organiser becomes current
- stale second claim fails cleanly
- all tracked outstanding cover/start messages update after the claim
- `Claim Event` components disappear from resolved messages

If testing near event start, verify:

```text
after start but before end
    -> claim may still succeed

after event end
    -> claim is rejected
```

Also verify where practical:

```text
T+0 urgent alert
    -> older general-cover message becomes superseded
    -> older Claim Event button disappears

event cancellation
    -> outstanding Claim Event buttons disappear

automatic completion
    -> outstanding Claim Event buttons disappear
```

---

## DM fallback

Where practical test with a user who cannot receive the bot's DM.

Verify fallback to the configured Event Administration channel.

Also test the server setting that skips DM-first delivery entirely.

---

## Safety deadline

With short development timing:

- leave nominee unresolved
- allow safety deadline to arrive
- verify general cover becomes authoritative
- verify old nominee flow does not continue incorrectly

---

## Late publication

Publish an event after its safety deadline.

Verify the dormant primary is not given a fresh obsolete normal response window.

---

# Preset Manual Test

When preset administration changes, use a disposable preset and fresh events.

## Create and inspect

Verify:

```text
/role-preset create
/role-preset option-add
/role-preset group-add
/role-preset show
/role-preset list
```

Check:

- option IDs
- group IDs
- qualification display
- mapping display
- active/inactive status
- timing display
- channel behaviour

---

## Apply

Use a fresh future event.

Verify:

```text
/role-preset apply
```

creates expected event-level:

- role options
- qualification rules
- groups
- mappings
- opening plans
- closing plans

Do not reuse the same event for a second successful application of the same preset when testing unrelated scenarios, because successful application is intentionally idempotent.

---

## Parent lifecycle

Deactivate the preset.

Verify:

- default list hides it where intended
- include-inactive listing shows it
- details remain intact
- application is rejected
- reactivation restores availability
- repeated same-state command reports no change

---

## Option lifecycle

Deactivate an option.

Verify:

- option remains visible as inactive
- qualification rows remain
- mappings remain
- existing applied event is unchanged
- fresh application excludes the option where configuration remains valid

If it was the last active option in an active group:

- warning identifies the affected group
- application rejects the invalid graph
- reactivating or otherwise repairing configuration restores validity

---

## Group lifecycle

Deactivate a group.

Verify:

- group remains visible as inactive
- mappings remain
- fresh application omits that group
- previously-applied event is unchanged

Reactivate it.

Apply to a second fresh event.

Verify the group appears again using its preserved mappings.

---

# Role-Request Manual Test

## Shared role pool

Create two groups displaying the same event role.

Request the role through one.

Verify the second group and organiser view reflect the same logical request.

---

## Multi-select

Request several roles from the same member.

Verify all remain stored.

---

## Duplicate click

Press one already-requested role again.

Verify it does not withdraw the request.

---

## Manage My Requests

Withdraw one role.

Verify unrelated roles remain.

Re-request it and confirm it now occupies a new request position.

---

## Qualification

Use members representing:

- fully qualified
- supervision required
- unqualified

Verify expected request eligibility and organiser display.

---

## Signup gating

Test:

- Attending
- Tentative
- Not Attending
- no signup

against both signup-required and non-signup-required groups.

---

# Scheduled Role-Request Opening Manual Test

Test the publication modes separately.

## Published event

For a preset-derived group due shortly:

1. apply the preset to a published future event
2. confirm `/event role-group-list` shows it as Planned
3. allow opening time to arrive
4. confirm Discord message appears
5. verify lifecycle becomes Open
6. verify notification role is pinged only on initial opening
7. verify scheduled closing remains correct

If Discord publication fails because the destination is unavailable, verify persistent group state is not deleted.

---

## Manual-held unpublished event

Create an unpublished event with no scheduled publication time.

Apply a preset containing a group which becomes due while the event remains unpublished.

Verify:

```text
opening time arrives

no Discord role-request message appears

event remains unpublished

group remains stored
```

Then manually publish the event.

Verify:

```text
main event publishes

already-due group wakes

role-request message appears shortly afterwards
```

A future role-request group must retain its original opening time rather than posting immediately.

---

## Intentional pre-publication group

Create an event with explicit future scheduled publication.

Configure a role group to open earlier than that publication.

Verify:

```text
role group opening arrives
    -> role group posts

event publication still future
    -> main event remains unpublished

scheduled publication arrives
    -> main event publishes
```

This protects the intended early-command-request workflow.

---

## Overdue event publication

Automated integration coverage is preferred for this failure mode.

If the main event's scheduled publication time has passed but the event is still unpublished, later automatic role groups must wait rather than leaking out independently.

Do not deliberately manufacture Discord outages merely to repeat this case manually when deterministic automated coverage already protects it.

---

# Event-Time Edit Manual Test for Role Groups

For an event with future preset-derived groups:

1. note current open and close times
2. edit event start time
3. inspect group lifecycle again

Verify:

- future planned opening moved
- close moved
- already-open group was not re-planned
- manual immediate group did not acquire a synthetic opening schedule
- closed group remained closed

---

# Message Recovery Manual Test

## Attendance message

Delete the public attendance/event message.

Trigger a normal refresh path.

Verify:

- replacement is created in the same authoritative channel
- event state remains intact
- normal ping roles are not notified again
- new linkage becomes authoritative

---

## Role-request group

Delete an active role-request message.

Trigger a refresh path.

Verify:

- replacement is created
- role requests remain
- group configuration remains
- notification role is not re-pinged

---

## Deleted destination channel

Where practical in the development server, delete or temporarily remove the configured destination.

Verify the bot does not silently recreate the message in an unrelated default channel.

---

# Reminder Manual Test

Test:

```text
/event reminder-add
/event reminder-edit
/event reminder-list
/event reminder-remove
```

For a near-term reminder verify:

- scheduled time
- channel
- content
- ping behaviour
- actual send

For an edited event verify pending reminder timing follows the changed reference.

---

# Announcement Manual Test

Use:

```text
/event announce
```

Verify:

- expected destination
- expected notification behaviour
- event lifecycle remains unchanged

An announcement is not publication.

---

# Actual Attendance Manual Test

Use:

```text
/attendance record
/attendance add
/attendance remove
/attendance compare
/attendance user
/attendance issues
```

Verify:

- record replaces the full attendance set
- individual edits preserve unrelated rows
- signup comparison categories are sensible
- no-signup events do not create fake reliability issues
- history filters work where relevant

---

# Audit Manual Test

After several administrator operations:

```text
/audit recent
```

Verify:

- correct actor
- useful action name
- correct target
- sensible outcome
- automated actions use system attribution where appropriate

Where Discord audit mirroring is disabled, database audit behaviour should continue.

---

# Scheduler Restart Smoke Test

Where a scheduler change warrants it:

1. create a durable action due shortly
2. stop the bot before execution
3. restart the bot
4. confirm the action still runs

Useful candidates include:

- scheduled publication
- attendance closure
- event completion
- reminder
- organiser timeout
- organiser safety deadline
- role-request group opening
- role-request group closing

The purpose is to confirm that important future work is database-backed rather than tied to one process lifetime.

---

# Do Not Manually Race What Can Be Tested Deterministically

Scenarios such as:

```text
click confirmation at exactly the same millisecond as timeout
```

are poor manual regression tests.

If the race is representable through PostgreSQL or a controlled mocked Discord boundary, keep permanent coverage in the automated suite.

Manual races are useful only as supplementary smoke tests.

---

# Full Deployment Smoke Checklist

After a substantial deployment, choose the relevant subset of this checklist.

- [ ] Bot starts successfully
- [ ] Migrations complete successfully
- [ ] Database connectivity works
- [ ] Slash commands are registered
- [ ] `/setup status` works
- [ ] Immediate event creation works
- [ ] Unpublished event creation works
- [ ] Scheduled publication works
- [ ] Manual early publication does not duplicate
- [ ] Cancellation prevents later publication
- [ ] Signup responses work
- [ ] Automatic signup closure works
- [ ] Manual close/reopen works
- [ ] No-signup event works
- [ ] Event editing refreshes presentation
- [ ] Primary organiser confirmation works
- [ ] Primary decline activates backup
- [ ] Organiser timeout escalation works
- [ ] General cover can be claimed
- [ ] Organiser warning reconciles after resolution
- [ ] Organiser safety deadline behaves correctly
- [ ] DM-first organiser delivery works
- [ ] Event Administration fallback works
- [ ] Role option can be created
- [ ] Role-request group can be posted
- [ ] Shared role pool works
- [ ] Multi-role requests work
- [ ] Duplicate click does not withdraw
- [ ] Request withdrawal works
- [ ] Qualification rules work
- [ ] Supervision-required status is visible
- [ ] Signup gating works
- [ ] Scheduled role-group opening works
- [ ] Scheduled role-group closing works
- [ ] After-start closing works
- [ ] Preset can be created and inspected
- [ ] Preset can be applied to a fresh event
- [ ] Parent preset lifecycle works
- [ ] Preset option lifecycle works
- [ ] Preset group lifecycle works
- [ ] Reminder scheduling works
- [ ] Immediate announcement works
- [ ] Actual attendance can be recorded
- [ ] Attendance comparison works
- [ ] No-signup event avoids discrepancy calculations
- [ ] `/audit recent` works
- [ ] Attendance message recovery works where tested
- [ ] Role-request message recovery works where tested

Not every deployment requires every item.

Use the checklist according to the subsystem changed.

---

# When to Run the Full Suite

Run the full automated verification gate before:

- opening a normal feature PR
- opening a reliability PR
- merging a substantial refactor
- deploying a meaningful domain change
- completing schema work
- declaring a concurrency fix finished
- completing a new reusable service boundary

Run:

```bash
npm run test:unit
npm run test:integration
npm run test:coverage
npm run typecheck
npm run typecheck:test
```

Then:

```bash
git diff --check
```

---

# When a Documentation-Only Change Does Not Need Everything

A documentation-only change normally does not require Testcontainers to be started solely for ceremony.

For documentation changes:

- review links
- verify command names against definitions
- verify scripts against `package.json`
- check Markdown formatting
- use `git diff --check`

If documentation changes accompany production code, use the production-code test requirements.

---

# Coverage Expectations

Coverage is a diagnostic tool, not a target to game.

Do not add meaningless assertions merely to increase a percentage.

A meaningful uncovered branch in:

- cancellation
- ownership
- scheduler retries
- recovery
- feature disable
- preset application
- organiser escalation

is more important than several uncovered formatting lines.

Use the combined report to identify risk, then add tests that protect behaviour.

---

# Testing New Features

For a new feature, ask these questions before implementation.

## Domain

What state is authoritative?

What states are valid?

What transitions are final?

What is optional?

---

## Persistence

Which rows are created or changed?

What must happen atomically?

What survives deletion of a Discord message?

---

## Concurrency

What can race with this action?

Which row owns ordering?

Which lock order already exists?

Can a stale read later perform an invalid write?

---

## Scheduler

Does this create future work?

Does that work survive restart?

How is it cancelled?

How is it rescheduled?

Can a stale worker overwrite newer state?

---

## Discord

What happens if:

- message send succeeds but DB linkage loses a race
- message fetch says deleted
- channel is gone
- role is gone
- API request fails transiently
- permission changed

---

## Idempotency

What happens if:

- command is retried
- scheduler runs twice
- button is clicked twice
- administrator requests the state already stored

---

## Snapshot behaviour

If reusable configuration changes later, should the existing event change?

If the answer is no, prove the snapshot boundary in tests.

---

# Bug Reporting

When reporting a problem, include as much of the following as practical:

- command or button used
- event ID
- preset ID where relevant
- preset option/group ID where relevant
- event role-option ID where relevant
- role-request group ID where relevant
- reminder ID where relevant
- approximate time
- expected behaviour
- actual behaviour
- whether it reproduces
- relevant error output
- relevant Discord screenshot where useful
- local branch/commit where useful for development
- targeted test output if a regression has already been created

Do not post:

- Discord bot tokens
- database passwords
- complete private connection strings
- hosting secrets
- other credentials

---

# Debugging From Local Development Output

During active development, local repository and test output may be newer than the public GitHub branch.

If local behaviour conflicts with publicly visible source:

1. confirm current local branch
2. run `git status`
3. inspect local diff
4. treat local pasted source/test output as authoritative for the unpushed change
5. do not "fix" code merely because GitHub has not received the latest commit

This is particularly important during regression-first work.

---

# Useful Git Checks

Before committing:

```bash
git status --short
git diff --check
git diff
```

After staging:

```bash
git diff --cached
```

These checks catch:

- accidental files
- whitespace errors
- unintended edits
- missing new tests
- stale debugging changes

---

# Commit and PR Testing Practice

Prefer small coherent commits.

Examples:

```text
feat: add preset metadata editing

fix: reconcile organiser warning after timeout

feat: manage preset request group lifecycle
```

Do not combine unrelated reliability, feature, and formatting work merely because all tests are green.

A PR should describe:

- behaviour added or fixed
- important invariants
- relevant race handling
- tests added
- manual smoke testing performed
- deliberately deferred work

---

# Current High-Value Regression Areas

The suite already contains substantial coverage in these areas and future changes should preserve it:

- event lifecycle stale writes
- cancellation finality
- attendance close/reopen races
- event edit/cancel races
- automatic completion races
- publication concurrency
- scheduled publication
- scheduler claims
- retry backoff
- attempt exhaustion
- stale processing recovery
- stale worker completion
- authoritative rescheduling
- attendance interaction races
- role-request eligibility
- role-request withdrawal races
- scheduled role-request opening
- role-request closing
- role-request publication
- role-request message recovery
- attendance message recovery
- organiser confirmation and decline
- organiser warning reconciliation
- organiser timeout
- backup escalation
- general cover
- cover ownership races
- organiser feature disable races
- organiser safety deadlines
- late publication
- event-time organiser rescheduling
- reusable preset creation
- preset application
- preset lifecycle
- preset guild isolation
- preset child ownership

This list is representative rather than an exhaustive test catalogue.

---

# Expectations for Immediate Future Preset Editing

The next production feature area is editing existing reusable role-request presets.

Each database mutation should receive direct integration coverage.

Expected test dimensions include:

```text
success
unchanged/no-op
guild isolation
child ownership
inactive parent remains editable
invalid final configuration
transaction rollback
snapshot independence
application/edit concurrency
```

For qualification-role replacement, test:

- full replacement
- duplicate role rejection
- conflicting qualification levels
- `@everyone` rejection
- qualified-only option left with no qualification role
- rollback if any new mapping is invalid

For group-option mapping changes, test:

- order
- duplicate option rejection
- foreign-preset option
- inactive option handling
- empty active group policy
- transaction rollback

For metadata edits, test:

- unchanged timestamps
- name uniqueness
- empty/invalid values
- inactive preset edit

Discord command tests should then verify only the adapter concerns on top.

---

# Testing Expectations for Future Templates

Before templates are considered complete, coverage should establish:

- template ownership
- template lifecycle
- generated event creation
- dormant organiser snapshots
- role-request preset snapshots
- reminder snapshots
- publication scheduling
- event independence after generation
- later template edit does not mutate existing event
- rollback on failed generation
- no duplicate side effects

Use the existing `createStoredEvent()` boundary rather than testing template generation by simulating a Discord command where possible.

---

# Testing Expectations for Future Recurrence

Recurring generation will require especially strong integration coverage.

Test:

- recurrence calculation
- timezone handling
- daylight-saving transitions
- rolling generation horizon
- idempotent repeated generation
- concurrent generators
- immutable occurrence identity
- moved occurrence not regenerated
- cancelled occurrence not regenerated
- template disable
- template recurrence edit
- already-generated event independence

Avoid using the current mutable event `startsAt` as the only occurrence identity in either implementation or tests.

---

# What "Ready" Means

A change is normally ready for PR review when:

```text
Targeted regression/feature tests are green

Affected subsystem tests are green

Unit suite is green

Integration suite is green

Combined coverage run completes

Production typecheck is green

Test typecheck is green

Relevant manual Discord smoke test is complete

git diff --check is clean

Documentation is updated where behaviour or decisions changed
```

Not every tiny documentation or comment edit requires the entire process.

Any meaningful lifecycle, scheduler, organiser, persistence, role-request, or preset change generally does.

---

# Final Rule

When a test appears inconvenient because a new implementation breaks it, determine what the test is protecting before changing the assertion.

Many tests in this repository exist because the simpler behaviour was tried already and failed under a race or lifecycle edge case.

A green suite is useful only when it still protects the intended domain.
