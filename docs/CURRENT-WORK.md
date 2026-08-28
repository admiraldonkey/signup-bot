# Current Development State

**Last updated:** 28 August 2026

This document is intended as a temporary handoff/checkpoint for the current state of development.

It should be updated or rewritten after major development checkpoints rather than becoming a permanent chronological changelog.

For long-term context, also read:

- [`README.md`](../README.md)
- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`DECISIONS.md`](./DECISIONS.md)
- [`ROADMAP.md`](./ROADMAP.md)

---

# Current Repository Checkpoint

The recent reliability, concurrency and automated-testing work has reached a stable checkpoint.

Several substantial development phases have now covered:

1. Event lifecycle and command race protection
2. Durable scheduler reliability, retry and stale-action behaviour
3. Attendance interaction lifecycle and eligibility races
4. Role-request interaction lifecycle and eligibility races
5. Organiser response, cover-claim and escalation concurrency

At the point this checkpoint was created:

- TypeScript checks were passing
- Automated unit and PostgreSQL integration tests were passing
- Recent regression tests had been verified against the intended race conditions before production fixes were applied
- The completed reliability work had been committed, reviewed and merged to `main`
- Local `main` had been updated to the latest merged state before beginning this documentation pass

The expected starting branch for new feature/refactor work should therefore normally be:

```text
main
```

Always verify branch state before making changes.

---

# Recently Implemented: Optional Event Sign-Ups

Events may now be created without attendance sign-ups.

No-signup events:

- Have no attendance response buttons
- Have no signup deadline
- May still have actual attendance recorded
- Do not generate false signup discrepancy statistics
- May still use organiser functionality
- May still use announcements
- May still use role-request functionality where appropriate

This is intended for events such as linebattles or announcement-style events where attendance responses are unnecessary.

---

# Recently Implemented: Event Organisers

Events may now have:

- Primary Organiser
- Backup Organiser
- Cover Organiser through escalation

Primary and Backup organisers may be selected during event creation or changed administratively later.

The event creator and event organiser are separate concepts.

---

# Recently Implemented: Organiser Confirmation

An activated organiser receives a private:

```text
Confirm
Decline
```

interaction.

Preferred delivery is by DM.

If DMs fail, the request falls back to the configured private Event Administration channel.

---

# Recently Implemented: Organiser Response Deadlines

Organiser response periods are configurable at guild level.

The bot can:

- Set a response deadline
- Warn administrators shortly before timeout
- Automatically process a timeout

These operations use the durable scheduler.

---

# Recently Implemented: Organiser Escalation

Current escalation flow:

```text
Primary Organiser
        |
        +---- confirms
        |
        +---- declines / times out
                |
                v
          Backup Organiser
                |
                +---- confirms
                |
                +---- declines / times out
                        |
                        v
                    Cover Request
                        |
                        v
             Event Organiser role
                 can Claim Event
```

Cover claims are rejected after the event begins.

---

# Recently Implemented: Organiser Assignment History

Organiser assignments are stored separately rather than simply overwriting one organiser field on the event.

This allows assignment/escalation history to be retained.

Current assignment states include concepts such as:

```text
pending
confirmed
declined
timed_out
replaced
removed
```

---

# Recently Implemented: Organiser Administration

Current administrative commands include:

```text
/event organiser-set
/event organiser-clear
```

Guild setup also includes configuration for:

- Event Organiser role
- Event Administration channel
- Primary response timing
- Backup response timing
- Warning timing

---

# Recently Implemented: Dormant Organisers on Unpublished Events

An organiser assigned to an unpublished event remains dormant.

The organiser is **not** immediately sent a confirmation request.

Their response countdown begins when the event becomes public.

This behaviour is deliberate.

---

# Recently Implemented: Event-Level Role Options

Events may now define logical requestable roles.

Examples include:

```text
Captain
Supervisor
2-Gun Gunner
Gunboat Gunner
Carpenter
```

Role names are configurable and not hardcoded into the bot.

---

# Recently Implemented: Role Qualification

