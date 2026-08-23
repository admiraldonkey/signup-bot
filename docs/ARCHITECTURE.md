# Holdfast Event Bot Architecture

## Overview

The **Holdfast Event Bot** is a Discord event-management system designed primarily for a large _Holdfast: Nations at War_ regiment/community.

The project began as a replacement for reaction-based naval event sign-ups, but has deliberately evolved into a more general event-management platform capable of supporting:

- Naval events
- Linebattles
- Competitions and other event types
- Events with or without attendance sign-ups
- Event organiser assignment and escalation
- Configurable role requests
- Qualification-aware role volunteering
- Actual attendance recording and comparison
- Scheduled reminders and announcements
- Unpublished/draft events
- Scheduled public event publication
- Multiple Discord servers in the future
- Potential integration with another community Discord bot and web portal

The bot is currently in active development and public testing with a small group of regiment members.

An important architectural goal is **portability**. Some functionality may eventually be transplanted into, integrated with, or adapted for another community Discord bot, so major subsystems should avoid unnecessary coupling to this project's Discord commands, message layout, or exact database schema.

---

# Technology Stack

The project currently uses:

- **Node.js**
- **TypeScript**
- **discord.js**
- **PostgreSQL**
- **Drizzle ORM**
- **drizzle-kit**
- **Luxon** for timezone-aware date/time handling
- **Docker**
- **Northflank** for hosted deployment
- **GitHub** for source control

Development is performed locally using:

- A separate development Discord bot
- A separate development Discord server
- A local PostgreSQL database
- Docker Desktop / WSL2 where appropriate
- Visual Studio Code

The public/testing deployment runs as a persistent Node.js service with PostgreSQL.

---

# Core Design Principles

The project should generally continue following these principles.

## 1. The database is authoritative

Discord messages are **views of database state**, not the primary source of truth.

Event state should therefore survive:

- Discord message deletion
- Discord message editing
- Bot restarts
- Deployments
- Temporary Discord API failures

Where practical, Discord messages should be rebuildable from the database.

---

## 2. Important scheduled work must survive restarts

Long lived operations must use persistent database backed scheduling rather than relying solely on JavaScript timers.

Examples include:

- Event publication
- Attendance closure
- Event completion
- Event reminders
- Organiser warnings
- Organiser timeouts
- Organiser cover escalation
- Role-request group closure

Short lived UI debounce timers are acceptable because they do not represent authoritative future work.

---

## 3. Discord handlers should become increasingly thin

Discord interaction handlers should primarily be responsible for:

1. Reading command/button input
2. Authorisation
3. Basic interaction-specific validation
4. Calling domain/service logic
5. Formatting the Discord response

Business logic should increasingly move into dedicated modules/services.

This is especially important for functionality which may eventually be transplanted into another bot.

---

## 4. Event existence and event publication are separate concepts

An event may exist internally before any public attendance/event message is posted.

This allows administrators to:

- Receive an event ID
- Assign organisers
- Configure role options
- Open early/private role requests
- Edit event details
- Schedule publication
- Prepare the event before members are notified

---

## 5. Automation assists administrators rather than punishing members

Attendance and sign-up discrepancies are intended to be **informational**.

The bot should not automatically:

- Punish members
- Remove roles
- Block future sign-ups
- Apply disciplinary scoring
- Make high-impact decisions without human review

Human administrators remain responsible for interpreting context.

---

## 6. Historical records should remain understandable

Where appropriate, Discord-facing information is snapshotted.

Examples include:

- Role names
- Display names
- Publication destinations
- Event-specific role configuration

Discord IDs remain authoritative identity where available, but snapshots keep historical data understandable after Discord configuration changes.

---

## 7. Existing events should not silently inherit later server-default changes

Important event-specific configuration should be snapshotted at creation or configuration time.

For example, an event scheduled to publish in a particular channel should not suddenly move because an administrator changes the server's default attendance channel before publication.

---

# High-Level Event Lifecycle

A typical event lifecycle is:

