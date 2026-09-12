# Holdfast Event Bot Architecture

## Overview

The **Holdfast Event Bot** is a PostgreSQL-backed Discord event management system designed primarily for an organised _Holdfast: Nations At War_ regiment and related gaming community workflows.

The project began as a replacement for reaction-based event sign-ups. It has since developed into a broader event-management system supporting:

- persistent one-off events
- optional attendance sign-ups
- actual attendance recording
- signup versus attendance comparison
- immediate, manual, and scheduled publication
- organiser nomination and escalation
- organiser safety deadlines and cover requests
- event-level role requests
- qualification-aware volunteering
- reusable role-request presets
- scheduled role-request group opening and closing
- reminders and announcements
- audit logging
- Discord message recovery
- persistent scheduled work
- concurrency and race protection

The bot is under active development and community testing.

It is not yet intended to be a universal event-management framework. However, subsystem boundaries are deliberately being improved so useful parts can later be transplanted into or integrated with another Discord bot, web portal, or community system without requiring the destination application to adopt this repository's exact command layout or database schema.

---

# Architectural Status

This document describes the **current implemented architecture** unless a section is explicitly marked as planned or future work.

Important current areas include:

- reusable event creation services
- database-authoritative event state
- durable PostgreSQL-backed scheduling
- event publication and recovery
- attendance state and reporting
- organiser lifecycle services
- role-request services and publication
- reusable role-request presets
- direct integration testing against real PostgreSQL

Important planned areas include:

- editing existing role-request preset definitions
- richer participation context for actual attendance
- confirmed-organiser unavailability/replacement
- event templates
- recurring event generation
- possible future web or external-bot integration

Schema scaffolding for event templates exists, but the presence of a table or column should not be interpreted as evidence that the corresponding administrator-facing feature is complete.

---

# Technology Stack

The current application uses:

- **Node.js**
- **TypeScript**
- **discord.js 14**
- **PostgreSQL**
- **Drizzle ORM**
- **drizzle-kit**
- **Luxon**
- **Vitest**
- **Testcontainers**
- **Docker**

The deployed container currently uses Node.js 22.

Development commonly uses a local PostgreSQL 17 instance through Docker and a separate development Discord bot/server.

---

# Core Design Principles

## 1. PostgreSQL is authoritative

Discord messages are projections of database state.

They are not the source of truth for:

- whether an event exists
- whether an event is published
- whether sign-ups are open
- who signed up
- who actually attended
- who owns an organiser assignment
- whether an organiser assignment is active
- whether someone requested an event role
- whether a role-request group is open
- whether scheduled work remains due

This means important state should survive:

- deleted Discord messages
- edited Discord messages
- renamed Discord roles
- changed guild defaults
- bot restarts
- deployments
- transient Discord API failures

Where practical, Discord presentation should be rebuildable from stored state.

---

## 2. Event lifecycle and Discord publication are separate

An event is a real persistent domain object before its main Discord event message exists.

An unpublished event may therefore already have:

- an event ID
- start and end times
- an event type
- an audience
- snapshotted ping roles
- organiser nominees
- role options
- role-request groups
- reminders
- scheduled actions
- a planned publication destination

Publication is represented separately from event status.

A `draft` event status is not required merely to indicate that the public message has not yet been posted.

---

## 3. Important future work is durable

Authoritative future work must not depend only on JavaScript timers or the current process remaining alive.

Persistent scheduled actions are used for work including:

- event publication
- attendance closure
- event completion
- event reminders
- organiser warnings
- organiser response timeouts
- organiser cover escalation
- organiser safety deadlines
- missing-organiser-at-start checks
- role-request group opening
- role-request group closing

Short-lived UI concerns may use in-memory timing where losing them on restart is harmless.

---

## 4. Discord command handlers should remain adapters

Command and interaction handlers should primarily handle:

1. Discord input
2. Discord-specific validation
3. authorisation
4. service invocation
5. response formatting
6. Discord-specific side effects
7. auditing where appropriate

Reusable domain and persistence behaviour should move into dedicated services where doing so improves testability, clarity, or portability.

The project does not require every function to become a generic repository abstraction.

Concrete services are preferred over speculative dependency-injection layers when the latter do not solve a real integration problem.

---

## 5. External side effects must not become authoritative accidentally

Discord calls cannot participate in PostgreSQL transactions.

The code therefore treats Discord as an external system and deliberately controls the order of:

- database state changes
- Discord message creation
- Discord message editing
- database linkage of Discord message IDs
- post-send state reconciliation
- duplicate cleanup

Where a race may occur during an external call, authoritative state is re-checked after control returns from Discord.

---

## 6. Configuration is snapshotted when an event must remain stable

Mutable guild or reusable configuration should not silently alter an existing event later.

Examples include:

- event ping-role name snapshots
- publication destination
- organiser nominees
- role qualification roles
- role-request group channels
- role-request notification-role metadata
- applied role-request presets
- reminder destination channels

This allows historical records and future scheduled events to remain understandable even when guild configuration changes.

---

## 7. Automation assists administrators

Attendance reporting and role-request data are intended to support human organisers.

The bot should not automatically:

- punish members
- remove unrelated Discord roles
- impose disciplinary scores
- prevent future participation
- make high-impact personnel decisions

Context remains an administrator responsibility.

---

## 8. Cancellation and other final state transitions must dominate stale work

A scheduled action or Discord interaction may have been valid when it began and become invalid before it finishes.

Terminal or newer authoritative state must win.

In particular:

- cancellation must not be undone by stale scheduled work
- completion must stop normal interactive changes
- stale scheduler workers must not overwrite rescheduled actions
- old organiser timeouts must not replace newer organiser ownership
- losing publication attempts must not become authoritative

---

# High-Level System Shape

Conceptually:

```text
Discord
  |
  | slash commands / buttons
  v
Command and interaction adapters
  |
  | validate Discord context
  | authorise
  | call services
  v
Domain / application services
  |
  | transactions
  | locks
  | state transitions
  | durable action creation
  v
PostgreSQL
  |
  | authoritative state
  |
  +---------------------+
  |                     |
  v                     v
Scheduler             Read/build services
  |                     |
  | due work            | render current state
  v                     v
Discord side effects / message projection
```

A key architectural boundary is that Discord presentation is downstream from stored state.

---

# Repository Subsystems

The source tree is organised primarily around domain or infrastructure concerns:

```text
src/
  attendance/
  audit/
  auth/
  commands/
  db/
  discord/
  events/
  interactions/
  organisers/
  reminders/
  role-requests/
  scheduler/
  time/
  index.ts
```

Representative responsibilities include:

```text
attendance/
    actual attendance and comparison/reporting logic

audit/
    persistent audit logging and Discord log mirroring

auth/
    event-administration authorisation

commands/
    slash-command definitions and adapters

db/
    Drizzle schema, client and migration support

discord/
    Discord-specific utility/error handling

events/
    event creation, publication, attendance rendering,
    organiser notifications and message reconciliation

interactions/
    attendance, organiser and role-request button handling

organisers/
    organiser domain transitions, escalation and scheduling

reminders/
    persistent reminder scheduling

role-requests/
    event role options, request messages, scheduling,
    publication and reusable presets

scheduler/
    durable scheduled-action execution and maintenance

time/
    timezone parsing and validation
```

Some command modules remain larger than the long-term ideal.

New work should prefer strengthening useful domain/service boundaries instead of continuing to place all behaviour directly into command handlers.

---

# Persistence Model

## Discord guilds

Configured servers are stored in:

```text
discord_guilds
```

The database uses an internal numeric guild ID.

Discord snowflake IDs are stored as text.

This avoids unsafe conversion of Discord IDs into JavaScript numbers.

---

## Guild settings

Server-specific event configuration is stored in:

```text
guild_settings
```

Current settings include concepts such as:

- Event Admin role
- Event Organiser role
- organiser subsystem enabled state
- organiser DM delivery preference
- primary organiser response duration
- backup organiser response duration
- organiser warning lead time
- organiser general-cover safety lead time
- default attendance channel
- Event Administration channel
- default role-request channel
- optional bot log channel
- default ping role

Settings are mutable guild-level defaults.