Role options may currently use:

```text
open
qualified_only
```

Qualification rules can reference Discord roles.

Current qualification levels include:

```text
qualified
supervision_required
```

Example intended naval configuration:

```text
Captain

Flag Captain / equivalent
    -> qualified

Midshipman
    -> supervision required
```

A supervision-required member may still express interest in a qualified-only role.

The organiser view should indicate that supervision is required.

---

# Recently Implemented: Role Request Groups

An event can have several Discord-facing role-request groups.

Each group may define:

- Name
- Description
- Channel
- Displayed event role options
- Signup requirement
- Closing time
- Optional notification role

Example:

```text
Early Command Interest
    Captain
    Supervisor

Main Naval Role Requests
    Captain
    Supervisor
    2-Gun Gunner
    Gunboat Gunner
    Carpenter
```

---

# Recently Implemented: Shared Role Pools

The same logical event role may be exposed by several request groups.

For example:

```text
Captain
```

shown in the early command message and:

```text
Captain
```

shown in the later main role-request message refer to the **same event-level volunteer pool**.

A member requesting Captain through either message is requesting the same role.

This behaviour must be preserved during refactoring.

---

# Recently Implemented: Independent Multi-Role Requests

Members may request several roles simultaneously.

Example:

```text
Captain
Carpenter
Gunboat Gunner
```

Requests are independent.

They are not ranked first/second/third preferences.

A request is conceptually unique by:

```text
event + user + role option
```

---

# Recently Implemented: Explicit Request Withdrawal

Role buttons are not toggles.

If a member clicks a role which they have already requested:

```text
No database change
```

The bot tells them the request already exists.

Withdrawal happens through:

```text
Manage My Requests
```

If a member withdraws and later requests the same role again, the new request receives a new timestamp and therefore returns to the back of the request order.

---

# Recently Implemented: Signup-Gated Role Request Groups

A request group may require members to be:

```text
Attending
or
Tentative
```

before adding a new request.

Other groups may deliberately allow requests without a signup.

This supports early/private Captain or Supervisor planning before the normal public attendance message exists.

---

# Recently Implemented: Role Request Closing Times

Role-request groups may close:

- Before event start
- At event start
- After event start

Internally, a signed offset is used.

Conceptually:

```text
 10 = 10 minutes before start
  0 = at start
-10 = 10 minutes after start
```

User-facing command options expose separate before/after concepts.

Closure is handled using the persistent scheduler.

---

# Recently Implemented: Unpublished Events

Events can now be created internally without immediately posting their normal public announcement.

Current intended workflow:

```text
Create event internally
        |
        v
Receive event ID
        |
        +---- assign organisers
        |
        +---- configure role options
        |
        +---- post early/private role requests
        |
        +---- edit event
        |
        v
Publish publicly later
```

Publication state is separate from normal event status.

```text
publishedAt = null
```

means the event is currently unpublished.

---

# Recently Implemented: Manual Event Publication

Unpublished events may be made public using:

```text
/event publish
```

Manual publication uses the same central event-publication service as automatic publication.

---

# Recently Implemented: Scheduled Event Publication

One-off event creation now supports automatic publication a configurable number of minutes before event start.

Example:

```text
Event:
Sunday 20:00

publish-minutes-before-start:
1440

Announcement:
Saturday 20:00
```

Scheduled publication uses a durable action:

```text
publish_event
```

---

# Recently Implemented: Manual Override of Scheduled Publication

An administrator may publish a scheduled event early using:

```text
/event publish
```

After successful manual publication, the outstanding scheduled publication action is marked completed so it cannot later publish the event a second time.

---

# Recently Implemented: Publication Schedule Editing

For an unpublished event, `/event edit` can:

- Change the event date/time
- Preserve/reschedule the publication offset
- Change the publication offset
- Remove the automatic publication schedule

Publication timing is validated against:

- Current time
- Event start
- Signup closure

---

# Recently Implemented: Publication Destination Snapshot

The intended public event channel is stored on the event.