```text
Create internal event
        |
        v
Unpublished event
        |
        +---- assign organisers
        |
        +---- configure event role options
        |
        +---- post early/private role-request groups
        |
        +---- edit event details
        |
        +---- manually publish
        |
        +---- OR wait for scheduled publication
        |
        v
Published event
        |
        +---- attendance responses
        |
        +---- general/public role requests
        |
        +---- reminders and announcements
        |
        v
Attendance closes
        |
        v
Event runs
        |
        v
Event completes
        |
        +---- actual attendance recorded/imported
        |
        +---- signup vs attendance comparison
        |
        +---- historical reporting
```

Cancellation may occur before or after publication.

A cancelled event is currently treated as a final administrative state.

---

# Event Status vs Publication State

Publication is deliberately modelled separately from the main event status.

Current event statuses are:

```text
scheduled
open
closed
cancelled
completed
```

Publication is represented separately using:

```ts
publishedAt: Date | null;
```

Therefore:

```text
publishedAt = null
```

means that the event has **not yet received its normal public event announcement**.

For example:

```text
status = scheduled
publishedAt = null
```

represents a valid unpublished event which exists internally.

This separation is deliberate.

A `draft` value should **not** be added to the main event status enum merely to represent publication state.

---

# Event Creation

One-off events may currently be created with:

- Event type
- Region/audience
- Name
- Date
- Time
- Primary ping role
- Additional ping roles
- Optional timezone override
- Description
- Primary organiser
- Backup organiser
- Attendance sign-ups enabled/disabled
- Publication behaviour
- Duration
- Attendance closing offset
- Detailed signup deadline display

The event receives a persistent database ID regardless of whether it is immediately published.

---

# Event Publication

Events currently support three publication models.

## Immediate publication

The event is created and the normal public event message is posted immediately.

This retains the original simple workflow.

---

## Scheduled publication

The event exists internally and is automatically published a configured number of minutes before its start time.

Example:

```text
Event start:
Sunday 20:00

Publish offset:
1440 minutes

Public announcement:
Saturday 20:00
```

Scheduled publication uses a persistent scheduler action:

```text
publish_event
```

---

## Manual publication

An event may remain unpublished until an administrator explicitly runs:

```text
/event publish
```

This is useful when the organiser wants complete manual control over announcement timing.

---

# Manual Publication Override

An event with scheduled publication may still be published early using:

```text
/event publish
```

Successful manual publication makes the outstanding automatic publication action obsolete.

The scheduled action is marked completed so it cannot publish the event again later.

---

# Publication Safety

Publication is centralised in:

```text
src/events/event-publication.ts
```

The primary reusable function is conceptually:

```ts
publishStoredEvent(guild, eventId);
```

The same publication service is used by:

- Manual `/event publish`
- Scheduled automatic publication
- Immediate publication during `/event create`

This avoids maintaining several subtly different publication implementations.

Publication checks include:

- The event exists
- The event belongs to the relevant Discord server
- The event is not already published
- The event is not cancelled
- The event is not completed
- The event has not already started
- Signup closure has not already passed
- The destination channel exists
- The destination channel can receive messages
- The bot has the required permissions
- Configured ping roles still exist
- The bot can mention the configured ping roles

---

# Publication Destination Snapshot

Events store:

```text
publicationChannelId
```

This records the intended publication destination when the event is created/configured.

The guild's current default attendance channel remains useful as a fallback for older events, but should not normally determine where a previously scheduled event suddenly publishes.

---

# Publication Concurrency

Manual and automatic publication can theoretically occur at nearly the same time.

The publication service therefore protects the database transition using a conditional update requiring:

```text
publishedAt IS NULL
```

Only one publication attempt may successfully claim the event.

In the unlikely event that both callers manage to send a Discord message before one loses the database race, the losing publication attempt removes its duplicate Discord message.

This protects against duplicate event publication.

---

# Attendance Sign-Ups

Attendance sign-ups are optional per event.

Events may be created with:

```text
signupsEnabled = false
```

No-signup events:

- Do not display attendance buttons
- Do not require an attendance closing time
- Do not produce signup discrepancy statistics
- May still have actual attendance recorded
- May still use organisers
- May still use role requests where appropriate
- May still use announcements/reminders where appropriate