Event-specific values are snapshotted where later default changes should not affect an existing event.

---

## Event types

Event types are database records rather than a fixed enum.

Examples may include:

- Naval
- Linebattle
- Competition
- Special Event

An event type can control capabilities such as whether role requests are enabled.

This allows guild configuration to evolve without requiring a code deployment for every new event category.

---

## Event audiences and regions

Events may reference an event audience or region.

These provide reusable guild-level audience concepts while allowing actual event configuration to remain tied to a persistent event record.

---

# Event Model

## Event status

The fixed event status enum currently contains:

```text
scheduled
open
closed
cancelled
completed
```

This represents event lifecycle.

It does not represent publication state.

---

## Publication state

Publication is represented primarily by:

```text
publishedAt
```

Conceptually:

```text
publishedAt = null
    -> normal public event message has not yet been published

publishedAt != null
    -> normal public event message has been published
```

Therefore:

```text
status = scheduled
publishedAt = null
```

is a valid persistent unpublished event.

---

# Event Creation

Authoritative event creation is extracted into:

```text
src/events/event-creation-service.ts
```

The main service is:

```ts
createStoredEvent(...)
```

Its responsibility is the database-side creation of an event.

Discord command parsing, Discord role/member resolution, immediate publication, and user-facing output remain adapter concerns.

The creation service can persist:

- core event data
- publication destination snapshot
- ping-role snapshots
- dormant organiser assignments
- scheduled publication work
- attendance-close work
- completion work

The event receives its persistent ID regardless of whether it is published immediately.

---

## Organisers during event creation

If primary or backup organisers are supplied, organiser functionality must currently be enabled for the guild.

The service creates nominated organisers as dormant assignments.

They are not immediately given a response deadline.

This is deliberate because internal event preparation should not start an organiser confirmation countdown.

Events without organiser nominees can still be created when the organiser feature is disabled.

---

## Template provenance

The `events` table contains a nullable:

```text
template_id
```

and event creation accepts a nullable template ID.

This is current schema/service preparation for future template-generated events.

There is not yet a complete event-template generation workflow.

---

# Event Publication

Events currently support three publication approaches.

## Immediate publication

The event is stored, then published during the creation command workflow.

---

## Manual publication

An administrator can publish an existing unpublished event explicitly.

This supports preparing an event before announcing it publicly.

---

## Scheduled publication

A scheduled action with the stable key:

```text
publish_event
```

can publish the event at a configured time before start.

The event remains a real database object while waiting.

---

# Publication Service

Publication is centralised in:

```text
src/events/event-publication.ts
```

The reusable operation is:

```ts
publishStoredEvent(guild, eventId);
```

The same underlying publication behaviour is used by:

- immediate publication after creation
- manual `/event publish`
- scheduled publication

This reduces the risk of three publication paths developing different domain rules.

Successful publication is also the authoritative release point for automatic role-request groups which became due while the event was deliberately held unpublished.

Within the same PostgreSQL publication transaction, the system can wake still-valid due role-group opening actions through:

```text
resumeDueRoleRequestGroupOpeningsAfterPublication(...)
```

Only groups satisfying:

```text
opensAt <= publishedAt < closesAt
```

are resumed.

Future groups retain their original schedule.

This means event publication and release of already-due deferred role-request work become one coherent database transition.

---

# Publication Validation

Publication re-checks authoritative event state.

Relevant checks include:

- the event exists
- the event belongs to the current Discord guild
- it is not already published
- it is not cancelled
- it is not completed
- the event has not already started
- required signup timing remains valid
- the destination exists
- the destination can accept the message
- required bot permissions are available
- configured ping roles remain usable

Validation occurs when publication actually happens rather than trusting configuration that may have been valid hours or days earlier.

---

# Publication Destination Snapshot

Events store:

```text
publicationChannelId
```

This preserves the intended publication destination.

Changing the guild's default attendance channel later should not normally move an existing scheduled event to an unexpected channel.

Fallback behaviour may exist for older records where the snapshot is absent.

New workflows should prefer explicit event-level destination state.

---

# Publication Concurrency

Manual and scheduled publication can overlap.

Publication therefore uses conditional database transitions rather than assuming only one caller exists.

Conceptually, authoritative linkage may only be claimed while:

```text
publishedAt IS NULL
```

If two workers manage to send Discord messages before one loses the database race:

1. only one linkage becomes authoritative
2. the losing publication path removes its untracked Discord message

The database result, not message-send order, decides the winner.

---

# Event Message Model

Discord messages associated with an event are stored separately from the core event.

Representative table:

```text
event_messages
```

This allows one event to have different presentation messages in different channels.

Examples include:

- attendance/event message
- role-request messages
- reminders
- administrative summaries

Not every Discord-facing record uses `event_messages`.

Role-request groups, for example, currently retain their own authoritative `messageId` linkage.

---

# Attendance Sign-Ups

## Optional per event

Attendance sign-ups are optional.

An event may use:

```text
signupsEnabled = false
```

A no-signup event:

- does not show attendance response buttons
- does not require an attendance closing timestamp
- does not participate in normal signup discrepancy calculations
- may still record actual attendance
- may still use organisers
- may still use event role requests where allowed
- may still use reminders
- may still use announcements

No-signup operation is a first-class mode rather than a workaround.

---

# Attendance Response Model

Signup-enabled events support:

```text
attending
tentative
not_attending
```

Only one current attendance intention exists per:

```text
event + Discord user
```

Changing the response updates the user's current event intention.

Attendance intention is not actual attendance.

---

# Attendance Presentation

Representative modules include:

```text
src/events/attendance-message.ts
src/events/attendance-refresh.ts
```

The attendance message is rendered from PostgreSQL state.

Refreshing it must not reinterpret the existing Discord message as authoritative.

Message refresh also suppresses role/member mentions so updating a display does not repeatedly notify users.

---

# Deleted Attendance Message Recovery

If Discord explicitly reports that the stored attendance message no longer exists, the refresh path can rebuild it from authoritative state.

The recovery model is:

```text
read stored linkage
       |
       v
fetch Discord message
       |
       +---- exists -> edit in place
       |
       +---- Discord says message deleted
                    |
                    v
            rebuild current payload
                    |
                    v
              send replacement
                    |
                    v
       conditionally replace linkage
```

The conditional database update ensures that two concurrent recovery attempts cannot both become authoritative.

If another attempt wins:

- the losing replacement is deleted
- the winning PostgreSQL linkage remains authoritative

If the channel itself has been deleted or is unavailable, the bot does not guess a replacement channel.

Unexpected Discord errors are not silently treated as deletion.

---

# Attendance Close and Reopen

Signup closure is represented by event state and durable scheduled work.

The scheduler can close attendance automatically.

Administrative close/reopen operations must use current PostgreSQL state and respect terminal event states.

Reopening attendance is not equivalent to undoing cancellation or completion.

---

# Actual Attendance

Actual attendance is stored separately from signup responses.

Conceptually:

```text
signup response
    = stated intention before the event

actual attendance
    = recorded presence during the event
```

This separation is fundamental.

Current administrator workflows support:

- replacing the attendance set
- adding one attendee
- removing one attendee
- listing recorded attendance
- comparing actual attendance with signups
- viewing member attendance history

---

# Signup Versus Attendance Comparison

Current reports distinguish concepts including:

- attended as expected
- signed up but absent
- attended without a signup
- attended despite selecting Not Attending
- Tentative but absent

Tentative non-attendance is contextual information rather than automatically equivalent to a normal no-show.

Events with sign-ups disabled should not be used as evidence of signup reliability.

---

# Planned Participation Context

Current actual-attendance records primarily answer:

```text
Was this person present?
```

A planned extension would also answer:

```text
In what capacity were they present?
```

Potential event-specific categories include:

```text
participant
supervisor
organiser
server_admin
other
```

This matters because a person may legitimately attend an event without being a normal participant.

For example:

```text
organiser + attended + no signup
    != ordinary walk-in participant
```

Discord roles may help suggest context, but they should not automatically become permanent historical truth.

This feature is planned, not currently complete.

---

# Event Organiser Architecture

Organiser assignments are separate persistent records.

Representative table:

```text
event_organiser_assignments
```

Supported assignment slots are:

```text
primary
backup
cover
```

Supported stored assignment statuses are:

```text
pending
confirmed
declined
timed_out
replaced
removed
```

Current ownership is represented separately through:

```text
isCurrent
```

This allows historical assignments to survive replacement.

---

# Event Creator and Organiser Are Separate

The administrator who creates an event is not implicitly its organiser.

The following are separate concepts:

```text
event creator
primary organiser
backup organiser
cover organiser
```

This distinction should not be collapsed in later refactors.

---

# Organiser Service Boundaries

Important organiser domain services include areas such as:

```text
src/organisers/organiser-assignment-service.ts
src/organisers/organiser-response-service.ts
src/organisers/organiser-escalation-service.ts
src/organisers/organiser-cover-service.ts
src/organisers/organiser-safety-service.ts
src/organisers/organiser-scheduling.ts
```

Their broad responsibilities are:

```text
assignment service
    -> nominate, replace or remove primary/backup organisers

response service
    -> record confirm or decline decisions

escalation service
    -> progress from failed nominee to next ownership stage

cover service
    -> validate and claim general cover

safety service
    -> enforce the event-level organiser safety deadline

scheduling
    -> construct, reset and cancel durable organiser actions
```

Discord-facing adapters remain responsible for:

- slash-command input
- button input
- Discord member and role validation
- message formatting
- outbound notification orchestration
- audit output

---

# Organiser Feature Locking

The organiser subsystem has a server-level feature switch.

Normal organiser operations take a shared lock on the relevant guild settings row:

```text
guild_settings FOR SHARE
```

Disabling organiser functionality takes the corresponding exclusive lock:

```text
guild_settings FOR UPDATE
```

This means:

- an organiser mutation that starts first can complete consistently
- a disable operation that wins first prevents later organiser work from proceeding as though the feature were still enabled
- an in-flight operation cannot casually overtake feature disable using stale configuration

This locking contract should be preserved when adding new organiser operations.

---

# Organiser Activation

Organisers assigned to an unpublished event are dormant.

A dormant nominee typically has:

```text
activatedAt = null
responseDeadlineAt = null
```

Normal primary activation occurs when the public event is published.

At activation:

1. the assignment becomes active
2. `activatedAt` is stored
3. the response deadline is calculated
4. warning and timeout actions are scheduled where appropriate
5. the organiser notification is sent

This prevents internal event preparation time from consuming the organiser's response window.

---

# Organiser Notification Delivery

When organiser DM delivery is enabled, the preferred path is:

```text
DM
 |
 +---- success -> done
 |
 +---- failure -> private Event Administration channel
```

The fallback exists because users may block bot DMs or otherwise make DMs unavailable.

The Event Administration channel is an administrative fallback and should remain private enough for organiser-management notices.

---

## Organiser DM feature switch

A server-level flag controls DM-first delivery.

When enabled:

```text
try DM
then fallback to Event Administration
```

When disabled:

```text
skip DM
use Event Administration directly
```

This is separate from the parent organiser feature switch.

---

# Organiser Response Timing

Current configurable timing concepts include:

- primary response minutes
- backup response minutes
- warning minutes before response timeout
- general-cover safety minutes before event start

The default values are stored in guild configuration.

Current schema defaults are:

```text
Primary response: 70 minutes
Backup response: 35 minutes
Warning lead: 15 minutes
General-cover safety lead: 15 minutes
```

These are defaults, not universal domain constants.

---

# Organiser Warning Messages

Shortly before an active nominee's response deadline, the scheduler can post an administrative warning.

Because that message may remain visible after the organiser confirms, declines, times out, is replaced, is removed, or the event ends, its exact Discord location is stored on the assignment:

```text
warningChannelId
warningMessageId
```

The reconciliation service is represented by:

```text
src/events/organiser-warning-reconciliation.ts
```

A resolved organiser state causes the previously-posted warning to be edited into a resolved form where possible.

This avoids leaving misleading messages saying an organiser "has not yet confirmed" after the situation has already changed.

Deleted warning messages or deleted channels are treated as presentation failures rather than reasons to roll back authoritative organiser state.

---

# Organiser Cover Message Tracking and Reconciliation

General-cover requests and urgent missing-organiser-at-start alerts are durable Discord presentation rather than fire-and-forget messages.

Their Discord linkage is stored through:

```text
event_messages
```

using message kinds:

```text
organiser_cover
organiser_missing_at_start
```

Tracked rows retain:

```text
event
guild
channel
message
message kind
resolvedAt
deletedAt
```

Representative reconciliation service:

```text
src/events/organiser-cover-reconciliation.ts
```

The lifecycle is conceptually:

```text
cover/start message sent
        |
        v
store Discord linkage
        |
        v
message remains actionable
        |
        +---- cover claimed
        |
        +---- active organiser established
        |
        +---- superseded by T+0 alert
        |
        +---- organisers disabled
        |
        +---- event cancelled
        |
        +---- event completed
                |
                v
        edit tracked message
        remove components
        mark resolved
```

If Discord message creation succeeds but the database linkage cannot be stored, the newly-created candidate message is deleted where possible.

This prevents an untracked `Claim Event` button from being left behind while the scheduler later retries and creates another candidate.

The T+0 missing-organiser alert is also ordered deliberately.

An older general-cover message is reconciled only after the new T+0 message has been successfully sent and durably linked.

This ensures the event never loses its only usable claim surface merely because creation of the replacement alert failed.

Known deleted channels or messages are marked as deleted/resolved presentation where appropriate.

Unexpected Discord errors remain errors rather than being treated as proof of deletion.

---

# Organiser Escalation

The normal escalation path is:

```text
Primary
  |
  +---- confirms
  |       |
  |       v
  |   confirmed organiser
  |
  +---- declines or times out
          |
          v
       Backup
          |
          +---- confirms
          |       |
          |       v
          |   confirmed organiser
          |
          +---- declines or times out
                  |
                  v
             General cover
```

General cover is intended for eligible organisers rather than whichever Discord user happens to press the button first.

The cover service performs authoritative eligibility and ownership checks before establishing a new current cover assignment.

---

# Organiser Safety Deadline

Normal primary and backup response windows are not allowed to leave an event unresolved indefinitely as its start approaches.

Each published event with organisers enabled has an event-level safety deadline, normally:

```text
event start - organiserCoverBeforeStartMinutes
```

At this point, if no organiser has confirmed:

- unresolved current primary/backup nominees are retired
- obsolete nominee warning and timeout work is cancelled
- general cover becomes the authoritative path

This protects against awkward timing combinations where a late publication or slow nominee escalation would otherwise leave too little time to find cover.

---

# Missing Organiser at Event Start

A second stable event-level organiser action is due at the event start.

If an organiser is still missing and the event is still operational, the bot can issue an urgent administrative alert.

This is separate from the earlier general-cover safety deadline.

Conceptually:

```text
T - cover lead
    -> stop waiting for nominees
    -> ensure cover is open

T + 0
    -> if still unresolved
    -> send and track urgent missing-organiser alert
    -> reconcile older general-cover messages
```

The older general-cover message is not retired until the new event-start alert has been successfully sent and durably linked.

If scheduler catch-up occurs after the event has already ended, the missing-at-start action becomes harmless rather than posting a fresh urgent alert.

This check uses the event's absolute end time rather than depending solely on `complete_event` having already updated lifecycle status.

---

# Late Publication and Organiser Activation

Publication may occur after the normal organiser safety deadline.

In that case the bot must not blindly activate the dormant primary nominee with a full response window that is already operationally obsolete.

The current event schedule and safety deadline remain authoritative.

Late publication should therefore transition directly into the appropriate near-start cover behaviour rather than reviving an outdated nominee flow.

---

# Event Start Changes and Organiser Safety

Changing an event's start time recalculates event-level organiser safety actions.

Stable keys are used for:

```text
organiser_cover_deadline:<eventId>
organiser_missing_at_start:<eventId>
```

Rescheduling resets these actions to the newly-authoritative times.

A scheduler worker already holding an old attempt is fenced from overwriting the newer state.