This prevents a later change to the guild's default attendance channel from unexpectedly moving an already-scheduled event announcement.

---

# Recently Implemented: Publication Race Protection

Manual and scheduled publication may theoretically occur close together.

Publication uses a conditional database update requiring the event to remain unpublished.

Only one caller may claim publication successfully.

A duplicate Discord message created by a losing race is removed.

---

# Recently Implemented: Scheduler Expansion

The durable scheduler currently handles or supports:

```text
publish_event
close_attendance
complete_event

event reminders

organiser warnings
organiser timeouts
organiser cover requests

role-request group closure
```

Scheduler functionality includes:

- Persistent database state
- Due-action polling
- Action claiming
- Processing locks
- Stale lock recovery
- Retry attempts
- Increasing retry delays
- Failed-action state

---

# Recently Implemented: Reliability and Concurrency Hardening

A substantial reliability pass has now been completed across lifecycle-sensitive database operations.

Automated testing now includes:

- Vitest unit tests
- PostgreSQL integration tests through Testcontainers
- Separate TypeScript checking for production and test code
- Deterministic concurrency regression tests using PostgreSQL locks rather than timing-dependent sleeps

Recent hardening includes:

- Preventing stale event lifecycle operations from overwriting cancellation or other newer states
- Protecting automatic scheduler actions from lifecycle races
- Fencing stale scheduler attempts from newer retries
- Preventing exhausted or stale scheduled actions from being reclaimed incorrectly
- Verifying scheduler retry backoff and terminal failure behaviour
- Protecting attendance responses against event closure, cancellation, completion and changed signup eligibility
- Protecting role-request creation against group closure, terminal event state, attendance eligibility changes and role-option configuration changes
- Protecting role-request withdrawal against terminal event lifecycle changes
- Protecting organiser confirmation and decline against cancellation and completion races
- Protecting cover claims against terminal lifecycle changes
- Preventing stale backup activation after another organiser has already claimed cover
- Preventing stale general-cover escalation after organiser ownership has already been resolved

A common concurrency principle is now used where appropriate:

```text
Initial read/check
        |
        v
Acquire authoritative database ownership
        |
        v
Re-check current lifecycle/eligibility state
        |
        +---- still valid -> persist change
        |
        +---- stale/invalid -> perform no stale success mutation
```

For organiser ownership changes, the event row is used as the shared ordering boundary where appropriate.

Database state remains authoritative.

External Discord side effects should occur only after the corresponding authoritative database operation succeeds.

Known bugs discovered during this pass were first captured as failing regression tests before production fixes were applied.

---

# Recently Implemented: Cancellation and Publication

Cancelling an unpublished event cancels its outstanding scheduled actions.

A scheduled publication should therefore not publish a cancelled event.

Scheduler execution also performs defensive event-state checks.

---

# Recently Implemented: Event Completion Cleanup

Completion makes irrelevant outstanding work obsolete.

This includes appropriate cleanup around:

- Attendance closure
- Publication
- Organiser escalation

Cancellation remains final and should not later be overwritten by automatic completion.

---

# Recently Implemented: Event List Publication State

`/event list` now displays publication information for active unpublished events.

A known presentation issue was identified and subsequently corrected/should remain covered:

> Cancelled events must not continue displaying an "Unpublished / Publishes in..." countdown simply because a publication offset remains stored.

The event's lifecycle state must take precedence over a stale/historical publication schedule in the list display.

---

# Current Audit System

Administrative actions are recorded in PostgreSQL.

The database audit record is authoritative.

Discord mirroring is optional.

Automatic scheduler actions are also audited where appropriate.

---

# Current Public Testing State

The bot is currently being tested by a limited group of regiment members.

The current Discord UI is considered functional rather than final.

The near-term focus should remain on:

- Behaviour
- Reliability
- Workflow quality
- Testing

rather than spending substantial development time polishing temporary event-message presentation.

---

# Immediate Next Development Task

Continue the repository-wide reliability review with a focused pass on **Discord message failure and recovery behaviour**.