This is useful for event types such as linebattles or announcements where attendance signup is not required.

---

# Attendance Response States

Signup-enabled events currently support:

- **Attending**
- **Tentative**
- **Not Attending**

Only one current attendance response exists per:

```text
event + Discord user
```

Changing a response updates the existing record rather than creating a second independent response.

---

# Attendance Message Model

The normal public event/attendance message is linked through:

```text
event_messages
```

Representative modules include:

```text
src/events/attendance-message.ts
src/events/attendance-refresh.ts
```

The database remains authoritative.

Refreshing an event rebuilds the Discord message from current database state.

Message refreshes deliberately suppress repeated notifications from displayed role mentions.

---

# Actual Attendance

Actual attendance is stored separately from signup intention.

This distinction is fundamental:

```text
Signup response
    = intention before the event

Actual attendance
    = observed presence at the event
```

Actual attendance may currently be:

- Replaced in bulk
- Individually added
- Individually removed
- Compared with signup responses

---

# Signup vs Actual Attendance Comparison

Current comparison/reporting concepts include:

- Attended as expected
- Signed up but did not attend
- Attended without signing up
- Attended despite selecting Not Attending
- Tentative members who ultimately did not attend

Tentative non-attendance is shown for context but is not treated as a normal no-show.

Events created without sign-ups are excluded from signup reliability/discrepancy statistics.

---

# Planned Attendance Participation Context

Actual attendance currently primarily records that a member was present.

A planned extension will classify **how they were present**.

Initial intended values include:

```text
participant
supervisor
organiser
server_admin
other
```

This is necessary because some legitimate attendees may supervise or administer an event without actively playing.

Desired comparison semantics:

```text
participant + actual attendance + no signup
    -> walk-in

supervisor + actual attendance + no signup
    -> legitimate attendance
    -> NOT a walk-in issue

organiser + actual attendance + no signup
    -> legitimate attendance
    -> NOT a walk-in issue

server_admin + actual attendance + no signup
    -> legitimate attendance
    -> NOT a walk-in issue
```

All categories should still count as attendance.

Participation classification is event-specific.

A Discord role may suggest a classification but should not automatically become permanent truth.

---

# Event Organiser System

Events may currently have:

- **Primary Organiser**
- **Backup Organiser**
- **Cover Organiser**

Organiser assignments are stored separately from the core event record.

This allows assignment history to be retained.

Representative areas include:

```text
src/organisers/
src/events/organiser-notification.ts
src/events/organiser-display.ts
src/commands/event-organisers.ts
```

---

# Event Creator vs Event Organiser

The administrator who creates an event is not automatically assumed to be its organiser.

The following are separate concepts:

```text
Event creator
Primary organiser
Backup organiser
Cover organiser
```

This distinction should be preserved.

---

# Organiser Activation

An organiser assigned to an unpublished event remains dormant.

Creating an internal event should **not** immediately begin the organiser's confirmation countdown.

The primary organiser becomes active when the event is publicly published.

At activation:

1. `activatedAt` is set
2. A response deadline is calculated
3. Warning/timeout scheduler actions are created
4. The organiser receives a Confirm/Decline prompt

This ensures organiser responsibility begins when the event becomes public rather than at an arbitrary internal preparation time.

---

# Organiser Notifications

Preferred organiser notification path:

```text
Direct Message
```

If the DM cannot be delivered, the bot falls back to the configured private:

```text
Event Administration channel
```

This provides a reliable administrative path without requiring organisers to allow DMs from the bot.

---

# Organiser Escalation

The current organiser escalation model is:

```text
Primary Organiser
        |
        +---- confirms
        |       |
        |       v
        |   remains organiser
        |
        +---- declines or times out
                |
                v
          Backup Organiser
                |
                +---- confirms
                |       |
                |       v
                |   becomes active organiser
                |
                +---- declines or times out
                        |
                        v
                  Cover Request
                        |
                        v
          Event Organiser role can
                Claim Event
```