The safety service also recalculates the current deadline when executing, so a stale claimed action cannot retire organiser ownership merely because it was due under the previous event time.

---

# Organiser Operational End Boundary

General organiser cover does not automatically become unclaimable merely because the event's start timestamp has passed.

If:

- the event has started but has not ended
- organiser functionality remains enabled
- no valid organiser has been established
- general cover remains the authoritative path

then an eligible organiser may still claim cover.

The event end is a hard operational boundary for new organiser escalation.

Once:

```text
endsAt <= now
```

the following paths become obsolete even if persisted event status has not yet reached `completed`:

```text
organiser warning
organiser timeout
organiser safety transition
missing-organiser-at-start alert
cover eligibility
cover claim
```

This distinction matters during scheduler recovery after downtime.

Overdue actions are processed independently, so an organiser action may be encountered before the later `complete_event` action has updated the event's lifecycle status.

Using `endsAt` prevents that catch-up ordering from generating fresh organiser activity for an event which has already finished.

The older blanket rule rejecting all post-start cover claims remains superseded.

---

# Planned Confirmed-Organiser Unavailability

A confirmed organiser cannot yet use a complete self-service "I am no longer available" workflow.

The intended future behaviour is:

```text
confirmed organiser
       |
       v
becomes unavailable
       |
       +---- activate viable backup
       |
       +---- otherwise use general cover
```

This should reuse existing organiser transition and cover infrastructure instead of introducing an unrelated replacement model.

---

# Role-Request Domain

Role requests represent willingness to perform event roles.

They do not represent guaranteed allocation.

Examples might include:

- Captain
- Supervisor
- 2-Gun Gunner
- Gunboat Gunner
- Carpenter
- command positions
- specialist event roles

Final allocation remains an organiser decision.

---

# Event-Level Role Options

Logical requestable roles are stored independently from Discord messages.

Representative table:

```text
event_role_options
```

An event role option contains concepts such as:

- stable logical key
- display name
- description
- request restriction
- capacity
- sort order
- active state
- optional source-preset provenance

The logical option belongs to the event.

It does not belong to one specific Discord request message.

---

# Role Requests Are Event-Level

A member's request is stored against:

```text
event
+ Discord user
+ event role option
```

not:

```text
request group
+ button
```

The source group may be stored for provenance, but it does not own the request.

This is what allows multiple Discord request groups to share one underlying volunteer pool.

---

# Independent Multi-Select Requests

Role requests are independent.

A user may request several roles for the same event.

For example:

```text
Captain
Carpenter
Gunboat Gunner
```

may all be requested simultaneously.

The domain is not currently modelled as a ranked first/second/third preference list.

---

# Duplicate Role Requests Are Not Toggles

Clicking a role the member has already requested does not automatically withdraw it.

Instead:

```text
existing request
    -> remains stored
    -> user receives an explanatory response
```

Explicit management controls handle withdrawal.

This reduces accidental loss of a request.

---

# Withdrawal Behaviour

Members can manage and withdraw their own requests explicitly.

A withdrawal removes the current role-request record.

If the member later requests the same role again:

- a new request is inserted
- it receives a new creation time
- it returns to the later position in request ordering

Withdrawal remains useful even after new requests have closed so an organiser can learn that a volunteer is no longer available.

Cancellation or completion is the final normal interaction boundary.

---

# Qualification Model

Event role options currently support:

```text
open
qualified_only
```

For `qualified_only`, eligibility is based on snapshotted Discord qualification roles.

Current qualification levels include:

```text
qualified
supervision_required
```

A supervision-required member is still allowed to express willingness for the role.

The distinction is then visible to organisers.

This supports cases where someone is allowed to perform the role only under suitable supervision.

---

# Qualification State and Availability

Useful current concepts include:

```text
qualified
supervision_required
unqualified
member_unavailable
```

Qualification answers:

```text
Is this member eligible for the role?
```

Current availability answers:

```text
Should this stored request currently appear as usable?
```

These should not be collapsed into one boolean.

---

# Qualification and Notification Audience Are Separate

A Discord role used as evidence that someone is qualified is not automatically the role that should be pinged when requests open.

These answer different questions:

```text
Qualification role
    -> who may request this role?

Notification role
    -> who should be informed that this request group opened?
```

This distinction is deliberate and should survive future configuration UI changes.

---

# Role-Request Groups

Discord-facing request messages are represented by:

```text
role_request_groups
```

with role mappings in:

```text
role_request_group_options
```

A group includes presentation and workflow configuration such as:

- name
- description
- channel
- authoritative message linkage
- notification role snapshot
- signup requirement
- opening rule
- resolved opening time
- closing rule
- resolved closing time
- explicit closure time
- source-preset provenance

One event may have several request groups.

---

# Shared Role Pools Across Groups

The same event role option may be mapped into more than one request group.

Example:

```text
Early Command Interest
    Captain
    Supervisor

Main Naval Roles
    Captain
    Supervisor
    Carpenter
```

Both Captain entries refer to the same event-level Captain option.

Therefore:

```text
Captain request in early group
Captain request in main group
```

are the same logical volunteer request.

There is not a separate "early Captain" pool and "main Captain" pool.

This is a core domain invariant.

---

# Signup-Gated Request Groups

A role-request group may require a positive attendance signup.

For those groups, adding a new request requires the member to currently be:

```text
Attending
or
Tentative
```

A different group may intentionally permit requests without a signup.

This allows early/private planning before the main event announcement or before members have made attendance decisions.

---

# Role-Request Availability After Attendance Changes

The request itself is retained even if the member's later attendance response makes it temporarily unavailable.

For example:

```text
request Captain
      |
      v
change attendance to Not Attending
      |
      v
Captain request remains stored
but appears unavailable
      |
      v
change attendance back to Attending
      |
      v
same request becomes available again
```

This avoids destroying expressed willingness because of a temporary attendance state change.

---

# Role-Request Group Timing

Request groups use signed offsets relative to event start.

For example:

```text
 60 = 60 minutes before event start
  0 = at event start
-10 = 10 minutes after event start
```

Both opening and closing rules use this convention.

The opening rule is nullable at event level.

---

## Event-level opening rule

For `role_request_groups`:

```text
openMinutesBeforeStart = number
```

means the group has an event-start-relative opening rule.

For example, a group snapshotted from a preset.

```text
openMinutesBeforeStart = null
```

means there is no event-relative opening rule.

The primary current example is an administrator-created group posted immediately.

This distinction is important when event start time changes.

---

## Closing rule

`closeMinutesBeforeStart` is non-null and uses the same signed convention.

The historical column name remains even though negative values mean "after start".

The system also stores the resolved absolute `closesAt`.

---

# Role-Request Group Lifecycle

Administrator-facing lifecycle resolution distinguishes:

```text
Planned
Pending publication
Open
Closed
```

Conceptually:

```text
future opensAt
messageId = null
    -> Planned

opensAt reached
messageId = null
    -> Pending publication

messageId exists
close not reached
closedAt = null
    -> Open

closedAt exists
or close deadline reached
    -> Closed
```

A group is not considered open merely because its planned opening time has arrived.

Until Discord publication succeeds and the authoritative message linkage exists, users do not have the normal request surface.

---

# Manual Role-Request Groups

Administrators may create and post event-level role-request groups directly.

These groups typically open immediately.

For those groups:

```text
openMinutesBeforeStart = null
opensAt = creation/post time
```

The closing time remains event-relative.

The absence of an opening offset is intentional and must not later be replaced with a synthetic value.

---

# Scheduled Role-Request Groups

Preset-derived groups can be configured to open in the future.

Preset application creates durable actions:

```text
role_request_group_open:<groupId>
role_request_group_close:<groupId>
```

in the same transaction as the event-level snapshot.

This ensures the group configuration and its future work cannot be partially created.

A due automatic opening does not necessarily publish immediately.

Event publication intent is also part of the decision.

Conceptually:

```text
due group
    |
    +---- event already published
    |       -> publish normally
    |
    +---- event has future scheduled publication
    |       |
    |       +---- publication time still future
    |       |       -> intentional early group may publish
    |       |
    |       +---- publication time reached but event still unpublished
    |               -> defer
    |
    +---- event held for manual publication
            -> defer
```

