# Testing Guide

**Last updated:** 28 August 2026

This document describes the recommended automated and manual testing workflow for the Holdfast Event Bot.

It is intended for:

- Development testing
- Automated regression testing
- Regression testing after substantial changes
- Community/public-test deployments
- Reproducing reported bugs
- Collaborators reviewing the event lifecycle

Automated tests provide repeatable coverage of domain, database, lifecycle and concurrency behaviour.

Manual Discord-level testing remains important for end-to-end workflows, presentation, permissions and behaviour which depends on the real Discord API.

Neither approach replaces the other.

For normal administrator command documentation, see [`ADMIN-GUIDE.md`](./ADMIN-GUIDE.md).

For implementation and design context, see:

- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`DECISIONS.md`](./DECISIONS.md)
- [`ROADMAP.md`](./ROADMAP.md)
- [`CURRENT-WORK.md`](./CURRENT-WORK.md)

---

# General Testing Principles

When testing a workflow, record the event ID.

Where relevant, also record:

- Role-option IDs
- Role-request group IDs
- Reminder IDs
- Approximate time the action occurred

These identifiers make database and audit-log investigation substantially easier.

Whenever possible, manual testing should use:

- A dedicated development Discord server
- A development Discord bot/application
- A development PostgreSQL database

Avoid using production/community data for destructive development testing.

Automated integration tests must use the dedicated integration-test database environment and must never be pointed at a production or community database.

---

# Automated Testing

The repository includes automated unit and PostgreSQL integration tests.

The current automated-testing stack uses:

- Vitest
- TypeScript
- PostgreSQL
- Testcontainers
- Docker for the disposable PostgreSQL integration environment
- V8 coverage through `@vitest/coverage-v8`

Automated testing is intended to cover behaviour which can be reproduced deterministically without relying on the live Discord service.

This is particularly valuable for:

- Domain rules
- Database persistence
- Event lifecycle transitions
- Scheduler behaviour
- Idempotency
- Retry behaviour
- Attendance eligibility
- Role-request eligibility
- Organiser assignment/escalation
- Concurrency and stale-state races

Real Discord/network side effects may be mocked where appropriate while PostgreSQL state remains real.

---

# Automated Test Commands

The main test commands are:

```text
npm run test:unit
npm run test:integration
npm run test:coverage
npm run typecheck
npm run typecheck:test
```

Use:

```text
npm run test:unit
```

for fast unit tests which do not require PostgreSQL.

Use:

```text
npm run test:integration
```

for PostgreSQL-backed integration tests.

Use:

```text
npm run typecheck
```

for production TypeScript checking.

Use:

```text
npm run typecheck:test
```

for test TypeScript checking.

These checks are deliberately separate so test-specific TypeScript configuration does not weaken or obscure production checking.

---

# Unit Tests

Unit tests should be preferred for behaviour which:

- Is deterministic
- Does not require PostgreSQL
- Does not depend on Discord state
- Can be tested through a small input/output boundary

Examples include:

- Timezone utilities
- Pure date/time calculations
- Formatting helpers
- Small domain transformations

Do not involve PostgreSQL merely to make a test look more realistic when the behaviour is genuinely isolated.

---

# PostgreSQL Integration Tests

Integration tests should be preferred where behaviour depends on:

- Real PostgreSQL constraints
- Transactions
- Conditional updates
- `ON CONFLICT`
- Row locking
- Scheduler persistence
- Multiple related database tables
- Lifecycle ownership
- Concurrency behaviour

The integration suite uses a disposable PostgreSQL instance through Testcontainers.

The integration database is reset between tests so individual tests should not depend on data created by earlier tests.

Tests should create only the domain state they actually require.

---

# Integration Database Safety

The integration test harness includes safeguards intended to prevent accidental execution against a real application database.

Do not bypass these guards merely to make a local test run.

Integration tests should operate only against the disposable Testcontainers PostgreSQL environment.

If the integration suite refuses to run because it considers the database unsafe, investigate the environment/configuration instead of weakening the protection.

The database is authoritative during integration tests.

Mocks should not replace PostgreSQL behaviour when the behaviour under test is specifically about persistence, transactions, constraints or concurrency.

---

# Regression-First Bug Fixing

When a concrete production bug or reliability problem can be reproduced automatically, prefer this workflow:

```text
Reproduce bug
    |
    v
Write regression test
    |
    v
Confirm test fails for the expected reason
    |
    v
Commit failing regression
    |
    v
Implement production fix
    |
    v
Confirm regression becomes green
    |
    v
Run related tests
    |
    v
Run full test/typecheck suite
```

The failing regression should normally be committed separately from the production fix.

This preserves evidence that:

- The test genuinely reproduced the bug
- The production change genuinely fixed it
- The test was not written only after the implementation already behaved correctly

Do not weaken a regression test merely because production currently fails it.

First confirm that the failure represents the intended bug.

---

# Concurrency Regression Tests

Lifecycle-sensitive code frequently involves stale reads or competing database operations.

Do not test concurrency by relying primarily on arbitrary delays such as:

```text
sleep 100ms
```

Timing-dependent tests are fragile and may pass or fail depending on machine load.

Prefer deterministic PostgreSQL barriers.

Useful techniques include:

- `SELECT ... FOR UPDATE`
- Explicit transactions
- Relation locks
- Inspecting PostgreSQL lock state
- Blocking a specific authoritative write
- Releasing that write only after the competing operation has completed

A useful race test usually establishes an ordering such as:

```text
Handler reads old state
        |
        v
Handler reaches authoritative write
        |
        v
BLOCKED
        |
        v
Competing operation commits newer state
        |
        v
Release blocked handler
        |
        v
Handler must respect newer state
```

The test should assert both:

1. The correct final database state
2. The absence of stale success side effects

Where appropriate, also verify:

- No stale audit record
- No stale scheduler mutation
- No Discord refresh
- No success response
- No duplicate assignment/message/request

---

# Database Ownership Boundaries

For lifecycle-sensitive operations, an early read is useful for fast validation but should not automatically be treated as authoritative for a later write.

Where the implementation uses a database row as an ownership/concurrency boundary, tests should verify that competing operations respect that ordering.

A common pattern is:

```text
Initial read
    |
    v
Acquire authoritative row lock
    |
    v
Re-check current state
    |
    +---- valid
    |       |
    |       v
    |    persist
    |
    +---- stale
            |
            v
         reject
```

Current organiser ownership flows, for example, use the event row as a shared ordering boundary where appropriate.

Tests should validate the domain guarantee rather than merely the SQL syntax used to implement it.

---

# Positive Companion Tests

After fixing a regression, add or retain a positive companion test where useful.

A race fix should not accidentally make the legitimate workflow impossible.

Examples:

```text
Cancellation wins race
    -> stale write rejected

Normal active event
    -> legitimate write succeeds
```

or:

```text
Attendance eligibility changes
    -> stale role request rejected

Eligible member remains Tentative
    -> role request succeeds
```

Positive controls are especially important after adding:

- Conditional writes
- Transactions
- Locks
- Additional eligibility predicates
- Scheduler fences

---

# Mocking Guidelines

Mocks are appropriate for boundaries which are not the subject of the test.

Typical examples include:

- Discord message edits
- Discord message sends
- Organiser DMs
- Attendance-message refresh calls
- Other external Discord interactions

Prefer real PostgreSQL state for:

- Events
- Attendance responses
- Role requests
- Organiser assignments
- Scheduled actions
- Audit logs
- Transaction/concurrency behaviour

A test for database correctness should not succeed merely because a mocked repository or service was instructed to return the desired answer.

---

# Targeted Test Workflow

During development, run the smallest relevant test first.

Example:

```text
npm run typecheck:test
npm run test:integration -- tests/integration/interactions/organiser-button.test.ts
```

This provides faster feedback while developing a focused fix.

Once the relevant tests pass, run the full verification set:

```text
npm run test:unit
npm run test:integration
npm run typecheck
npm run typecheck:test
```

Before opening a pull request, the full relevant suite should be green.

---

# Test Commits and Pull Requests

For a known regression, the preferred commit sequence is:

```text
test: capture <bug>
fix: <production correction>
test: <positive/additional coverage>
```

Exact commit wording is not important, but the history should make the reasoning understandable.

A pull request should normally group one coherent reliability/domain area rather than creating a separate PR for every individual test.

Examples of coherent scopes include:

- Scheduler retry reliability
- Attendance interaction races
- Role-request interaction races
- Organiser interaction/escalation races
- Discord message recovery

Avoid combining unrelated feature work merely because all changes involve tests.

---

# Manual Discord Testing

Automated tests do not replace end-to-end Discord testing.

Manual testing remains particularly useful for:

- Slash-command registration
- Discord permissions
- Message presentation
- Button behaviour
- Channel visibility
- Role mentions
- DM delivery/fallback
- Real Discord API failures
- Overall administrator/member workflow

The following sections describe the recommended manual workflow.

---

# Core Event Workflow

## 1. Create the event

Use:

```text
/event create
```

Test each major publication mode separately.

### Immediate publication

Create an event which publishes immediately.

Confirm that:

- The event is created
- The public message appears in the expected channel
- The configured ping roles are shown
- Sign-up controls appear when signups are enabled
- No signup controls appear when signups are disabled
- Event times are correct
- Event ID is returned
- `/event list` shows the event appropriately

### Scheduled publication

Create an unpublished event with automatic publication configured.

Confirm that:

- No public event message is posted immediately
- The event receives an ID
- `/event list` shows the future publication time
- The scheduled publication time is correct
- The event can be edited before publication
- The event publishes automatically at the expected time

### Manual publication

Create an event which remains unpublished.

Confirm that:

- No public event message appears
- The event exists in `/event list`
- The event can be configured before publication
- `/event publish` later posts the event correctly

---

# Unpublished Event Preparation

Before publishing a test event, verify that unpublished events can still be used for administrative preparation.

Test as relevant:

```text
/event organiser-set
/event organiser-clear
/event role-option-add
/event role-option-list
/event role-group-post
/event role-group-list
/event role-group-close
/event role-requests
/event edit
/event cancel
```

The absence of a normal public attendance message should not cause unrelated administrative commands to fail merely because they expect an `event_messages` record.

Commands which genuinely require a public event message should fail clearly and intentionally.

---

# Scheduled Publication Tests

Scheduled publication is lifecycle-sensitive and deserves explicit regression testing.

## Normal automatic publication

Create an event scheduled to publish a few minutes in the future.

Confirm:

1. The event remains unpublished before its due time.
2. The scheduler publishes it at approximately the expected time.
3. Only one public event message is created.
4. `publishedAt` behaviour is reflected correctly through commands/UI.
5. `/event list` no longer shows a future publication countdown after publication.
6. Signup controls are available where expected.
7. Organiser activation begins at publication where configured.

---

## Manual early publication

Create an event with automatic publication scheduled.

Before the publication time, run:

```text
/event publish
```

Confirm:

- The event publishes immediately
- The scheduled publication does not later produce a second message
- `/event list` shows the event as published
- Organiser confirmation begins only once

---

## Cancel before publication

Create an automatically scheduled unpublished event.

Before its publication time, run:

```text
/event cancel
```

Confirm:

- The event is marked Cancelled
- `/event list` displays Cancelled rather than Unpublished
- `/event list` does not continue displaying a publication countdown
- No public event message appears when the old publication time passes
- No publication occurs later before the event starts
- Relevant scheduled actions have been made harmless/cancelled

This scenario is particularly important because a stored historical publication offset may still exist on the event even though the publication action has been cancelled.

---

## Edit publication timing

For an unpublished event with scheduled publication:

1. Change the event start time.
2. Confirm the publication time moves while preserving its configured relative offset.
3. Change `publish-minutes-before-start`.
4. Confirm the publication action is rescheduled.
5. Use `clear-publish-schedule`.
6. Confirm automatic publication no longer occurs.

Also verify invalid schedules are rejected where publication would occur:

- In the past
- At or after signup closure
- After the event has started

---

# Attendance Signup Workflow

For a normal signup-enabled event:

1. Publish the event.
2. Respond from test accounts/users as:
   - Attending
   - Tentative
   - Not Attending

3. Run:

```text
/event responses
```

Confirm each member appears in the correct group.

Where practical, change responses and confirm the previous state is replaced rather than duplicated.

---

# Signup Closure

## Automatic closure

Create an event with a near-term signup closing time.

Confirm:

- Buttons work before closure
- The scheduler closes attendance at the configured time
- The public message updates
- Attendance controls become unavailable/disabled as intended
- `/event list` reflects the correct state

---

## Manual closure

Use:

```text
/event close
```

Confirm:

- Attendance closes immediately
- The scheduled automatic closure becomes harmless
- The public message refreshes
- Existing attendance responses remain stored

---

## Reopening

For a future published event, use:

```text
/event reopen
```

Confirm:

- Attendance returns to Open
- The new closure time is correct
- A new/updated scheduled close action exists conceptually
- Buttons become usable again