Administrators may also receive a warning shortly before an organiser response deadline expires.

---

# Planned Confirmed-Organiser Unavailability Workflow

A confirmed organiser should eventually be able to indicate that they are no longer available.

Desired behaviour:

```text
Confirmed organiser
        |
        v
"I am unavailable"
        |
        +---- activate backup if available
        |
        +---- otherwise issue cover request
```

This should reuse the existing organiser escalation infrastructure instead of creating an unrelated second replacement system.

---

# Role Request System

Role requests represent **willingness or interest** in performing a role.

Examples may include:

- Captain
- Supervisor
- 2-Gun Gunner
- Gunboat Gunner
- Carpenter
- Linebattle command roles
- Specialist roles

A role request is **not a guaranteed allocation**.

Final assignment remains an organiser decision.

---

# Event-Level Role Options

Logical requestable roles belong to an event.

Representative table:

```text
event_role_options
```

Example roles:

```text
Captain
Supervisor
Carpenter
```

A logical role is independent of any particular Discord message.

---

# Role Request Groups

A role-request group represents a Discord-facing request message.

Representative tables:

```text
role_request_groups
role_request_group_options
```

A group may define:

- Name
- Description/instructions
- Discord channel
- Which logical roles are displayed
- Whether positive attendance signup is required
- Opening information
- Closing time
- Optional notification role

One event may have several groups.

---

# Shared Role Pools Across Groups

The same logical event role may appear in several request groups.

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

Both Captain buttons refer to the **same event-level Captain option**.

Therefore:

- Early Captain requests
- Later general Captain requests

share the same volunteer pool.

There are **not** separate "early Captain" and "main Captain" role requests.

This is an important domain invariant.

---

# Multi-Role Requests

Role requests are independent and multi-select.

A member may request:

```text
Captain
Carpenter
Gunboat Gunner
```

at the same time.

They are not currently forced into a ranked first/second/third preference system.

The key uniqueness rule is conceptually:

```text
event + user + event role option
```

---

# Duplicate Role Button Behaviour

Role buttons are deliberately **not toggles**.

If a member clicks a role they already requested:

```text
No database change
```

They receive an ephemeral message explaining that the request already exists.

This prevents accidental withdrawal.

---

# Managing and Withdrawing Requests

Withdrawal is performed explicitly through:

```text
Manage My Requests
```

The member receives an ephemeral management view containing explicit withdrawal controls.

If the member withdraws and later requests the role again:

- A new database request is created
- The new request receives a new creation timestamp
- The member therefore returns to the back of the request order

---

# Role Qualification

Role options may currently be:

```text
open
qualified_only
```

Qualification is based on configurable Discord roles.

Current qualification levels include:

```text
qualified
supervision_required
```

Example:

```text
Captain

Flag Captain role
    -> qualified

Midshipman role
    -> supervision_required
```

A member with a supervision-required qualification may still express interest in a `qualified_only` role.

The organiser view must make the distinction visible.

---

# Qualification States

Useful conceptual qualification states include:

```text
qualified
supervision_required
unqualified
member_unavailable
```

The exact UI representation may evolve, but this distinction should remain.

---

# Qualification vs Notification Audience

Qualification and notification audience are separate concerns.

Example:

```text
Who may request Captain?
    -> qualification rules

Who should be notified that Captain requests are open?
    -> notification/audience configuration
```

These concepts must not be conflated.

---

# Signup-Gated Role Request Groups

A role-request group may require a positive signup.

For those groups, new requests require the member to currently be:

```text
Attending
or
Tentative
```

Other request groups may deliberately allow requests without a signup.

This is particularly useful for early/private planning before the public event announcement exists.

---

# Early Role Requests

Unpublished events make this workflow possible:

```text
Create event internally
        |
        v
Receive event ID
        |
        v
Configure Captain/Supervisor roles
        |
        v
Post private early role request
        |
        v
Later publish normal public event announcement
```

This was one of the key motivations for separating event creation from publication.

---

# Role Request Closing Times

Role-request groups have independent closing times.

The current internal convention uses a signed offset relative to event start:

```text
 10 = close 10 minutes before event start
  0 = close at event start
-10 = close 10 minutes after event start
```

The database column retains its older name:

```text
closeMinutesBeforeStart
```

despite supporting negative values.

User-facing commands should continue presenting explicit **before** and **after** concepts so administrators do not need to understand negative offset arithmetic.

---

# Organiser Role Request View

The private organiser/admin role-request view should prioritise actual volunteers.

Requesters are shown in request order.

Useful information includes:

- Current attendance state
- Qualification state
- Supervision requirement
- Number of other roles the member requested

Where appropriate, the organiser view may also suggest other eligible signed-up members.

Fallback candidates should normally be limited to members who:

- Are Attending or Tentative
- Meet the role qualification criteria
- Have not already requested that particular role

For early/no-signup request groups, the bot should **not** enumerate thousands of unrelated guild members merely because they technically hold a qualification role.

---

# Role Requests and Attendance State

The intended semantic model is:

```text
Role request
    = willingness to perform the role

Attendance response
    = whether that willingness is currently actionable
```

Desired behaviour:

```text
Attending
    -> active volunteer

Tentative
    -> active volunteer
    -> clearly marked tentative

Not Attending
    -> request retained
    -> currently unavailable

No signup
    -> may remain valid where the request workflow allowed requests without signup
```

Changing attendance to Not Attending should **not** destroy the role request.

Changing back to Attending should reactivate the existing request without changing its original queue timestamp.

Role-request messages and organiser views derived from attendance should refresh when attendance changes.

---

# Durable Scheduler

Scheduled work is persisted in:

```text
scheduled_actions
```

Representative scheduler module:

```text
src/scheduler/event-scheduler.ts
```

Current scheduler responsibilities include or support:

```text
publish_event
close_attendance
complete_event
event reminders
organiser warning actions
organiser timeout actions
organiser cover-request actions
role-request group closure
```

---

# Scheduler Processing Model

The scheduler broadly performs:

1. Find due `pending` actions
2. Atomically claim an action by moving it to `processing`
3. Execute the action
4. Mark successful actions `completed`
5. Retry transient failures
6. Increase retry delay between failures
7. Eventually mark repeatedly failing actions `failed`

A processing lock helps prevent accidental duplicate work.

---

# Stale Action Recovery

If the process crashes while an action is marked:

```text
processing
```

the scheduler can recover stale locks after a configured period.

The action is returned to:

```text
pending
```

and may be retried.

This protects against events becoming permanently stuck because the bot restarted during processing.

---

# Scheduled Action Idempotency

Where practical, scheduled actions should be idempotent.

Scheduling helpers generally use upsert-style behaviour.

For example, editing an event should reschedule its existing completion/publication/attendance action rather than create duplicate scheduler records.

Execution code should safely handle cases where:

- The event has been deleted
- The event was cancelled
- The event completed
- An administrator performed the action manually
- Another execution path reached the target state first

---

# Event Completion

Events receive a scheduled completion action based on their configured end time.

Completion should:

- Move the event to `completed`
- Make irrelevant publication/attendance-close work obsolete
- Cancel organiser escalation actions
- Refresh affected Discord state where appropriate

Cancellation remains a separate final state and should not be overwritten by automatic completion.

---

# Reminders and Announcements

Events support:

- Immediate custom announcements
- Scheduled custom reminders

Reminder timing may currently be relative to:

```text
event_start
signup_close
```

A reminder stores its resolved destination channel rather than relying solely on the current guild default.

This prevents future configuration changes from silently moving an existing reminder.

---

# Missed Reminders

If a reminder remains pending until after its useful reference time has already passed, it should not send a misleading late warning.

Instead it is recorded as missed.

This behaviour should remain auditable.

---

# Audit System

Administrative actions are written to an authoritative PostgreSQL audit trail.

Representative table:

```text
audit_logs
```

Records may contain:

- Guild
- Actor
- Action
- Outcome
- Human-readable summary
- Target type
- Target ID
- Structured details
- Timestamp

Automatic scheduler activity uses a null/system actor.

---

# Discord Audit Mirroring

