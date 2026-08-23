# Manual Testing Guide

This document describes the recommended manual testing workflow for the Holdfast Event Bot.

It is intended for:

- Development testing
- Regression testing after substantial changes
- Community/public-test deployments
- Reproducing reported bugs
- Collaborators reviewing the event lifecycle

This is currently a **manual testing guide**.

An automated test suite is planned separately and should eventually complement, rather than replace, these Discord-level workflow checks.

For normal administrator command documentation, see [`ADMIN-GUIDE.md`](./ADMIN-GUIDE.md).

For implementation and design context, see:

- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`DECISIONS.md`](./DECISIONS.md)
- [`ROADMAP.md`](./ROADMAP.md)

---

# General Testing Principles

When testing a workflow, record the event ID.

Where relevant, also record:

- Role-option IDs
- Role-request group IDs
- Reminder IDs
- Approximate time the action occurred

These identifiers make database and audit-log investigation substantially easier.

Whenever possible, test using:

- A dedicated development Discord server
- A development Discord bot/application
- A development PostgreSQL database

Avoid using production/community data for destructive development testing.

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
- `/event refresh` reports the missing linked message rather than corrupting event state

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

Useful tests include:

```text
Manual publish just before automatic publish
Manual close just before automatic signup closure
Manual role-group close just before scheduled close
Cancel just before publication
Cancel just before completion
Organiser confirms near timeout
Cover claim races another claim
```

The desired result is one coherent final state, not duplicate actions or conflicting records.

---

# Recommended Regression Checklist

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

After the fix:

1. Repeat the exact original reproduction steps.
2. Confirm the bug no longer occurs.
3. Test the nearest related workflows for regressions.
4. Add the scenario to automated regression coverage once an automated test suite exists.

A bug which required meaningful investigation is usually a good candidate for a permanent regression test.