Also confirm:

- Cancelled events cannot be reopened
- Completed events cannot be reopened
- Past events cannot be reopened

---

# No-Signup Event Workflow

Create an event with attendance sign-ups disabled.

Confirm:

- No Attending/Tentative/Not Attending controls appear
- No attendance closing deadline is required
- `/event responses` or signup-specific commands behave appropriately
- Actual attendance can still be recorded
- Historical signup discrepancy reporting ignores the event
- Organiser functionality can still operate
- Relevant role-request workflows can still operate

This test is important because older code paths may still incorrectly assume every event has:

```text
signupsEnabled = true
```

or an attendance closing timestamp.

---

# Event Editing

Create a published event and test editing:

- Name
- Description
- Date
- Time
- Timezone
- Duration
- Signup deadline
- Detailed deadline display
- Ping roles

Confirm that:

- Database-backed state changes
- Public Discord message refreshes
- Relevant scheduler actions are rescheduled
- Supplying ping roles replaces the current role set rather than appending to it

For unpublished events, also test:

- Publication offset
- Clearing publication schedule
- Moving the event while publication remains scheduled

---

# Event Cancellation

Test cancellation for both:

- Published events
- Unpublished events

For a published event, confirm:

- Status becomes Cancelled
- Public controls become unavailable
- Existing signup data remains
- Role-request state is appropriately refreshed
- Automatic completion does not later overwrite cancellation

For an unpublished event, confirm:

- No public event message is required
- Pending publication is cancelled
- `/event list` displays Cancelled correctly
- No later scheduler action publishes the event

---

# Event Completion

Create a short-duration test event where practical.

Allow its completion action to run.

Confirm:

- Status becomes Completed
- Cancellation is never overwritten by completion
- Outstanding publication/attendance-close actions are made obsolete where appropriate
- Organiser escalation actions no longer continue
- Role-request messages reflect completed state where relevant

---

# Organiser Workflow

## Primary organiser

Create an event with a Primary Organiser.

For immediate publication, confirm:

- The organiser receives the confirmation prompt
- The countdown begins only after publication
- Public organiser state is displayed

For an unpublished event, confirm:

- The organiser assignment exists
- No confirmation request is sent before publication
- No response countdown begins before publication
- Publication activates the organiser

---

## Direct-message fallback

Where practical, use a member/test account which cannot receive the bot's DM.

Confirm:

- Direct-message delivery fails safely
- The request appears in the configured private Event Administration channel
- The assignment remains usable

---

## Primary confirmation

Confirm the Primary Organiser.

Check:

- Assignment becomes confirmed
- Timeout/escalation does not later activate the backup
- Public organiser information refreshes as expected

---

## Primary decline

Decline the Primary Organiser request.

If a Backup Organiser exists, confirm:

- Primary becomes declined/inactive
- Backup becomes active
- Backup receives their own confirmation request
- Backup response deadline is independently calculated

---

## Primary timeout

Allow a Primary Organiser to remain unanswered.

Confirm:

- Warning occurs at the configured time where enabled
- Timeout occurs
- Backup activates where configured
- Audit history records the transition

---

## Backup decline or timeout

Allow the Backup Organiser to decline or time out.

Confirm:

- Backup no longer remains active
- Cover-request workflow begins
- Configured Event Organiser role receives the appropriate request where possible

---

## Cover claim

Use an eligible member to select:

```text
Claim Event
```

Confirm:

- Claim succeeds
- Cover organiser becomes the current organiser
- Competing/stale claims do not create several active organisers
- Claiming after the event begins is rejected where intended

---

# Organiser Administrative Commands

Test:

```text
/event organiser-set
/event organiser-clear
```

Scenarios should include:

- Assign Primary
- Assign Backup
- Replace Primary
- Replace Backup
- Clear Primary
- Clear Backup
- Configure while unpublished
- Configure after publication
- Attempt to assign a bot account
- Attempt invalid Primary/Backup combinations

The event creator should not silently become organiser unless explicitly assigned.

---

# Role Option Configuration

Use:

```text
/event role-option-add
```

Test:

- Open role
- Qualified-only role
- Full qualification role
- Supervision-required qualification role

Then use:

```text
/event role-option-list
```

Confirm role-option IDs and qualification information are correct.

---

# Role-Request Group Workflow

Create at least two logical event roles, then create one or more groups with:

```text
/event role-group-post
```

Test variations including:

- Different Discord channels
- Different role combinations
- Signup required
- Signup not required
- Notification role
- Closing before start
- Closing at start
- Closing after start

---

# Shared Role Pool Test

This is an important domain regression test.

Create:

```text
Group A:
    Captain

Group B:
    Captain
    Carpenter
```

Both groups must reference the same event-level Captain role option.

Request Captain through Group A.

Confirm:

- Group B reflects the same Captain request
- `/event role-requests` shows one Captain request, not two
- Repeated clicking in Group B does not create another request

The system must not accidentally treat group-specific appearances as separate logical roles.

---

# Multi-Role Request Test

From the same member, request several roles.

For example:

```text
Captain
Carpenter
Gunboat Gunner
```

Confirm:

- All requests coexist
- No previous request is replaced
- `/event role-requests` displays all relevant roles

Role requests are independent, not ranked preferences.

---

# Duplicate Request Test

Click a role which the member has already requested.

Confirm:

- The original request remains
- No duplicate database request is created
- The request is not withdrawn
- The member receives a clear informational response

---

# Manage My Requests

Use the member-facing:

```text
Manage My Requests
```

workflow.

Confirm:

- Current requests are shown
- Withdrawal is explicit
- Withdrawing one role does not remove unrelated role requests

Then request the withdrawn role again.

Confirm the new request is treated as a new request and appears later in request order.

---

# Qualification Tests

For a qualified-only role, test members with:

## Full qualification

Confirm:

- Request is accepted
- Organiser view shows Qualified

## Supervision-required qualification

Confirm:

- Request is accepted where intended
- Organiser view clearly identifies supervision requirement

## No qualifying role

Confirm:

- Request is rejected
- No database request is created

Qualification logic should depend on configured Discord role IDs rather than hardcoded community role names.

---

# Signup-Gated Role Requests

Create a group requiring positive signup.

Test members currently marked as:

- Attending
- Tentative
- Not Attending
- No signup

Expected behaviour:

```text
Attending
    -> may request

Tentative
    -> may request

Not Attending
    -> may not add new request through signup-gated group

No signup
    -> may not add new request through signup-gated group
```

Then create a group which does **not** require signup.

Confirm the intended early/no-signup workflow remains available.

---

# Role Requests and Attendance Changes

Where supported by the current implementation, verify interaction between existing requests and attendance state.

Desired semantics are:

```text
Attending
    -> active volunteer

Tentative
    -> active but visibly tentative

Not Attending
    -> request retained
    -> currently unavailable

No signup
    -> may remain valid where the relevant workflow allowed it
```

Changing to Not Attending should not silently delete the member's existing role request.

Changing back to Attending should reactivate the original request without resetting its original request time.

Relevant role-request views should refresh when attendance state changes.

If this behaviour is not yet fully implemented, record it as a known roadmap item rather than treating the current absence as an unrelated test failure.

---

# Role-Request Closing

## Automatic close before start

Configure a group to close shortly before event start.

Confirm:

- Requests work before closure
- Scheduler closes the group
- Buttons become unavailable
- Group view refreshes appropriately

## Close at start

Configure zero-minute offset.

Confirm closure occurs around event start.

## Close after start

Configure the supported after-start option.

Confirm:

- Requests remain available after the event starts
- Closure occurs at the configured later time

## Manual close

Use:

```text
/event role-group-close
```

Confirm:

- Group closes immediately
- Future scheduled close action becomes harmless
- Existing requests remain available to organisers

---

# Role-Request Administrative View

Use:

```text
/event role-requests
```

Confirm the organiser/admin view correctly shows, where applicable:

- Role
- Request order
- Qualification
- Supervision requirement
- Other roles requested
- Attendance state
- Suitable signed-up fallback members

For early/no-signup groups, ensure the bot does not attempt to enumerate huge numbers of unrelated guild members merely because they hold a qualifying Discord role.

---

# Reminders

## Add reminder

Use:

```text
/event reminder-add
```

Test reminders relative to:

- Signup closure
- Event start

Confirm:

- Scheduled time is correct
- Destination channel is correct
- Message is correct
- Notification-role behaviour is correct

---

## Edit reminder

Use:

```text
/event reminder-edit
```

Change one or more properties.

Confirm the scheduled action reflects the new timing.

---

## List reminders

Use:

```text
/event reminder-list
```

Confirm current reminder state is displayed correctly.

---

## Remove reminder

Use:

```text
/event reminder-remove
```