Guilds may optionally configure a Discord channel where audit activity is mirrored.

Disabling Discord mirroring does **not** disable database auditing.

The database audit history remains authoritative.

---

# Guild Configuration

Server-specific configuration currently includes concepts such as:

- Event Admin role
- Event Organiser role
- Default attendance/publication channel
- Default role-request channel
- Private Event Administration channel
- Bot audit-log channel
- Organiser response timing
- Organiser warning timing

Additional server-level feature switches are planned.

---

# Event Types

Event types are database records rather than code enums.

Examples include:

```text
naval
linebattle
competition
```

This allows new event categories without requiring a new application enum migration.

Event types may also control whether role requests are enabled.

---

# Event Audiences / Regions

Events may be associated with configurable audiences or regions.

Current default concepts include:

- EU
- NA
- EU & NA / Global

An audience provides a default IANA timezone.

The event itself stores both:

- Its authoritative absolute timestamps
- The timezone used for organiser-facing interpretation/editing

---

# Timezone Handling

Date/time entry should use explicit IANA timezone identifiers such as:

```text
Europe/London
America/New_York
America/Chicago
America/Los_Angeles
```

Ambiguous abbreviations such as:

```text
EST
BST
CST
```

should not be relied upon.

Luxon is used for timezone-aware date handling.

Ambiguous local times caused by daylight-saving clock changes are rejected rather than guessed.

Discord timestamps are used for member-facing event times where possible so each user sees the relevant time in their own locale/timezone.

---

# Major Database Areas

The schema currently contains concepts including:

```text
discord_guilds
guild_settings

event_types
event_audiences
event_templates
template_role_options

events
event_ping_roles
event_messages

attendance_responses
event_attendance_reports
actual_attendance_records

event_role_options
event_role_option_qualification_roles

role_request_groups
role_request_group_options
role_requests

event_organiser_assignments

scheduled_actions
event_reminders

audit_logs
```

The authoritative current schema is:

```text
src/db/schema.ts
```

---

# Current / Preferred Module Boundaries

The repository should increasingly follow subsystem-oriented boundaries.

A representative conceptual structure is:

```text
src/
  audit/
    audit-log.ts

  auth/
    event-admin.ts

  commands/
    event.ts
    event-edit.ts
    event-publish.ts
    event-organisers.ts
    event-role-requests.ts
    event-reminders.ts

  db/
    client.ts
    schema.ts

  events/
    attendance-message.ts
    attendance-refresh.ts
    event-publication.ts
    organiser-display.ts
    organiser-notification.ts

  interactions/
    attendance-button.ts
    organiser-button.ts
    role-request-button.ts

  organisers/
    organiser-service.ts
    organiser-scheduling.ts
    organiser-escalation.ts

  reminders/
    reminder-scheduling.ts

  role-requests/
    role-request-message.ts
    role-request-scheduling.ts

  scheduler/
    action-maintenance.ts
    event-scheduler.ts

  time/
    timezones.ts
```

The exact repository layout may differ.

New work should prefer dedicated subsystem modules over continuing to enlarge central command files.

---

# Known Structural Pressure Points

## `/event` command size

The `/event` slash command is approaching Discord's maximum subcommand count.

The command structure will eventually need to be redesigned.

Possible future directions include:

```text
/event ...
/organiser ...
/role-request ...
/reminder ...
```

or suitable Discord subcommand groups.

This should be done deliberately rather than waiting until the hard platform limit prevents new functionality.

---

## Large command handlers

Some event command modules have become large.

A future refactor should move reusable domain operations into services.

Command handlers should primarily perform:

- Input extraction
- Discord-specific validation
- Authorisation
- Service invocation
- Response formatting

---

## Repeated event loading

Several modules query overlapping subsets of event/configuration state.

A refactor should consider whether common event loaders or repository functions would reduce duplication without creating an over-generalised abstraction.

---

## Repeated authorisation/configuration handling

Administrative commands often repeat:

- Guild configuration lookup
- Feature enabled checks
- Event Admin authorisation
- Denied-command audit logging