A deferred opening is parked durably at the group's closing boundary.

This is not treated as a scheduler failure and does not consume delivery retry attempts.

If the event publishes before the group closes, event publication wakes the opening action immediately.

If the event never publishes, the parked action eventually reaches the closing boundary and becomes obsolete.

---

# Role-Request Group Publication

Scheduled group publication is centralised in:

```text
src/role-requests/role-request-group-publication.ts
```

Publication re-checks:

- event ownership
- event lifecycle
- event publication state
- event publication intent
- group active state
- opening time
- closing time
- channel availability
- channel permissions
- notification role state

Possible outcomes distinguish normal obsolete or deferred states from environmental failure.

Representative outcomes include:

```text
already-posted
inactive
not-open-yet
awaiting-event-publication
window-expired
channel-unavailable
```

`awaiting-event-publication` is deliberate deferral rather than a delivery failure.

The publication-intent rules are:

```text
published event
    -> due group may publish

manual unpublished event
    -> automatic group waits

future scheduled event publication
    -> an earlier due group may publish intentionally

scheduled publication overdue but event still unpublished
    -> later group waits
```

Discord lookups and message sends cross an external boundary.

The service therefore re-checks authoritative state before sending and again before claiming the final message linkage.

If publication intent changes while the Discord send is in flight:

```text
Discord candidate created
        |
        v
authoritative event state re-read
        |
        v
candidate no longer permitted
        |
        v
database linkage rejected
        |
        v
candidate Discord message deleted
```

PostgreSQL remains authoritative.

---

# Role-Request Notification Roles

A request group can have an optional role to notify when it first opens.

The role ID and display-name snapshot are stored.

At publication time:

- a missing role does not destroy the group
- an unmentionable role is not pinged unless permissions allow it
- `@everyone` is not treated as a normal configurable role notification
- the group may still publish without the notification ping

A presentation failure should not erase valid persistent configuration.

---

# Concurrent Role-Request Publication

Two workers may attempt to publish the same group.

Both may reach Discord before PostgreSQL decides which linkage wins.

The publication flow therefore:

1. sends a candidate Discord message
2. conditionally records its message ID
3. treats PostgreSQL as the winner
4. deletes a losing unlinked duplicate

This mirrors the broader database-authoritative publication strategy.

---

# Role-Request Message Refresh and Recovery

Role-request presentation is built in:

```text
src/role-requests/role-request-message.ts
```

The same builder is used for:

- normal refresh
- deleted-message recovery

If the stored message exists, it is edited.

If Discord explicitly reports that the message was deleted:

1. the current group payload is rebuilt from PostgreSQL
2. a replacement is sent to the same authoritative channel
3. the message ID is conditionally replaced only if the old linkage still matches
4. a losing concurrent replacement deletes itself
5. the winning linkage is re-checked

Recovery does not recreate:

- the role-request group
- role options
- role requests
- scheduled close actions

It repairs presentation only.

Refresh and recovery suppress notifications so rebuilding a message does not replay the original role ping.

Deleted channels do not trigger guesswork about a replacement destination.

---

# Event Start Changes and Role Requests

When an event's start time changes, still-relevant role-request windows are recalculated.

The current rules are:

```text
planned group with non-null opening offset
    -> move opensAt
    -> move opening action
    -> move closesAt
    -> move closing action

already-posted group
    -> keep historical opening
    -> move closesAt
    -> move closing action

manual immediate group
open offset = null
    -> keep opening state
    -> move closesAt

closed group
    -> do not revive
```

If recalculated work should already be due, the durable action can be made immediately due without falsifying the stored domain timestamp.

Authoritative rescheduling resets:

- attempt count
- lock state
- completion state
- error state

because an administrator changing the schedule is not a failed retry attempt.

---

# Reusable Role-Request Presets

Reusable presets are a guild-level source configuration.

Representative tables include:

```text
role_request_presets
role_request_preset_options
role_request_preset_option_qualification_roles
role_request_preset_groups
role_request_preset_group_options
event_role_request_preset_applications
```

Presets are intended for repeated event structures such as:

```text
Naval
Naval Competition
Linebattle
Special Event
```

---

# Preset Role Options

Preset role options mirror event-level role options closely.

They contain reusable definitions such as:

- logical key
- display name
- description
- request restriction
- capacity
- sort order
- active state
- qualification-role snapshots

This mirroring is deliberate.

Preset application is primarily a snapshot operation, not a complicated interpretation layer.

---

# Preset Request Groups

A reusable preset group may contain:

- name
- description
- fixed channel or apply-time default resolution
- optional notification role
- positive-signup requirement
- signed opening offset
- signed closing offset
- ordered option mappings
- active state

The same reusable option may appear in multiple preset groups.

---

# Preset Channel Semantics

For a preset group:

```text
channelId = concrete Discord channel ID
```

means that channel should be copied when the preset is applied.

```text
channelId = null
```

means:

```text
resolve the guild's current default role-request channel at application time
```

After application, the resolved channel is copied into the event-level group.

The event does not continue following future changes to the guild default.

---

# Preset Snapshot Application

The application service is represented by:

```text
src/role-requests/role-request-preset-service.ts
```

Applying a preset is an authoritative transaction.

It validates and copies:

- active preset options
- role restrictions
- capacities
- qualification-role snapshots
- active preset groups
- resolved channels
- notification-role snapshots
- signup requirements
- opening and closing offsets
- group-option mappings
- source provenance
- durable group open/close actions

The application marker is stored in:

```text
event_role_request_preset_applications
```

with a composite identity:

```text
event + preset
```

This provides provenance and repeat-application protection.

---

# Preset Snapshot Semantics

Once a preset is applied:

```text
preset
   |
   | snapshot once
   v
event-level role-request configuration
```

Runtime role-request behaviour then uses the event-level data.

It does **not** consult the preset continuously.

Therefore:

- editing a preset later must not alter an existing event
- deactivating a preset later must not alter an existing event
- deactivating a preset option later must not alter an existing event
- deactivating a preset group later must not alter an existing event
- deleting a source record in a future supported workflow must not destroy the event's functional snapshot

Source IDs may remain as provenance, but not as live policy.

---

# Preset Locking Contract

Preset application takes a shared lock on the preset parent:

```text
role_request_presets FOR SHARE
```

Compliant preset mutation takes an exclusive lock on the same parent:

```text
role_request_presets FOR UPDATE
```

This provides a simple graph-level mutation fence.

Application therefore observes either:

```text
complete state before admin edit
```

or:

```text
complete state after admin edit
```

rather than a half-edited preset.

New preset edit operations should participate in this contract.

---

# Preset Lifecycle

Presets, options, and groups have independent active states.

The lifecycle controls are reversible and non-destructive.

---

## Parent preset deactivation

Deactivating the parent:

- prevents future application
- preserves options
- preserves groups
- preserves each child's independent active state
- does not affect event snapshots

Reactivation restores availability without resetting child configuration.

---

## Option deactivation

Deactivating a preset role option:

- excludes it from future applications
- preserves qualification rules
- preserves group mappings
- does not silently deactivate related groups

This may leave an active group with no active mapped options.

That intermediate configuration is permitted to exist.

The administrator is warned, and preset application rejects the invalid active graph until it is repaired.

This is preferred over silently changing neighbouring configuration.

---

## Group deactivation

Deactivating a preset request group:

- excludes the group from future applications
- preserves its configuration
- preserves option mappings
- does not change option active states

Reactivation restores the stored group definition.

---

# Planned Preset Editing

Current preset administration supports creation, inspection, application, and lifecycle control.

Complete editing of existing definitions is the next planned preset-management phase.

Expected areas include:

- preset metadata editing
- role-option display and policy editing
- qualification-role editing
- capacity editing
- request-group destination editing
- notification-role editing
- signup-gate editing
- opening and closing timing editing
- group-option mapping editing

These mutations should use the existing parent `FOR UPDATE` lock contract.

Existing event snapshots must remain unchanged.

---

# Reminders

Events support persistent reminders.

Representative table:

```text
event_reminders
```

Reminder timing can currently be relative to:

```text
event_start
signup_close
```

A reminder stores:

- event
- trigger/reference type
- offset
- resolved scheduled time
- content
- destination channel
- whether event ping roles should be included
- enabled state
- sent state
- missed state

---

# Reminder Destination Snapshot

The reminder stores the resolved channel ID.

It does not rely on the guild's default channel still being the same when the reminder fires.

This follows the same snapshot principle used elsewhere.

---

# Reminder Rescheduling

When event timing changes, pending reminders can be recalculated.

For example:

- event-start-relative reminders move when event start changes
- signup-close reminders move when signup close changes

Already-sent reminders do not become unsent.

---

# Missed Reminders

A reminder that has become too late to be useful should not necessarily be delivered just because its scheduled action remained pending.

The reminder can instead be recorded as missed with a reason.

This avoids messages such as "signups close in 10 minutes" being delivered after signups have already closed.

Missed reminders remain persistent and auditable.

---

# Reminder Limitation Relevant to Future Templates

Current reminder rescheduling logic was originally designed around existing event lifecycle states.

Before template-generated events begin creating reminders far ahead of publication, reminder validation must be reviewed carefully.

In particular, generated events may remain `scheduled` and unpublished for an extended period.

Template creation must not accidentally classify a valid future signup-close reminder as obsolete merely because the normal public attendance state has not opened yet.

This is a known implementation consideration for future template work.

---

# Immediate Announcements

Administrators can send immediate custom event announcements separately from persistent scheduled reminders.

Announcements are Discord-facing operations attached to an existing event context.

They should not be confused with event publication itself.

---

# Durable Scheduler

The scheduler is centred on:

```text
scheduled_actions
```

and:

```text
src/scheduler/event-scheduler.ts
```

An action stores concepts including:

- event ID
- stable action key
- due time
- status
- attempt count
- processing lock time
- completion time
- last error

Current action statuses are:

```text
pending
processing
completed
failed
cancelled
```

---

# Stable Action Keys

An action key identifies one logical piece of future work for an event.

Examples include:

```text
publish_event
close_attendance
complete_event

event_reminder:<reminderId>

organiser_warning:<assignmentId>
organiser_timeout:<assignmentId>
organiser_cover_request:<assignmentId>
organiser_cover_deadline:<eventId>
organiser_missing_at_start:<eventId>

role_request_group_open:<groupId>
role_request_group_close:<groupId>
```

Stable keys support:

- idempotent creation
- authoritative rescheduling
- cancellation
- conflict handling
- reasoning about stale workers

---

# Scheduler Claiming

Due actions are not executed merely because a query saw them as pending.

A worker must conditionally claim an action.

Conceptually:

```text
status = pending
dueAt <= now
attemptCount < max
```

then atomically:

```text
status -> processing
attemptCount -> attemptCount + 1
lockedAt -> now
```

Only a worker that successfully claims the row owns that attempt.

---

# Scheduler Attempt Limit

The scheduler has a bounded retry count.

A worker cannot create an attempt beyond the configured maximum.

This is enforced both in cleanup/selection logic and at the authoritative claim boundary.

Persisted inconsistent state at or above the maximum is repaired into terminal failure rather than executed indefinitely.

---

# Retry Backoff

Unexpected scheduled-action failures use increasing retry delays.

The current sequence begins:

```text
attempt 1 -> 1 minute
attempt 2 -> 2 minutes
attempt 3 -> 4 minutes
attempt 4 -> 8 minutes
attempt 5 -> terminal failure
```

The implementation caps general exponential delay growth.

The important invariant is bounded, increasing retries rather than the exact numbers becoming public API.

---

# Stale Processing Recovery

A process can stop after claiming an action.

The scheduler therefore detects stale `processing` rows.

If attempts remain:

```text
processing
stale lock
    -> pending
```

If the action already consumed its final permitted attempt:

```text
processing
stale lock
    -> failed
```

A final interrupted attempt must not be recovered into an impermissible extra execution.

---

# Scheduler Process Shutdown

Stopping future polling is not sufficient to stop the scheduler safely.

A scheduler tick which has already started may still be using:

- PostgreSQL
- Discord
- authoritative scheduled-action state
- external Discord side effects

The scheduler therefore tracks the currently active tick.

Graceful application shutdown follows this order:

```text
stop future scheduler intervals
        |
        v
wait for any active scheduler tick to finish
        |
        v
destroy the Discord client
        |
        v
close the PostgreSQL pool
```

`stopEventScheduler()` is therefore an asynchronous drain boundary rather than only a timer-cancellation operation.

The active tick is allowed to finish normally rather than being cancelled midway through database or Discord work.

This prevents process shutdown from closing shared resources underneath in-flight scheduler work.

Abrupt process loss remains a separate case. Durable scheduled-action state, stale-processing recovery, retry limits, and worker-ownership fencing continue to provide recovery when the process cannot shut down gracefully.

---

# Stale-Worker Completion Fencing

A worker may become stale, lose ownership, and later resume.

It must not then mark a newer retry or rescheduled action complete.

Completion and retry updates therefore require the worker still to own the same persisted attempt.

Conceptually:

```text
action id matches
status = processing
attemptCount = worker's claimed attempt
```

If another operation has already replaced that state, the old worker's update affects zero rows.

The newer state remains authoritative.

---

# Authoritative Rescheduling

Administrative schedule changes are not scheduler failures.

When a user deliberately changes event timing, affected durable actions can be reset to:

```text
status = pending
attemptCount = 0
lockedAt = null
completedAt = null
lastError = null
```

with the new due time.

This principle applies where the logical future work itself has been rescheduled.

A stale worker is fenced from overwriting the new authoritative version.

---

# Scheduler and Domain Revalidation

The existence of a due action does not prove that the action should still change the domain.

Each executor must re-check current state.

Examples:

```text
publish action
    -> event may already be published or cancelled

organiser timeout
    -> assignment may already be confirmed

cover deadline
    -> organiser may already be confirmed
    -> event start may have moved

role group open
    -> group may already be posted
    -> opening time may have moved
    -> window may already have expired

role group close
    -> group may already be closed
```

A durable action is a request to re-evaluate work at a time.

It is not permission to ignore newer authoritative state.

---

# Cancellation and Scheduled Work

When an event is cancelled, related scheduled work must become harmless.

Depending on the subsystem this may involve:

- explicitly cancelling pending/processing actions
- allowing a future executor to detect final event state and no-op
- reconciling Discord presentation

New action types must consider cancellation semantics deliberately.

---

# Completion

Automatic completion is stored as durable work.

Completion is a final normal event boundary for many interactive features.

Completion should not be inferred only from wall-clock time because the persisted state is authoritative.

---

# Concurrency Strategy

Concurrency-sensitive behaviour should prefer deterministic PostgreSQL ownership over timing assumptions.

Useful techniques in the codebase include:

- `FOR UPDATE`
- `FOR SHARE`
- conditional `UPDATE ... WHERE`
- unique constraints
- transactional state transitions
- stable action keys
- current-owner flags
- post-Discord authoritative re-checks
- cleanup of losing external side effects

---

# Lock Ordering

Lock ordering is important because several operations touch related rows.

A new transaction must not casually reverse an established order.

Examples of deliberate ordering include:

- organiser assignment ownership before event lifecycle locking in paths where the subsystem established that order
- role-request group locking before event locking in group lifecycle rescheduling
- preset parent locking before child mutation
- organiser feature-setting shared lock before relevant feature work

When adding a new cross-table transaction:

1. inspect neighbouring services
2. identify their lock order
3. preserve compatible ordering
4. add a deterministic concurrency regression if the new path can race

Deadlock avoidance is part of the architecture, not merely a database optimisation.

---

# Feature-Disable Race Handling

A feature switch should not be treated as an unlocked boolean read if operations may race with disabling it.

The organiser subsystem demonstrates the preferred pattern:

```text
normal operation
    -> shared lock on feature settings

disable operation
    -> exclusive lock on same settings
```

This pattern should be considered for future feature switches whose safe disable semantics require serialisation against in-flight work.

---

# Discord Error Classification

Discord failures should be classified narrowly.

Known terminal presentation conditions can receive special handling.

Examples include:

```text
Unknown Message
Unknown Channel
Unknown Role
```

An arbitrary network failure must not be treated as though Discord definitively reported a deleted message or channel.

Overly broad catch-and-ignore behaviour risks:

- duplicate messages
- false recovery
- hidden outages
- loss of scheduler retry opportunities

Unexpected failures should normally propagate where a durable retry mechanism exists.

---

# Message Recovery Principles

Automatic message recreation is appropriate only when:

- PostgreSQL proves the domain object still exists
- the authoritative destination is known
- Discord explicitly confirms the linked message is missing
- recreation will not replay notifications unexpectedly
- the replacement can be linked conditionally

Automatic recreation is **not** appropriate merely because:

- a fetch timed out
- Discord returned an unknown transient error
- the configured default channel has changed
- a destination can no longer be determined unambiguously

---

# Audit Architecture

Audit records are stored in:

```text
audit_logs
```

A record can contain:

- guild
- actor user
- action
- outcome
- summary
- target type
- target ID
- structured JSON details
- timestamp

A null actor represents a system/automatic action.

Audit outcomes are stored as flexible text rather than a PostgreSQL enum so adding a new outcome vocabulary does not require a schema migration.

An optional Discord log channel may mirror useful actions.

The PostgreSQL audit record remains the durable record.

---

# Time and Timezone Architecture

User-facing event creation uses named IANA timezones.

The authoritative event instant is stored in:

```text
startsAt
```

while the event also stores the timezone used for user-facing interpretation/display.

This lets the system preserve both:

```text
absolute instant
local event context
```

Daylight-saving ambiguity and invalid local times must be handled explicitly.

The bot should not silently guess when a local time occurs twice or does not exist.

---

# Database Schema Evolution

The Drizzle schema lives in:

```text
src/db/schema.ts
```

Versioned migrations live in:

```text
drizzle/
```

Application startup applies migrations before normal bot operation.

Applied migrations are historical records.

Once a migration may have run outside a disposable local environment, later changes should normally use a new migration rather than rewriting the old one.

---

# PostgreSQL Identifier Length

PostgreSQL limits identifiers to 63 bytes.

This became relevant when automatically-generated long composite constraint names were truncated into collisions.

Where a composite primary key, foreign key, or index name risks exceeding the limit, use an explicit concise constraint name.

This is not merely cosmetic.

A generated migration may otherwise contain two distinct logical constraints that PostgreSQL sees as the same truncated identifier.

---

# Major Database Concepts

The current schema includes concepts broadly grouped as follows.

## Guild configuration

```text
discord_guilds
guild_settings
event_types
event_audiences
```

## Template scaffolding

```text
event_templates
template_role_options
```

These tables are not evidence of a complete template product feature.

## Reusable role-request presets

```text
role_request_presets
role_request_preset_options
role_request_preset_option_qualification_roles
role_request_preset_groups
role_request_preset_group_options
```

## Events and presentation

```text
events
event_ping_roles
event_messages
```

## Attendance

```text
attendance_responses
actual_attendance
```

## Event-level role requests

```text
event_role_options
event_role_option_qualification_roles
role_request_groups
role_request_group_options
role_requests
event_role_request_preset_applications
```

## Scheduling and reminders

```text
scheduled_actions
event_reminders
```

## Administration

```text
audit_logs
event_organiser_assignments
```

The exact schema should be read from `src/db/schema.ts` rather than inferred solely from this conceptual list.

---

# Reusable Event Creation Boundary

One important architectural development has been extraction of database-side event creation from the Discord `/event create` adapter.

This matters for future templates and recurrence.

A template generator should eventually be able to call the same event-creation service rather than pretending to be a Discord slash command.

The creation service already accepts source/template provenance and organiser snapshots.

Future work should extend this boundary carefully instead of re-implementing event creation in a recurrence module.

---

# Testing as an Architectural Boundary

The project uses:

- unit tests
- direct service integration tests
- command-adapter tests
- real PostgreSQL via Testcontainers
- deterministic race/concurrency tests
- manual Discord smoke tests

New service extraction is considered incomplete if its important behaviour can only be exercised indirectly through a large Discord-command test.

Direct service integration tests are particularly valuable for:

- transaction boundaries
- ownership checks
- lock behaviour
- persistence
- scheduler state
- idempotency
- cross-table invariants

---

# Regression-First Behaviour Preservation

When a bug is found, the preferred workflow is:

```text
reproduce
   |
   v
write failing regression
   |
   v
confirm failure is for correct reason
   |
   v
implement narrow fix
   |
   v
add positive/companion coverage
   |
   v
run targeted subsystem tests
   |
   v
run full verification gate
```

The regression should demonstrate the broken invariant before production code is changed.

It does not normally need to be committed as a permanently red revision.

This practice is especially important around race conditions because apparently-simple refactors can reintroduce bugs whose symptoms only appear under concurrency.

---

# Deterministic Concurrency Tests

Concurrency tests should prefer explicit barriers and PostgreSQL locks.

Avoid using arbitrary sleeps as proof that one worker "probably" got there first.

Useful patterns include:

1. begin one transaction
2. acquire a known lock
3. start the competing operation
4. wait until it is blocked at a deterministic boundary
5. release the lock
6. assert the resulting authoritative state

This makes race regressions repeatable enough to belong in a normal automated suite.

---

# Manual Discord Testing Boundary

Automated tests should cover domain behaviour wherever practical.

Manual Discord testing remains valuable for concerns that mocks do not reproduce faithfully, including:

- guild slash-command registration
- channel selector behaviour
- role selector behaviour
- mentionability
- Discord permission combinations
- DM delivery
- fallback delivery
- visual embed layout
- button ergonomics
- deleted real messages
- cross-channel presentation

Manual testing complements the automated suite.

It should not substitute for regression coverage of database invariants.

---

# Known Structural Pressure Points

## `/event` command size

The `/event` command contains many administration functions.

Discord imposes command/subcommand limits, and the command is already broad enough that future growth should be considered carefully.

Possible eventual directions include separate top-level or grouped surfaces such as:

```text
/event
/organiser
/role-request
/reminder
```

Any redesign should preserve authorisation and domain-service boundaries rather than moving business logic around solely to change slash-command names.

---

## Large command modules

Some command files have accumulated substantial input parsing and response formatting.

Where a new feature adds reusable behaviour, prefer a dedicated domain/application service.

Avoid refactoring stable command code merely to satisfy an arbitrary file-size target.

---

## Scheduler breadth

`event-scheduler.ts` currently coordinates many action types.

Its behaviour is heavily regression tested, but increasing action diversity creates structural pressure.

Future refactoring may split action executors while retaining:

- one durable action model
- consistent claiming
- bounded retry
- stale recovery
- ownership fencing
- audit behaviour

The priority is preserving scheduler invariants rather than moving functions for cosmetic modularity.

---

## Event-level role-request ordering

Preset groups have explicit sort ordering.

Event-level group presentation does not currently require an equivalent general sort-order field in every workflow.

If future UI needs deterministic group ordering beyond ID/timing conventions, add that deliberately rather than assuming insertion order is a portable domain rule.

---

## Multiple preset applications

An event may potentially receive more than one distinct preset.

Event option logical keys remain unique per event.

Therefore separate presets can conflict if they define the same logical role key.

The application service treats this as a conflict rather than silently merging unrelated reusable definitions.

Future UX may make this clearer before application, but the database/domain behaviour should remain explicit.

---

# Planned Event Templates

Event templates are not yet a complete feature.

There is existing schema scaffolding including:

```text
event_templates
template_role_options
events.template_id
```

The intended model is:

```text
template
   |
   | generate/snapshot
   v
ordinary event
```

A generated event should behave like a normal one-off event after creation.

Runtime behaviour should not depend on continuously reading the template.

---

# Intended Template Defaults

A future template may provide reusable defaults for:

- event type
- audience/region
- timezone
- name/description
- local start time
- duration
- signup behaviour
- attendance-close timing
- publication timing
- ping roles
- organiser nominees/defaults
- role-request configuration
- reminders

The exact schema and administrator UX remain future work.

Existing template-related columns may need revision as this feature is implemented.

---

# Template Organiser Semantics