The immediate priority is to verify what happens when Discord-facing state disappears while valid authoritative database state remains.

Primary targets:

1. Public event message is manually deleted
2. Role-request group message is manually deleted
3. Publication or attendance channel is removed
4. Role-request channel is removed
5. Ping/notification role is removed
6. Event Administration channel is removed

The preferred reliability model is:

```text
PostgreSQL state
    -> authoritative

Discord message/channel/role
    -> recover where the correct replacement is unambiguous
    -> otherwise fail safely and provide an administrative recovery path
```

For deleted messages where the original destination channel still exists, investigate automatic replacement without republishing or otherwise replaying unrelated event lifecycle behaviour.

Recovery must avoid:

- Duplicate event publication
- Duplicate role-request pools
- Duplicate scheduled actions
- Re-triggering organiser activation
- Re-triggering reminders or other lifecycle effects
- Losing valid database state merely because Discord presentation state was removed

Continue using regression tests before production fixes where a concrete failure can be reproduced.

The broader repository-wide architecture and code-quality review remains ongoing.

Primary goals remain:

1. Identify potential bugs
2. Identify lifecycle/race issues
3. Identify overly large modules/functions
4. Reduce unnecessary coupling
5. Improve comments around non-obvious domain behaviour
6. Improve automated test coverage
7. Improve scheduler reliability/idempotency
8. Improve portability
9. Identify dead or legacy code/schema
10. Review public-repository quality
11. Review `/event` command structure before reaching Discord's subcommand limit

Avoid speculative rewrites.

Prefer incremental refactoring backed by tests.

---

# High-Priority Behaviour to Verify During the Review

## Event lifecycle

Substantial automated coverage now exists around stale/racing event lifecycle operations, including cancellation ownership and scheduler interaction.

Continue verifying:

- Immediate publication
- Manual publication
- Scheduled publication
- Early manual override
- Cancellation before publication
- Cancellation after publication
- Event completion
- No-signup events
- Editing unpublished events
- Editing published events
- Clearing publication schedule
- Changing event start after publication is scheduled

---

## Scheduler

Scheduler reliability and idempotency now have substantial automated coverage, including:

- Concurrent action claiming
- Stale processing recovery
- Retry attempt fencing
- Retry backoff
- Exhausted-action handling
- Cancellation ownership
- Lifecycle races across automatic actions

Continue reviewing interactions between:

```text
publish_event
close_attendance
complete_event
reminders
organiser actions
role-request closure
```

Particular attention should still be paid to stale or racing actions when new scheduler behaviour is added.

---

## Discord message failures

Review behaviour where:

- Public event message is manually deleted
- Role-request group message is manually deleted
- Publication channel is removed
- Ping role is removed
- Role-request channel is removed
- Event Administration channel is removed

The database should remain authoritative.

---

# High-Priority Role Request Refinement

Where not already fully implemented, finish attendance-state integration.

Desired organiser display:

```text
CAPTAIN

1. Nelson  ✅ Attending      • Qualified
2. Hardy   ❔ Tentative      • Supervisor required
3. Smith   ⚪ No signup      • Qualified
4. Jones   🚫 Not attending • Qualified
```

Desired semantics:

```text
Attending
    -> active

Tentative
    -> active but visibly tentative

Not Attending
    -> request retained
    -> unavailable

No signup
    -> allowed where the request workflow permitted it
```

Changing attendance should refresh affected role-request messages.

Returning to Attending should reactivate the original request without resetting its original queue timestamp.

---

# High-Priority Organiser Follow-Up

Implement a workflow for a confirmed organiser becoming unavailable.

Desired behaviour:

```text
Confirmed organiser
        |
        v
Unavailable
        |
        +---- existing backup
        |
        +---- OR existing cover-request flow
```

Do not create a separate unrelated organiser replacement mechanism.

---

# High-Priority Attendance Follow-Up

Add participation context to actual attendance.

Planned initial types:

```text
participant
supervisor
organiser
server_admin
other
```