This is a candidate for careful consolidation.

---

## Role-request message limits

Large numbers of roles/requesters could eventually exceed Discord embed/message limits.

Pagination or multiple-display handling will eventually be required.

---

# Portability and Potential Integration With Another Bot

Another community developer maintains an existing Discord bot which already:

- Automatically records actual event attendance
- Stores data in PostgreSQL
- Uses TypeScript
- Uses discord.js
- Provides attendance/statistics portal pages
- Is developing additional signup/battle-request functionality

The developer has expressed openness to:

- Collaboration
- Integrating useful parts of this bot
- Adding portal pages
- Potentially consolidating community bot functionality

Therefore portability is a genuine project requirement rather than a hypothetical exercise.

---

# High-Value Portable Subsystems

Particularly valuable reusable areas include:

```text
organiser assignment and escalation
durable scheduling
event publication lifecycle
role-request domain logic
qualification handling
attendance comparison semantics
audit logging
```

These should increasingly avoid requiring the entire `/event` command handler in order to function.

---

# Migration Into Another Bot

Database migrations should **not** be copied blindly into another bot.

Before transplanting functionality, map:

```text
event identity
guild identity
Discord user identity
event lifecycle
existing attendance model
existing organiser model
existing scheduler model
existing audit model
```

Then adapt the business logic to the destination schema.

Source migrations describe this project's implementation history. They are not a portable API.

---

# Portal / Web Integration

A web portal may eventually expose selected event-management functionality.

Potential areas include:

- Upcoming events
- Attendance history
- Signup vs actual attendance reports
- Role requests
- Organiser administration
- Member attendance history
- Event statistics

The existing community bot already has a portal.

If collaboration proceeds, extending that portal may be preferable to creating a competing standalone site.

Discord should remain the primary interaction surface unless a web interface provides a clear advantage.

---

# Security

The bot may operate in Discord communities containing thousands of members.

Security requirements include:

- Never committing bot tokens
- Never committing database passwords
- Never committing private API keys
- Using environment variables for secrets
- Runtime authorisation for administrative commands
- Server ownership checks on event operations
- Least-privilege Discord permissions
- Explicit `allowedMentions` handling
- Database constraints for important invariants
- Audit logging for administrative actions
- Careful portal authentication/authorisation if web features are added

---

# Privacy

Attendance, sign-up and role-request information concerns identifiable community members.

The project should avoid collecting information merely because it is technically possible.

Future work should consider:

- Data retention
- Member deletion requests
- Visibility of historical attendance
- Export permissions
- Portal access control
- Audit-log retention

Attendance statistics should remain informational rather than becoming an automatic disciplinary score.

---

# Public Repository Rules

This repository may be made public.

Never commit:

```text
.env
Discord bot tokens
database passwords
private API keys
private webhook URLs
infrastructure credentials
```

An `.env.example` containing placeholder values is appropriate.

Before making the repository public, inspect **Git history**, not merely the current working tree.

Removing a secret from the latest version does not remove it from older commits.

---

# Testing Expectations

Before merging substantial changes:

- TypeScript typechecking should pass
- Automated tests should pass
- Database migrations should apply cleanly to the development database
- The bot should start successfully against the development database
- Relevant commands/buttons should receive targeted manual testing
- Scheduler behaviour should be tested where practical
- Cancellation paths should be tested
- Race-sensitive lifecycle transitions should receive explicit attention

Large lifecycle changes should be tested on the dedicated development Discord bot/server before public deployment.

---

# Architectural Direction

The next development phase should focus less on adding large amounts of new command surface and more on:

1. Repository-wide code review
2. Extracting reusable services from large handlers
3. Improving domain comments and documentation
4. Increasing automated test coverage
5. Strengthening scheduler reliability
6. Improving portability
7. Adding server-level feature flags
8. Preparing templates and recurring events
9. Improving role-request lifecycle administration
10. Adding attendance participation context
11. Preparing for possible integration with the other community bot

The objective is not abstract architectural purity.

The objective is a codebase that can be understood, tested, reused and modified without requiring intimate knowledge of every historical implementation decision.