Confirm the reminder cannot later be sent.

---

## Missed reminder

Where practical, create a condition where a reminder's useful reference point has already passed before execution.

Confirm:

- The reminder is not sent misleadingly late
- It is recorded as missed
- Audit information explains what happened

---

# Immediate Announcements

Use:

```text
/event announce
```

Confirm:

- Message reaches the expected channel
- Event role notification behaviour matches configuration
- Announcement does not alter event lifecycle state

---

# Actual Attendance

## Record full attendance

Use:

```text
/attendance record
```

Confirm the supplied attendance list replaces the previous recorded actual attendance.

---

## Individual corrections

Use:

```text
/attendance add
/attendance remove
```

Confirm the individual change occurs without damaging unrelated attendance records.

---

# Signup vs Attendance Comparison

Set up test members representing:

1. Attending + actually attended
2. Attending + absent
3. Tentative + attended
4. Tentative + absent
5. Not Attending + attended
6. No signup + attended
7. Signup + no actual attendance record

Run:

```text
/attendance compare
```

Confirm the categories are sensible.

In particular:

- Tentative absence should be contextual rather than a normal no-show
- Not Attending + attendance should be identifiable
- No-signup walk-ins should be identifiable for signup-enabled events

---

# No-Signup Attendance Reporting

Create a no-signup event and record actual attendance.

Confirm:

- Actual attendance is stored
- The event can still be reported historically where appropriate
- It does not create signup discrepancies
- It does not contribute false walk-in/no-show reliability issues

---

# Historical Reporting

## `/attendance user`

Test:

- Member with history
- Member without history
- Event-type filter
- Date-range filter

Confirm only applicable events are included.

---

## `/attendance issues`

Create completed events with known discrepancy patterns.

Confirm:

- Only relevant completed events are considered
- Actual attendance must exist where required
- No-signup events do not create false issues

---

# Audit Trail

Use:

```text
/audit recent
```

After performing several administrative actions.

Confirm:

- Expected actions appear
- Actor is correct
- Outcome is correct
- Target/event ID is useful
- Automatic scheduler activity uses system/no-user attribution where appropriate

Also verify that disabling Discord audit mirroring does not stop database audit records from being created.

---

# Discord Message Recovery / Failure Scenarios

Where practical, manually introduce Discord-side failures.

Examples:

## Delete a public event message

Confirm:

- Database state remains intact
- Current refresh/recovery behaviour matches the documented implementation
- The event lifecycle itself is not corrupted merely because its Discord presentation message is missing

Automatic recovery/replacement is an active reliability area and should be covered by automated regression tests as it is implemented.

## Delete a role-request message

Confirm current behaviour and record whether administrative recovery is possible.

Easy repost/recovery tooling is a planned improvement if not yet implemented.

## Remove a publication channel

For a future scheduled publication, confirm:

- Publication fails safely
- Scheduler retry/failure behaviour is visible
- Event is not incorrectly marked published without a usable message

## Delete a configured ping role

Confirm publication or relevant notification fails safely rather than silently pretending the role was notified.

---

# Scheduler Restart / Recovery Testing

Where practical in local development:

1. Create a scheduled action due shortly.
2. Stop the bot before execution.
3. Restart it.
4. Confirm the action still executes.

Important candidates include:

- Event publication
- Attendance closure
- Event completion
- Reminder
- Role-request closure

The purpose is to verify that important scheduling is genuinely database-backed rather than dependent on process-local timers.

---

# Scheduler Race / Idempotency Tests

Lifecycle actions should be safe if another path reaches the desired state first.

Useful manual scenarios include:

```text
Manual publish just before automatic publish
Manual close just before automatic signup closure
Manual role-group close just before scheduled close
Cancel just before publication
Cancel just before completion
Organiser confirms near timeout
Cover claim races another claim
```

Many scheduler and interaction races are now also covered through deterministic PostgreSQL integration tests.

When a race can be reproduced reliably in the automated integration suite, prefer retaining it there as permanent regression coverage rather than depending only on manual timing.

The desired result is one coherent final state, not duplicate actions or conflicting records.

---

# Automated Reliability Coverage

The automated suite currently includes substantial regression coverage around:

- Event lifecycle stale writes
- Cancellation ownership
- Attendance close/reopen races
- Event edit/cancel races
- Automatic completion races
- Scheduler action claiming
- Stale scheduler locks
- Retry backoff
- Attempt exhaustion
- Stale success/failure attempts
- Attendance interaction lifecycle races
- Attendance eligibility changes
- Role-request group closure
- Role-request event lifecycle races
- Role-request attendance eligibility
- Role-option configuration changes
- Role-request withdrawal lifecycle races
- Organiser confirmation/decline lifecycle races
- Normal organiser confirmation
- Primary decline and backup activation
- Cover claim lifecycle races
- Cover vs backup ownership races
- Stale general-cover escalation

This list should remain representative rather than becoming an exhaustive chronological changelog.

When a new reliability-sensitive domain is added, include enough automated coverage to establish both:

- Legitimate success behaviour
- Stale/conflicting behaviour

---

# Recommended Automated Verification Before a PR

For normal TypeScript/database work, run:

```text
npm run test:unit
npm run test:integration
npm run typecheck
npm run typecheck:test
```

Where the change is focused, run the relevant test file first for faster development feedback.

For example:

```text
npm run test:integration -- tests/integration/interactions/organiser-button.test.ts
```

Use:

```text
npm run test:coverage
```

when reviewing coverage or when a change specifically warrants coverage inspection.

A documentation-only change does not normally require the full PostgreSQL integration suite unless project/CI policy requires it.

---

# Recommended Manual Regression Checklist

After a substantial deployment, at minimum verify:

- [ ] Bot starts successfully
- [ ] Database connection succeeds
- [ ] Slash commands are registered
- [ ] `/setup status` works
- [ ] Immediate event creation works
- [ ] Manual unpublished event works
- [ ] Scheduled publication works
- [ ] Manual early publication works
- [ ] Cancellation prevents scheduled publication
- [ ] Published event cancellation refreshes the message
- [ ] Signup responses work
- [ ] Automatic signup closure works
- [ ] Manual close/reopen works
- [ ] No-signup event works
- [ ] Event editing works
- [ ] Primary organiser confirmation works
- [ ] Primary decline/timeout escalates correctly
- [ ] Backup escalation works
- [ ] Cover claim works
- [ ] Role options can be created/listed
- [ ] Role-request group can be posted
- [ ] Shared role pool works across multiple groups
- [ ] Multi-role requests work
- [ ] Duplicate request does not withdraw
- [ ] Manage My Requests withdrawal works
- [ ] Qualification restrictions work
- [ ] Supervision-required state is visible
- [ ] Signup-gated group works
- [ ] Automatic role-group closure works
- [ ] After-start role-group closure works
- [ ] Reminder scheduling works
- [ ] Immediate announcement works
- [ ] Actual attendance can be recorded
- [ ] Attendance comparison works
- [ ] No-signup event is excluded from discrepancy calculations
- [ ] `/audit recent` shows expected activity

Not every deployment requires every test, but lifecycle-sensitive changes should be tested against the relevant sections above.

Automated tests should be green before deployment unless a known failing regression has deliberately been committed on a development branch as part of the regression-first workflow.

---

# Reporting Problems

When reporting a bug, include as much of the following as possible:

- Command or button used
- Event ID
- Role-option ID, if relevant
- Role-request group ID, if relevant
- Reminder ID, if relevant
- Approximate time of occurrence
- What was expected
- What actually happened
- Whether the issue can be reproduced
- Any relevant screenshot or Discord error message

Avoid posting:

- Bot tokens
- Database credentials
- Private connection strings
- Other secrets

The event ID and audit trail usually make a problem considerably easier to trace.

For the regiment's current testing deployment, use the designated:

```text
#bugs-issues
```

channel unless the testing procedure has been changed.

---

# When a Bug Is Fixed

Where practical, reproduce the original problem before applying the fix.

If the bug can be reproduced automatically, prefer:

1. Write a regression test reproducing the problem.
2. Confirm the regression fails for the expected reason.
3. Commit the failing regression separately.
4. Apply the production fix.
5. Confirm the regression becomes green.
6. Test the nearest related workflows.
7. Add or retain a positive companion test where useful.
8. Run the full relevant unit/integration/typecheck suite.

If the problem depends on Discord behaviour which cannot reasonably be reproduced in the automated harness:

1. Record the original manual reproduction steps.
2. Apply the fix.
3. Repeat those exact steps.
4. Test the nearest related workflows for regressions.
5. Add automated coverage for any domain/database portion which can still be isolated.

A bug which required meaningful investigation is usually a good candidate for permanent regression coverage.