Non-playing legitimate attendance should count as present without creating false walk-in/reliability issues.

---

# High-Priority Feature Flag Follow-Up

Add guild-level optional feature settings.

Likely initial switches:

```text
organisersEnabled
organiserEscalationEnabled
roleRequestsEnabled
attendanceReportingEnabled
```

Role requests should continue respecting event-type configuration.

Runtime feature checks are preferred to dynamically modifying slash-command registration.

---

# Template Direction

Templates are planned but are **not** the immediate next task.

Desired future flow:

```text
Template
    |
    v
Generate unpublished occurrence
    |
    +---- organiser assignment
    |
    +---- early role planning
    |
    +---- admin preparation
    |
    v
Scheduled public publication
    |
    v
Normal event lifecycle
```

Templates should eventually define:

- Event defaults
- Recurrence
- Event type
- Audience
- Timezone
- Duration
- Publication timing
- Signup behaviour
- Ping roles
- Organiser behaviour
- Role options
- Qualification rules
- Role-request groups
- Reminders

---

# Known / Potential Technical Debt

Areas which deserve specific review include:

- `/event` is approaching Discord's maximum subcommand count
- Central event command files are large
- Administrative authorisation/configuration logic is repeated
- Similar event-loading queries exist in several modules
- Some service boundaries are still command-oriented rather than domain-oriented
- Role-request output may eventually exceed Discord embed limits
- Role options have limited edit/remove administration
- Role groups have limited edit/reopen/delete/repost administration
- Deleted role-request Discord messages can leave valid database records without easy recovery
- Scheduled role-request group opening/posting is not yet implemented
- Notification-role configuration for a role group may need richer persistence for reposting/templates
- Some earlier template/role-request opening fields may now be legacy
- Old event-message concepts should be reviewed for actual current use
- Guild defaults currently required during event creation may eventually become conditional under feature flags
- Tests should increasingly target domain/service behaviour rather than only command outputs

Do not remove apparently unused schema fields until:

1. Existing migrations are understood
2. Historical data impact is checked
3. Future template plans are considered

---

# Integration Context

Another community developer maintains a Discord bot which already:

- Automatically records actual attendance
- Uses PostgreSQL
- Uses TypeScript
- Uses discord.js
- Provides attendance/statistics portal pages
- Is developing additional signup/battle-request functionality

The developer has expressed openness to:

- Collaboration
- Integrating useful functionality from this project
- Allowing additional portal pages
- Potential eventual consolidation of community bot functionality

There is therefore a realistic possibility that parts of this project will eventually be migrated.

---

# Highest-Value Portable Areas

Prioritise portability for:

```text
organiser assignment
organiser escalation
scheduler infrastructure
event publication lifecycle
role-request logic
qualification logic
attendance comparison semantics
audit behaviour
```

Do not assume this project's migrations can simply be applied to the other bot.

Map its existing domain/schema first.

---

# Domain Behaviour Which Must Not Be Accidentally Changed During Refactoring

Preserve these unless an explicit product decision changes them:

1. Role requests are independent and multi-select.
2. The same event role shown in several request groups uses one underlying request pool.
3. Requesting a role does not allocate the role.
4. Role withdrawal is explicit through Manage My Requests.
5. Withdrawing and re-requesting creates a new queue position.
6. Supervision-required qualification remains eligible where configured but must be visible to organisers.
7. Qualification and notification audience are separate.
8. Early/private groups may operate without attendance signup.
9. The bot should not enumerate the entire guild as fallback role volunteers.
10. Actual attendance and signup intention are separate.
11. No-signup events do not produce signup reliability issues.
12. Organiser response countdown begins on publication.
13. Publication state is separate from event status.
14. Unpublished events are normal persistent event records.
15. Important scheduled work must survive restarts.
16. Database state is authoritative over Discord message state.
17. Attendance discrepancies are informational and never automatically punitive.
18. Event creator and organiser are separate concepts.
19. Cancellation is a final state.
20. Manual publication may override scheduled publication.