Future templates should be able to define primary and backup organiser defaults.

When an occurrence is generated:

```text
template organiser defaults
       |
       v
dormant event organiser assignments
```

Those assignments then follow the ordinary event organiser workflow.

The template should not itself become a live organiser assignment record.

---

# Template Role-Request Semantics

Reusable role-request presets should be leveraged rather than creating an incompatible second reusable role-request system.

The intended direction is that template occurrence creation can snapshot the required role-request configuration into the generated event.

After generation, that event remains independently editable.

---

# Template Reminder Semantics

Templates should eventually support reminder defaults.

Example:

```text
10 minutes before signup close
    -> remind members to sign up

10 minutes before event start
    -> ask members to join the event voice channel
```

For each generated occurrence:

```text
template reminder definition
        |
        v
ordinary event_reminders row
        |
        v
ordinary durable scheduled action
```

The reminder should then belong to that event.

Later template changes must not rewrite already-generated reminders automatically.

---

# Template Edit Semantics

The intended default is:

```text
edit template
    -> affects newly-generated occurrences
    -> does not silently rewrite existing generated events
```

A future explicit propagation feature could be designed separately.

It must not be assumed.

This is important because already-generated events may have been individually customised.

---

# Planned Recurrence

Recurring generation is planned after template support.

The likely representation is based on RFC 5545 recurrence rules.

A recurrence definition should describe the schedule.

It should not replace ordinary event rows.

---

# Rolling Generation Horizon

Recurring events should be generated using a rolling future horizon rather than materialising an unlimited series.

A working design target has been around several weeks, such as approximately 21 days, but the final value should remain configurable or revisitable.

Benefits include:

- fewer unnecessary rows
- simpler edits
- easier cancellation handling
- no need to generate years of hypothetical events
- template changes naturally affecting only not-yet-generated occurrences

---

# Immutable Recurrence Occurrence Identity

A recurring occurrence needs an immutable identity separate from its mutable `startsAt`.

This matters because an administrator may move one occurrence.

If identity were derived only from the event's current start timestamp:

```text
generate Monday event
move it to Tuesday
generator runs again
sees Monday missing
creates duplicate
```

Future recurrence work should therefore use a stable occurrence key derived from the recurrence schedule's original occurrence identity, not from the event's mutable current start time.

---

# Independent Generated Events

Once generated, an occurrence should be an ordinary independent event.

Administrators should be able to:

- edit its time
- edit its description
- change organisers
- change role requests
- change reminders
- cancel that occurrence

without rewriting the template or neighbouring occurrences.

This is the same snapshot philosophy already proven by role-request presets.

---

# Future Integration and Portability

The bot may eventually be integrated into another community bot or a web-facing system.

Portable candidates include:

- event creation services
- event lifecycle transitions
- attendance concepts
- organiser state machines
- role-request domain logic
- preset snapshot logic
- reminder scheduling
- durable action patterns
- audit concepts

Portability does **not** mean copying the current database schema wholesale.

A destination application should deliberately map:

- guild/server identity
- user identity
- event identity
- authorisation
- channels
- roles
- persistence
- migration history

into its own model.

---

# Portability Guidelines for New Code

When adding new functionality:

1. Keep Discord parsing in adapters where practical.
2. Keep reusable state changes in services.
3. Do not pass a complete Discord interaction object deep into domain logic unless Discord behaviour is truly required.
4. Prefer stable domain inputs such as IDs, snapshots, timestamps, and configuration values.
5. Preserve database authority.
6. Avoid generic abstractions that exist only in anticipation of unknown future frameworks.
7. Add direct tests around service boundaries.
8. Do not couple future template generation to slash-command parsing.
9. Do not couple preset runtime behaviour to the source preset after application.

---

# Error Handling Principles

Errors generally fall into three useful categories.

## Expected domain outcomes

Examples:

```text
event not found
preset inactive
already applied
organisers disabled
group window expired
role requests disabled
```

These should normally be represented as explicit service results.

---

## Expected external-state failures

Examples:

```text
Discord channel deleted
Discord role missing
Discord message deleted
bot lacks permission
```

These may be recoverable, ignorable for one side effect, or reportable depending on the operation.

They should be distinguished precisely.

---

## Unexpected failures

Examples:

- database outage
- unexpected Discord API failure
- transaction error
- unknown internal state

These should normally propagate to the appropriate retry/error boundary rather than being disguised as a normal domain result.

---

# Architectural Invariants Summary

The following invariants are particularly important.

## Events

- An unpublished event is still a real event.
- Publication state is separate from event lifecycle.
- Cancellation is final.
- Event-specific destinations should be snapshotted where later default changes would be unsafe.

## Attendance

- Signup intention and actual attendance are separate.
- No-signup events are valid first-class events.
- Tentative does not mean confirmed attendance.
- Attendance discrepancies are informational.

## Organisers

- Event creator and organiser are separate concepts.
- Unpublished-event nominees begin dormant.
- Primary normally activates at publication.
- Primary failure escalates to backup.
- Backup failure escalates to general cover.
- A safety deadline prevents nominee response windows from consuming the final pre-event period.
- Missing organiser at start receives separate urgent handling.
- Cover may remain claimable after start when the event is still unresolved.
- Normal organiser operations participate in the guild feature-lock contract.
- Assignment history is preserved instead of overwriting rows destructively.

## Role requests

- Role options belong to the event.
- Requests belong to event-level options, not request messages.
- Requests are independent and multi-select.
- Duplicate role clicks do not toggle withdrawal.
- Different request groups can share one underlying volunteer pool.
- Qualification and notification audience are separate.
- `supervision_required` is distinct from fully qualified.
- Signup-gated groups restrict new requests, not the existence of the event-level request itself.
- Event timing changes preserve the distinction between planned openings and manual immediate openings.
- Automatic role-group opening respects the parent event's publication intent.
- Manual-held events do not automatically expose scheduled role groups before publication.
- Deliberately earlier groups may precede an explicit future scheduled event publication.
- Successful event publication wakes already-due, still-valid deferred opening actions without pulling future groups forward.

## Presets

- Presets are reusable source configuration.
- Application snapshots into event-level state.
- Runtime does not continuously consult the preset.
- Preset application and preset mutation serialise through the parent-row lock.
- Parent, option, and group active states are independent.
- Lifecycle changes do not mutate existing event snapshots.
- Option deactivation does not silently deactivate groups.
- Group deactivation preserves mappings.

## Scheduler

- Important future work is durable.
- Claims are conditional.
- Retry count is bounded.
- Stale processing state is recoverable only while attempts remain.
- A stale worker cannot complete or reschedule a newer attempt.
- Administrative rescheduling resets stale retry metadata.
- Every executor revalidates authoritative domain state.

## Discord presentation

- Discord messages are not authoritative.
- Deleted messages may be rebuilt only when recovery is unambiguous.
- Recovery does not replay normal notification pings.
- Concurrent recovery or publication must leave only one authoritative linkage.
- Unknown/transient errors must not be treated as proof of deletion.

---

# Development Direction

The current architectural sequence is:

```text
Reusable role-request preset foundation
        |
        v
Preset application and durable group scheduling
        |
        v
Preset lifecycle management
        |
        v
Preset editing
        |
        v
Event templates
        |
        v
Recurring event generation
```

The first three stages are implemented.

Preset editing is the immediate next feature area.

Event templates and recurrence remain planned.

This sequence is deliberate because templates should depend on stable reusable configuration and reusable event-creation services rather than creating parallel implementations.

---

# Related Documentation

See:

- [`../README.md`](../README.md) for the public project overview
- [`DECISIONS.md`](DECISIONS.md) for durable product and engineering decisions
- [`ROADMAP.md`](ROADMAP.md) for planned work
- [`CURRENT-WORK.md`](CURRENT-WORK.md) for the current development checkpoint
- [`TESTING-GUIDE.md`](TESTING-GUIDE.md) for development and verification workflow
- [`ADMIN-GUIDE.md`](ADMIN-GUIDE.md) for the current Discord administration surface

When an apparently simpler implementation conflicts with a recorded invariant, review `DECISIONS.md` and the relevant regression tests before changing the behaviour.
