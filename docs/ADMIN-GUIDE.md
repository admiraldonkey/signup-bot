# Administrator Guide

**Last reconciled:** 10 September 2026

## Purpose

This guide describes the administrator-facing behaviour currently available in the Holdfast Event Bot.

It is intended for:

- Discord server administrators
- Event Admins
- event organisers
- collaborators testing the bot
- developers verifying user-facing workflows

This document describes **implemented functionality**.

Planned features such as full event templates, recurring event generation, and complete editing of existing role-request preset definitions are called out separately and should not be mistaken for current commands.

For implementation details, see:

- [`ARCHITECTURE.md`](ARCHITECTURE.md)
- [`DECISIONS.md`](DECISIONS.md)
- [`TESTING-GUIDE.md`](TESTING-GUIDE.md)
- [`ROADMAP.md`](ROADMAP.md)
- [`CURRENT-WORK.md`](CURRENT-WORK.md)

---

# Command Access

The bot currently registers these top-level commands:

```text
/ping
/dbcheck
/setup
/event
/role-preset
/attendance
/audit
```

## General permissions

Most event-management commands require either:

- the configured **Event Admin** Discord role
- Discord **Manage Server** permission

`/setup` requires **Manage Server** permission.

`/dbcheck` is also restricted to administrators with **Manage Server** permission.

Member-facing attendance, organiser, and role-request buttons use their own eligibility rules rather than the administrator command permission model.

---

# Initial Server Setup

A new Discord server should normally be configured in this order:

```text
1. /setup initialise

2. /setup configure

3. /setup regions

4. /setup features
   if organiser behaviour needs changing

5. /setup logging
   if Discord audit mirroring is wanted

6. /setup status
   to review the completed configuration
```

---

# `/setup initialise`

Initialises the current Discord guild for use with the event-management system.

Example:

```text
/setup initialise
```

This operation:

- registers the Discord guild in PostgreSQL
- creates its settings record
- enables the guild
- creates or refreshes the standard event types
- establishes the initial server timezone

Current standard event types include:

```text
Naval
Linebattle
Competition
```

The current standard event types support role requests.

Initialisation does **not** create the server's event regions. Use `/setup regions` separately.

Running initialisation again is safe and does not intentionally duplicate the guild.

---

# `/setup configure`

Configures the core Discord roles, channels, and organiser timings used by event management.

## Required options

| Option                 | Purpose                                                         |
| ---------------------- | --------------------------------------------------------------- |
| `event-admin-role`     | Discord role allowed to administer events without Manage Server |
| `attendance-channel`   | Default channel for public event and attendance messages        |
| `role-request-channel` | Default channel for role-request groups                         |

The attendance and role-request destinations may be standard text channels or announcement channels where Discord permits the required operations.

## Optional organiser configuration

| Option                         | Purpose                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `event-organiser-role`         | Restricts organiser assignments and cover to members holding this role           |
| `event-admin-channel`          | Private channel used for organiser administration and fallback notifications     |
| `organiser-primary-minutes`    | Time normally given to a primary organiser to respond                            |
| `organiser-backup-minutes`     | Time normally given to a backup organiser to respond                             |
| `organiser-warning-minutes`    | How long before timeout to post an organiser warning                             |
| `organiser-cover-before-start` | How long before event start unresolved nominees should give way to general cover |

Current default timing values are:

```text
Primary response window: 70 minutes
Backup response window: 35 minutes
Warning lead: 15 minutes
General cover safety lead: 15 minutes
```

These are defaults and may be changed per guild.

Setting:

```text
organiser-warning-minutes: 0
```

disables the pre-timeout warning.

When warnings are enabled, the warning lead must remain shorter than both organiser response windows.

## Channel permission expectations

The bot must be able to perform the required Discord operations in configured channels.

For ordinary event-management destinations this generally includes:

- View Channel
- Send Messages
- Embed Links
- Read Message History

Additional role mention permissions may be relevant when configured notification roles are used.

The bot validates important channel permissions during setup and again where necessary at operation time.

## Re-running `/setup configure`

Core required values are replaced with the newly selected values.

Optional organiser values that are not supplied should not be assumed to mean "clear the existing setting".

Use the current command behaviour deliberately when changing an existing setup.

---

# `/setup regions`

Creates or refreshes the standard event regions used by event creation.

Example:

```text
/setup regions
```

Current standard regions are:

```text
EU
NA
EU & NA
```

Their normal timezone defaults are based on:

```text
EU
    -> Europe/London

NA
    -> America/New_York

EU & NA
    -> server timezone
```

An individual event may override the region's default timezone.

Ping roles are not permanently tied to these regions.

They are selected separately when creating each event.

---

# `/setup logging`

Enables Discord mirroring of administrative audit activity.

Example:

```text
/setup logging
channel: #bot-log
```

The selected channel must allow the bot to post.

The Discord log is a convenience view.

The authoritative audit trail remains stored in PostgreSQL.

---

# `/setup logging-disable`

Disables Discord audit mirroring.

Example:

```text
/setup logging-disable
```

This does **not** disable persistent database auditing.

Administrative and automatic activity continues to be recorded where the application normally audits it.

---

# `/setup features`

Controls implemented server-level feature switches.

Current choices are:

```text
Organisers
Organiser DMs
```

Example:

```text
/setup features
feature: Organisers
enabled: No
```

---

## Organisers

Controls the organiser subsystem as a whole.

When disabled:

- new organiser assignments are blocked
- event creation with nominated organisers is blocked
- events without organisers may still be created
- relevant outstanding organiser workflows are retired or made harmless
- organiser presentation is reconciled where possible

The feature transition is designed to serialise safely against organiser operations already in progress.

---

## Organiser DMs

Controls how new organiser-assignment notifications are delivered.

When enabled:

```text
try organiser DM first
        |
        +---- success
        |
        +---- failure
                |
                v
Event Administration channel
```

When disabled:

```text
skip DM
    |
    v
Event Administration channel
```

Disabling organiser DMs therefore does not disable organisers.

It changes only the delivery route.

A configured Event Administration channel is required for direct administrative-channel delivery.

---

# `/setup status`

Displays the current event-management configuration for the guild.

Example:

```text
/setup status
```

The status output includes current information such as:

- whether the guild is enabled
- server timezone
- Event Admin role
- Event Organiser role
- organiser feature state
- organiser DM feature state
- attendance channel
- role-request channel
- Event Administration channel
- organiser primary response window
- organiser backup response window
- organiser warning timing
- organiser cover safety timing
- optional bot log channel
- configured event regions
- configured event types

Use this command after setup changes when you need to confirm what the bot currently believes is configured.

---

# Event Lifecycle Overview

An event is a persistent database object.

It does not need to be publicly posted immediately.

An event can broadly move through states such as:

```text
scheduled
open
closed
cancelled
completed
```

Publication is tracked separately.

This means an event may be:

```text
Scheduled
Unpublished
```

without being a draft or temporary record.

That distinction matters because unpublished events can already be:

- edited
- assigned organisers
- given reminders
- configured with role requests
- supplied with a reusable role-request preset
- scheduled for future publication

---

# Creating an Event

Use:

```text
/event create
```

## Required options

| Option        | Purpose                                                    |
| ------------- | ---------------------------------------------------------- |
| `event-type`  | Configured active event type                               |
| `region`      | Configured active event region                             |
| `name`        | Event name                                                 |
| `date`        | Event date in `YYYY-MM-DD` format                          |
| `time`        | Local event time in 24-hour `HH:mm` format                 |
| `ping-role-1` | Primary Discord role to notify when the event is published |

## Common optional options

| Option                         | Purpose                                                        |
| ------------------------------ | -------------------------------------------------------------- |
| `ping-role-2` to `ping-role-4` | Additional event notification roles                            |
| `timezone`                     | Overrides the selected region's timezone                       |
| `description`                  | Event description                                              |
| `primary-organiser`            | Nominated primary organiser                                    |
| `backup-organiser`             | Nominated backup organiser                                     |
| `signups`                      | Enables or disables attendance sign-ups                        |
| `publish-now`                  | Controls immediate publication                                 |
| `publish-minutes-before-start` | Schedules publication relative to event start                  |
| `duration-minutes`             | Event duration                                                 |
| `close-minutes-before`         | Signup closing time relative to event start                    |
| `detailed-deadline`            | Enables the detailed signup-deadline behaviour where supported |

Current default event duration is:

```text
60 minutes
```

The supported duration range is currently:

```text
30 to 480 minutes
```

---

# Date, Time, and Timezone Rules

Dates use:

```text
YYYY-MM-DD
```

Times use:

```text
HH:mm
```

Use named IANA timezones such as:

```text
Europe/London
America/New_York
```

Do not use ambiguous abbreviations such as:

```text
BST
EST
CST
```

The bot validates daylight-saving transitions.

If a supplied local time is ambiguous or does not exist because of a clock change, the bot rejects it rather than guessing.

An event must be created with a future start time.

---

# Event Ping Roles

Up to four ping roles can currently be supplied during event creation.

The first is required.

The bot prevents inappropriate values such as:

- `@everyone`
- integration-managed roles

Duplicate selections are normalised rather than creating duplicate event audience records.

The selected roles are snapshotted onto the event.

Changing a guild role configuration later does not cause the event to start following a different ping role automatically.

---

# Signup Modes

## Signups enabled

This is the normal attendance-response mode.

Members receive buttons for:

```text
Attending
Tentative
Not Attending
```

A signup closing time is configured and automatically scheduled.

---

## Signups disabled

Set:

```text
signups: No
```

for an event that does not need attendance intentions.

A no-signup event:

- has no attendance response buttons
- does not require a signup deadline
- may still use organisers
- may still use role requests where the event type permits them
- may still use reminders
- may still use announcements
- may still record actual attendance later

No-signup events are not treated as though members failed to sign up.

---

# Event Publication Modes

There are three supported publication styles.

## Immediate publication

This is the normal default.

Create the event with immediate publication enabled.

The event is stored first and then posted publicly.

---

## Scheduled publication

Supply:

```text
publish-minutes-before-start
```

The event is created now but its main public event message is posted later.

Example:

```text
publish-minutes-before-start: 120
```

means:

```text
publish two hours before event start
```

The scheduled publication time itself must still be in the future.

For signup-enabled events, scheduled publication must occur strictly before signup closure.

Publication at exactly the signup closing time is not considered valid.

---

## Manual publication

Set:

```text
publish-now: No
```

and do not supply an automatic publication offset.

The event remains unpublished until an administrator runs:

```text
/event publish
event-id: <ID>
```

---

# Unpublished Events

An unpublished event is still fully persistent.

It can already have:

- its final event ID
- event type
- region
- start time
- duration
- ping-role snapshots
- organiser nominees
- reminders
- event role options
- applied role-request presets
- scheduled actions

This makes it possible to prepare an event privately before its public announcement.

---

# Creating Events With Organisers

If organisers are enabled, `/event create` may include:

```text
primary-organiser
backup-organiser
```

Rules include:

- bot accounts cannot be nominated
- backup requires a primary
- primary and backup must be different
- where an Event Organiser role is configured, nominated users must hold it
- if the organiser subsystem is disabled, event creation with nominated organisers is rejected

Creating an event **without** organisers remains allowed when organiser functionality is disabled.

For unpublished events, nominated organisers begin dormant.

Their normal response countdown does not start merely because the event was created privately.

---

# `/event list`

Lists upcoming stored events.

Example:

```text
/event list
```

The output provides useful summary information including:

- event ID
- event name
- region
- start time
- lifecycle state
- publication state
- scheduled publication where relevant
- signup state and counts where relevant

The list is intentionally compact and currently returns a bounded number of upcoming events.

Use the event ID from this command for later administration.

---

# `/event publish`

Publishes an existing unpublished event immediately.

Example:

```text
/event publish
event-id: 42
```

This can also be used to publish an event earlier than its previously scheduled publication time.

Once manual publication succeeds, the old future publication action becomes harmless and does not post a duplicate event.

Publication is rejected where the event is no longer eligible, such as when it is:

- already published
- cancelled
- completed
- already started

Publication uses the destination stored for the event.

A later change to the guild's default attendance channel does not silently move the prepared event.

---

# Publication and Organiser Activation

For a normally timed event, publication activates the current primary organiser nomination.

This begins:

- organiser notification
- response timing
- warning timing where enabled
- timeout handling

There is an important exception near event start.

If the organiser safety deadline has already passed, late publication does not grant the dormant primary a brand-new full response window.

The event enters the appropriate cover or urgent organiser path instead.

---

# `/event edit`

Edits an existing non-final event.

Example:

```text
/event edit
event-id: 42
name: Sunday Naval
```

At least one actual edit option must be supplied.

## Editable areas

Current options allow changes to areas including:

- event name
- description
- event date
- event time
- timezone
- duration
- signup closing offset
- detailed deadline behaviour
- scheduled publication timing while still unpublished
- event ping roles

There are explicit clearing options for fields such as description and publication schedule where supported.

---

# Editing Description

Use a new description to replace the old one.

Use the explicit clear-description option to remove it.

Do not supply both:

```text
description
clear-description
```

in the same edit.

---

# Editing Publication Schedule

An unpublished event can have its scheduled publication adjusted or cleared.

Do not supply both:

```text
publish-minutes-before-start
clear-publish-schedule
```

in the same edit.

Once an event is already published, its historical publication schedule is no longer an editable future action.

---

# Editing No-Signup Events

A no-signup event has no signup closing workflow.

Therefore signup-close and detailed-deadline editing does not apply in the normal way.

The bot rejects incompatible edits rather than fabricating signup state for an event whose signups are disabled.

---

# Editing Event Time

Moving an event updates future work that depends on its schedule.

Current behaviour includes recalculating applicable:

- automatic completion
- signup closure
- scheduled publication
- pending reminders
- organiser safety actions
- planned role-request group opening
- role-request group closing

Historical state is not rewritten merely because the event moved.

For example:

```text
already-published request group
    -> keeps its historical opening
    -> receives a new closing time where appropriate
```

A closed group is not revived.

---

# Replacing Ping Roles During Edit

Supplying ping-role options during `/event edit` replaces the event's current ping-role set.

It does not append new roles onto the old list.

Review all desired event ping roles when using this part of the command.

---

# Editing an Event That Has Already Started

Normal timing edits are restricted after event start.

If an event needs to be moved after its original start time, the edit must establish a valid new future schedule rather than trying to alter already-expired timing in isolation.

---

# Published Event Refresh After Edit

When a published event changes, the bot refreshes the public attendance/event message where appropriate.

If signups were already closed, editing the event does not automatically reopen them.

Use `/event reopen` explicitly if reopening is appropriate and allowed.

---

# `/event responses`

Shows the current signup responses for a signup-enabled event.

Example:

```text
/event responses
event-id: 42
```

Responses are grouped by:

```text
Attending
Tentative
Not Attending
```

This is signup intention only.

It is not the final actual-attendance record.

---

# `/event close`

Closes attendance sign-ups immediately.

Example:

```text
/event close
event-id: 42
```

The bot also closes signups automatically when the stored closing time arrives.

Manual closure and scheduler closure use the same authoritative event state so a race does not create two competing lifecycle outcomes.

Closing signups does not cancel the event.

---

# `/event reopen`

Reopens attendance sign-ups where event lifecycle and timing permit it.

Example:

```text
/event reopen
event-id: 42
```

An optional new closing offset may be supplied.

Without another value, the reopened signup window currently defaults to closing at event start.

Reopening:

- is for signup-enabled events
- requires a suitable future event
- is not available for cancelled events
- is not available for completed events
- creates or reschedules the required closing work
- refreshes the event message

Reopening signups is an explicit administrator operation.

An unrelated event edit should not silently reopen a deliberately closed signup window.

---

# `/event cancel`

Cancels an event.

Example:

```text
/event cancel
event-id: 42
```

Cancellation is final.

The bot preserves useful historical records such as:

- signup responses
- role requests
- organiser history
- audit history

Relevant future scheduled work becomes cancelled or harmless.

If the event has already been published, its presentation is refreshed to show the cancelled state where possible.

Role-request and organiser presentation is also reconciled where applicable.

A later scheduler run must not revive the event.

---

# Cancellation Notifications

The current cancellation workflow updates the relevant event presentation.

A richer separate workflow for proactively notifying affected members is planned but not yet implemented as a complete feature.

Do not assume cancellation automatically sends a bespoke direct notification to every signed-up member.

---

# `/event refresh`

Rebuilds the public attendance/event message from current PostgreSQL state.

Example:

```text
/event refresh
event-id: 42
```

This is useful after:

- administrative changes
- presentation drift
- a deleted public event message

`/event refresh` does **not** publish an unpublished event.

Use `/event publish` for that.

---

# Deleted Event Message Recovery

If the event is already published and Discord explicitly reports that the linked attendance message was deleted, refresh can recreate it when the original destination channel remains known and usable.

Recovery:

- rebuilds the current message from PostgreSQL
- sends a replacement
- updates the authoritative linkage
- avoids replaying normal event role pings

If the destination channel itself has disappeared, the bot does not guess another channel automatically.

That requires deliberate administrator intervention rather than silent relocation.

---

# Overdue Signup Closure During Refresh

Refreshing an open signup-enabled event may also reconcile overdue signup closure when the stored closing deadline has already passed.

This keeps database lifecycle and presentation aligned rather than repainting an event as open when its authoritative signup window has expired.

---

# Event Organisers

The organiser system is designed for events where one person should become operationally responsible, with escalation if nominations fail.

The normal flow is:

```text
Primary
   |
   +---- confirms
   |       |
   |       v
   |    resolved
   |
   +---- declines or times out
           |
           v
        Backup
           |
           +---- confirms
           |       |
           |       v
           |    resolved
           |
           +---- declines or times out
                   |
                   v
              General Cover
```

Only one organiser should become the current owner of the event.

---

# `/event organiser-set`

Assigns or replaces a primary or backup organiser.

Example:

```text
/event organiser-set
event-id: 42
slot: Primary
user: @Member
```

Current slots are:

```text
Primary
Backup
```

Rules include:

- organisers must be enabled
- bots cannot be assigned
- where configured, the Event Organiser role is required
- primary and backup must differ
- backup requires a primary
- cancelled or completed events are not valid targets for normal organiser changes

Assignment history is preserved rather than overwritten destructively.

---

# Organisers on Unpublished Events

If an organiser is assigned while the event remains unpublished, the assignment is stored as dormant.

It does not immediately receive its normal response deadline.

This allows administrators to prepare an event without prematurely starting operational escalation.

---

# Organisers on Published Events

When the relevant organiser slot becomes active on a published event, the organiser receives a confirmation prompt through the configured delivery path.

Normal response timing starts from activation.

---

# `/event organiser-clear`

Removes the current nominated primary or backup organiser from that slot.

Example:

```text
/event organiser-clear
event-id: 42
slot: Backup
```

The old assignment remains in history with the appropriate resolved state.

This command should not be treated as a generic "delete every organiser state" operation.

The organiser subsystem maintains explicit ownership and history.

---

# Organiser Confirmation

An active nominee receives controls to confirm or decline.

If the organiser confirms:

- that assignment becomes confirmed
- competing nominee escalation becomes obsolete
- existing warning presentation is reconciled
- later stale timeout work cannot replace the confirmed owner

---

# Organiser Decline

If the primary declines:

```text
Primary
    -> declined

Backup
    -> activated if viable
```

If the backup declines:

```text
Backup
    -> declined

General cover
    -> requested
```

The actual transition always re-checks current database ownership.

A stale button does not get to overrule newer state.

---

# Organiser Warnings

When configured, the Event Administration channel receives a warning shortly before a nominee's response timeout.

If the nominee later:

- confirms
- declines
- times out
- is replaced
- is removed

the previously-posted warning is updated where possible so administrators are not left looking at stale "has not yet confirmed" messaging.

---

# Organiser Timeout

If a nominee does not respond before the stored deadline:

```text
Primary timeout
    -> backup where viable
    -> otherwise cover

Backup timeout
    -> general cover
```

The timeout path re-checks authoritative state.

A confirmation that already won the race remains authoritative.

---

# General Organiser Cover

If the primary and backup paths fail, the bot may request general cover in the configured Event Administration channel.

Eligible organisers can claim the event.

Where an Event Organiser role is configured, that role is used as part of cover eligibility.

The cover request is updated when someone successfully claims ownership.

Concurrent claims are resolved through the database so only one can become authoritative.

---

# Organiser Safety Deadline

Normal primary and backup response windows stop being the priority as event start approaches.

The guild setting:

```text
organiser-cover-before-start
```

defines when unresolved nominee flow should give way to general cover.

With the default:

```text
15 minutes
```

the system conceptually does:

```text
T - 15 minutes
    -> if still unresolved
    -> stop waiting on ordinary nominee timing
    -> move to general cover
```

This prevents a late backup response window from consuming the final useful minutes before the event.

---

# Missing Organiser at Event Start

The bot has a separate organiser safety check at the event's actual start.

If no valid organiser has been established by then, the system can raise a more urgent administrative warning.

This is separate from the earlier cover deadline.

---

# Late Event Publication

If an event is published after the organiser safety deadline, the system does not grant the dormant primary a fresh full normal response window.

Near-start operational safety takes precedence.

The event moves into the appropriate cover path instead.

---

# Cover Claims After Event Start

General cover may remain claimable after the event has technically begun.

This is deliberate.

If:

- the event is still operational
- organisers remain enabled
- nobody has taken valid organiser ownership
- general cover is still the active path

then an eligible organiser can still help by claiming it.

The old behaviour of rejecting every post-start cover claim has been superseded.

---

# Organiser DM Delivery

When **Organiser DMs** are enabled:

1. the bot tries to send the organiser prompt privately
2. if the DM cannot be delivered, it falls back to the Event Administration channel

When Organiser DMs are disabled:

1. the bot skips the DM
2. it sends the assignment notification directly to the Event Administration channel

This affects new assignment notification delivery.

It does not disable the organiser workflow itself.

---

# Confirmed Organiser Becomes Unavailable

A complete self-service workflow for a **confirmed** organiser to declare later unavailability is not yet implemented.

The intended future workflow is to reuse:

- backup activation
- organiser replacement
- general cover

rather than creating a separate emergency system.

For now, administrators should manage exceptional organiser changes using the available organiser administration tools and current event context.

---

# Event Role Requests

Role requests allow members to volunteer for event-specific responsibilities.

Examples include:

```text
Captain
Supervisor
Gunner
Carpenter
```

A role request means:

```text
I am willing to do this role
```

It does **not** mean:

```text
I have been assigned this role
```

Final selection remains an organiser decision.

---

# Role Requests Must Be Enabled for the Event Type

Role-request administration applies only where the selected event type permits role requests.

If role requests are disabled for the event type, related commands are rejected.

There is currently no separate implemented guild-wide Role Requests feature switch under `/setup features`.

That remains a possible future enhancement.

---

# Role Options and Request Groups

The role-request system deliberately separates:

```text
Logical event role option
```

from:

```text
Discord request group
```

For example, one event may have a single logical:

```text
Captain
```

option displayed in both:

```text
Early Command Interest
```

and:

```text
Main Naval Roles
```

Those are not two Captain pools.

They reference the same event-level Captain volunteer pool.

---

# `/event role-option-add`

Creates a requestable logical role option for one event.

Example:

```text
/event role-option-add
event-id: 42
name: Captain
restriction: Qualified only
qualified-role-1: @Captain
supervised-role-1: @Midshipman
```

## Required options

```text
event-id
name
```

## Optional configuration

Current configuration includes:

- description
- request restriction
- fully-qualified Discord roles
- supervision-required Discord roles

The direct event command currently creates the logical role option rather than posting any Discord request message.

Use `/event role-group-post` afterwards to expose one or more options to members.

---

# Role Restrictions

Current choices include:

```text
Open
Qualified only
```

## Open

Any otherwise eligible member may request the role.

---

## Qualified only

The member must hold one of the configured qualification roles.

A qualified-only option must have at least one qualification rule.

---

# Qualification Levels

Qualification roles can currently represent:

```text
Fully qualified
Supervision required
```

Both may permit the member to express willingness for the role.

The difference is shown to organisers.

This allows a developing member to volunteer while making clear that suitable supervision is needed.

---

# Qualification Role Rules

The bot prevents invalid qualification setup such as:

- using `@everyone`
- assigning the same Discord role as both fully qualified and supervision-required for the same option
- creating a qualified-only role with no qualification roles

Qualification roles answer:

```text
Who is allowed to request this event role?
```

They are not automatically the same as the role pinged when a request group opens.

---

# Logical Role Keys

The bot derives a stable logical key from the role-option name.

A duplicate logical key within the same event is rejected.

This helps ensure that one event does not accidentally contain two supposedly distinct definitions of the same logical requestable role.

---

# `/event role-option-list`

Lists the event's current role options.

Example:

```text
/event role-option-list
event-id: 42
```

The output provides useful information such as:

- event role-option ID
- logical key
- display name
- active state
- restriction
- qualification roles

The role-option IDs shown here are used by `/event role-group-post`.

---

# `/event role-group-post`

Creates and immediately posts a Discord request group for existing event role options.

Example:

```text
/event role-group-post
event-id: 42
name: Naval Roles
role-1: 15
role-2: 16
role-3: 17
```

This command is for an **event-level manual group**.

It posts immediately.

It does not create a future scheduled opening.

---

## Required group options

```text
event-id
name
role-1
```

Additional role-option IDs may be supplied through the remaining role fields.

Current command capacity supports several options in one request group.

Use IDs from:

```text
/event role-option-list
```

Do not use reusable preset option IDs here.

They belong to a different source configuration.

---

# Manual Role-Group Destination

The group may specify a channel.

If omitted, the configured default role-request channel is used.

The bot validates that the destination is suitable before completing the Discord publication.

---

# Manual Group Signup Requirement

A group can require a positive attendance signup before a member may add a new role request.

Where the event is already published and uses signups, the manual command normally defaults towards requiring signup.

For unpublished or no-signup workflows, the effective default differs so administrators can prepare early/private request groups where appropriate.

A signups-disabled event cannot have a group that meaningfully requires a positive signup.

---

# Manual Group Closing Time

A group can close:

- before event start
- at event start
- after event start

Use the explicit before-start or after-start options.

Do not enter negative numbers manually to represent after-start timing.

If no alternative is supplied, the current normal closing default is around event start.

The calculated close time must still be a valid future time when the group is created.

---

# Manual Group Notification Role

A request group may optionally ping a Discord role when it is first posted.

The role is independent from qualification roles.

The bot rejects unsuitable notification choices such as `@everyone`.

Required Discord mention permissions are validated where applicable.

Later refresh or recovery does not replay this normal opening ping.

---

# `/event role-group-list`

Lists the event's request groups and their current lifecycle.

Example:

```text
/event role-group-list
event-id: 42
```

Current administrator-facing states distinguish:

```text
Planned
Pending publication
Open
Closed
```

---

## Planned

The group has a future scheduled opening and no Discord request message yet.

---

## Pending publication

The planned opening time has arrived but the usable Discord message has not yet been linked successfully.

This can happen if Discord publication is delayed or unavailable.

A due opening timestamp alone does not mean the group is genuinely open to members.

---

## Open

The Discord request message exists and the group has not reached its closing boundary.

---

## Closed

The group has been explicitly closed or its authoritative close time has been reached.

---

# Immediate Versus Scheduled Group Opening

There are currently two important group-opening models.

## Manual `/event role-group-post`

```text
created now
posted now
open now
```

It has no event-relative future opening rule.

---

## Preset-derived group

```text
preset applied
        |
        v
event-level group created
        |
        v
durable opening action scheduled
        |
        v
message posted when opening arrives
```

The distinction matters when an event start time changes.

A manually-opened group remains historically open from when it was actually posted.

A future planned preset group moves with the event where its relative timing rule requires it.

---

# `/event role-group-close`

Closes a request group immediately.

Example:

```text
/event role-group-close
group-id: 23
```

Closing a group:

- prevents new requests through that group
- marks its scheduled close work complete or obsolete
- refreshes its Discord presentation where possible

Existing member role requests are not deleted merely because the presentation group closes.

Calling close on an already-closed group is handled idempotently.

---

# `/event role-requests`

Shows an organiser/admin view of role requests for an event.

Example:

```text
/event role-requests
event-id: 42
```

The output can include:

- requested role
- member
- request order
- other roles requested by that member
- qualification status
- supervision-required status
- attendance status
- current availability

Request order is useful context.

It is not automatic role allocation.

---

# Role Requests Are Independent and Multi-Select

A member may request several roles for one event.

For example:

```text
Captain
Carpenter
Gunboat Gunner
```

can all coexist.

Selecting one role does not replace the others.

The current system does not treat them as ranked first, second, and third preferences.

---

# Duplicate Role Button Presses

Pressing a role the member has already requested does not withdraw it.

The request remains stored and the user receives an explanatory response.

Withdrawal is a separate explicit action.

This protects members from accidentally losing their original request position by clicking the same button twice.

---

# Managing and Withdrawing Role Requests

Members can use the request-management interaction to review and withdraw their own role requests.

Withdrawing one request:

- removes that role request
- leaves the member's other role requests intact

If the member later requests the same role again, the new request receives a new request time and therefore a later request position.

Withdrawal may remain useful after a group has stopped accepting new requests because organisers still need to know when a volunteer is no longer available.

Cancelled and completed events form the normal final interaction boundary.

---

# Signup-Gated Role Requests

For a group that requires a positive signup, a member must currently be:

```text
Attending
or
Tentative
```

before adding a new request.

A member marked:

```text
Not Attending
```

cannot add a new request.

Even where a group does not require a positive signup, an explicitly Not Attending member is not treated as currently available for a new role request.

---

# Attendance Changes After Requesting

Changing attendance does not automatically destroy a member's stored role willingness.

Example:

```text
Member requests Captain

Member later selects Not Attending

Captain request remains stored
but is shown as unavailable

Member changes back to Attending

The same Captain request becomes available again
```

The original request time is preserved.

---

# Shared Role Pools Across Groups

If the same event role option appears in two groups, it remains one request.

Example:

```text
Early Command Interest
    Captain

Main Naval Roles
    Captain
```

A member who already requested Captain through the early group does not create a second Captain request by pressing it again later in the main group.

The organiser sees one shared Captain volunteer pool.

---

# Qualification During Role Requests

For a qualified-only option:

```text
Fully qualified role
    -> request allowed

Supervision-required role
    -> request allowed
    -> organiser can see supervision is required

No configured qualification role
    -> request rejected
```

The member's current Discord roles are used for eligibility.

---

# Role Capacity

Reusable preset options can store a capacity value.

The current role-request system should still be understood primarily as a **volunteer-interest system**, not a hard roster allocator.

Capacity does not mean:

```text
first N requesters are guaranteed the role
```

Automatic allocation, hard request limits, and waitlist semantics are not currently a complete feature.

Organisers remain responsible for final selection.

---

# Role-Request Message Recovery

If a linked role-request group message is deleted, later refresh-capable workflows can rebuild it from PostgreSQL when the authoritative channel still exists.

Recovery preserves:

- group configuration
- existing requests
- qualification state
- event state

It does not replay the group's original notification-role ping.

If the destination channel itself is gone, the bot does not silently move the request group elsewhere.

---

# Reusable Role-Request Presets

Reusable presets allow administrators to define a standard role-request structure once and apply it to future events.

Examples might include:

```text
Naval
Naval Competition
Linebattle
Special Event
```

A preset can contain:

- logical role options
- descriptions
- request restrictions
- capacities
- qualification-role snapshots
- supervision-required qualification roles
- multiple request groups
- ordered option mappings
- channel behaviour
- notification roles
- signup requirements
- opening times
- closing times

---

# Preset IDs and Event IDs

The preset system has its own IDs.

Be careful not to confuse:

```text
Preset ID

Preset option ID

Preset group ID

Event ID

Event role-option ID

Event role-request group ID
```

These are different objects.

For example:

```text
/role-preset group-add
```

uses **preset option IDs**.

```text
/event role-group-post
```

uses **event role-option IDs**.

Use `/role-preset show` and `/event role-option-list` to obtain the correct IDs.

---

# `/role-preset create`

Creates an empty reusable preset.

Example:

```text
/role-preset create
name: Naval
description: Standard naval role requests
```

A new preset begins active.

The preset name must be valid for the guild and cannot conflict with another existing preset where uniqueness rules prevent it.

Creating the preset does not create role options or groups automatically.

Use the option and group commands to build it.

---

# `/role-preset list`

Lists reusable presets for the guild.

Example:

```text
/role-preset list
```

By default, inactive presets are omitted.

Use the `include-inactive` option when you need to inspect retired or temporarily disabled presets.

The list includes useful summary information such as active option and group counts.

---

# `/role-preset show`

Displays the full reusable preset definition.

Example:

```text
/role-preset show
preset-id: 7
```

The administrator view includes inactive children as well as active ones.

Use this command to inspect:

- preset status
- option IDs
- option restrictions
- qualification roles
- capacity metadata
- group IDs
- group lifecycle state
- group mappings
- channel behaviour
- notification roles
- signup requirements
- opening rules
- closing rules

This is the main source for IDs required by later preset-administration commands.

---

# `/role-preset option-add`

Adds a reusable logical role option to a preset.

Example:

```text
/role-preset option-add
preset-id: 7
name: Captain
restriction: Qualified only
qualified-role-1: @Captain
supervised-role-1: @Midshipman
```

## Supported option configuration

Current fields include:

- name
- description
- request restriction
- capacity
- up to several fully-qualified Discord roles
- up to several supervision-required Discord roles

---

# Preset Option Qualification Rules

The same qualification principles as event-level options apply.

The bot rejects configurations such as:

- qualified-only option with no qualification role
- `@everyone` as a qualification role
- the same role selected as both fully qualified and supervision-required

The reusable role's logical key is derived from its name.

A conflicting key in the same preset is rejected.

---

# Inactive Presets Can Still Be Configured

Preset inactivity controls **application availability**.

It does not make the preset immutable.

Administrators can prepare or repair an inactive preset and reactivate it later.

---

# `/role-preset group-add`

Adds a reusable request group to a preset.

Example:

```text
/role-preset group-add
preset-id: 7
name: Main Naval Roles
role-1: 11
role-2: 12
open-minutes-before-start: 60
close-minutes-after-start: 10
```

The role fields use **preset option IDs** shown by `/role-preset show`.

Only suitable active preset options can be mapped into a new group.

Duplicate role-option selections are rejected.

---

# Preset Group Channel Behaviour

A preset group can either use:

```text
a fixed Discord channel
```

or:

```text
the guild's default role-request channel at application time
```

## Fixed channel

Supply a channel when creating the preset group.

The bot validates the selected destination.

That channel is copied into future event snapshots.

---

## Apply-time default

Leave the channel unset.

When the preset is later applied to an event, the bot resolves the guild's then-current default role-request channel and stores that resolved channel on the event group.

This does **not** mean the event follows the guild default forever.

After application, later guild configuration changes do not silently move the event's request group.

---

# Preset Group Signup Requirement

A reusable group can require positive signup.

This requirement is validated when the preset is applied.

A group requiring signup cannot be successfully applied into a signups-disabled event.

---

# Preset Group Opening and Closing

Preset groups support event-relative opening and closing offsets.

Examples:

```text
open 60 minutes before start

close at event start

close 10 minutes after start
```

Use the before-start and after-start command options rather than manually entering negative values.

Opening must occur strictly before closing.

---

# Preset Group Notification Role

A reusable request group can store a Discord role to notify when the group opens.

That notification audience remains separate from qualification roles.

The bot validates inappropriate notification roles such as `@everyone`.

---

# `/role-preset apply`

Applies an active reusable preset to an existing event.

Example:

```text
/role-preset apply
preset-id: 7
event-id: 42
```

Application creates an **event-level snapshot**.

It copies the relevant active reusable configuration into normal event records.

This includes:

- active role options
- restrictions
- qualification roles
- active request groups
- mappings
- resolved channels
- notification metadata
- signup rules
- opening timing
- closing timing

It also creates the durable opening and closing work needed by the snapshotted groups.

---

# Applying a Preset Does Not Immediately Post All Groups

Preset application stores the event-level configuration and scheduler work.

Each group is posted when its configured opening time arrives.

For example:

```text
Preset applied at T - 3 days

Group configured to open at T - 60 minutes

No group message is posted at application time

Scheduler posts it at T - 60 minutes
```

Use:

```text
/event role-group-list
```

to inspect the planned event-level groups after application.

---

# Preset Application Validation

Application may be rejected when the current reusable configuration is not valid for the target event.

Examples include:

- preset is inactive
- preset belongs to another guild
- event belongs to another guild
- event type does not permit role requests
- active group has no usable active options
- required signup conflicts with a no-signup event
- default role-request channel cannot be resolved
- opening and closing rules are invalid
- event already contains a conflicting logical role key

The transactional application service performs final validation even if the Discord command already performed preliminary checks.

---

# Applying the Same Preset Twice

The same preset cannot be successfully applied repeatedly to the same event.

The bot records application provenance and returns an already-applied result instead of duplicating the snapshot.

When manually testing several application scenarios, use a fresh event after a successful application.

---

# More Than One Preset on an Event

The architecture can permit different presets to be considered for the same event.

However, event role-option logical keys remain unique.

Two presets that define conflicting logical role identities may therefore be rejected rather than silently merged.

Do not assume separate presets are automatically composable.

---

# Preset Snapshot Independence

After successful application:

```text
Preset
    |
    | snapshot once
    v
Event-level role-request configuration
```

The event then owns its copy.

Later changes to the source preset do not modify that event.

This applies to:

- preset deactivation
- option deactivation
- group deactivation
- future preset editing
- future mapping changes

To inspect the event's resulting operational state, use the event-level commands rather than assuming the source preset still describes it exactly.

---

# `/role-preset set-active`

Activates or deactivates an entire reusable preset.

Example:

```text
/role-preset set-active
preset-id: 7
active: No
```

Deactivating a preset:

- prevents new application
- hides it from the normal active-only list
- preserves its options
- preserves its groups
- preserves each child's own active or inactive state
- leaves existing event snapshots unchanged

Reactivating it restores application availability.

Requesting the state it already has returns a no-change result.

---

# `/role-preset option-set-active`

Activates or deactivates one reusable preset role option.

Example:

```text
/role-preset option-set-active
preset-id: 7
option-id: 11
active: No
```

Deactivating an option:

- excludes it from future event snapshots
- preserves qualification rules
- preserves request-group mappings
- does not alter existing event snapshots
- does not automatically deactivate any group that uses it

Reactivation restores the stored option.

---

# Preset Option Validity Warning

If deactivating an option leaves an active preset request group with no remaining active mapped options, the command warns the administrator.

The group itself remains active.

This is deliberate.

The bot does not silently decide that the group should also be deactivated.

Until the configuration is repaired, preset application rejects the unusable active graph.

Possible repairs include:

- reactivate the option
- add another suitable option to the group once editing support exists
- deactivate the affected group

---

# `/role-preset group-set-active`

Activates or deactivates one reusable request group.

Example:

```text
/role-preset group-set-active
preset-id: 7
group-id: 21
active: No
```

Deactivating a group:

- excludes it from future event snapshots
- preserves its mapped options
- preserves its timing
- preserves its channel configuration
- preserves its notification configuration
- preserves its signup configuration
- leaves the option lifecycle states unchanged
- leaves existing event snapshots unchanged

Reactivation restores the stored reusable group.

Repeatedly asking for the state it already has returns a no-change result.

---

# Current Preset Administration Limitation

The current preset subsystem supports:

```text
create
list
show
option-add
group-add
apply
set-active
option-set-active
group-set-active
```

A complete command workflow for editing existing preset fields is **not yet implemented**.

For example, there is not yet a complete supported administrator flow for changing an existing preset's:

- name
- description
- option metadata
- qualification mappings
- request-group timing
- destination
- notification role
- option mappings

That is the next planned preset feature phase.

For now, lifecycle controls are non-destructive and can be used to temporarily retire configuration without deleting it.

---

# Reminders

Event reminders are persistent scheduled messages.

They are separate from:

- event publication
- immediate announcements

A reminder represents future durable work.

---

# `/event reminder-add`

Adds a persistent reminder to an event.

Example:

```text
/event reminder-add
event-id: 42
relative-to: Event start
minutes-before: 10
message: Please begin joining the event voice channel.
```

## Required reminder options

```text
event-id
relative-to
minutes-before
message
```

Current reference choices include:

```text
Event start
Signup close
```

An optional destination channel may be supplied.

If no channel override is provided, the command uses the event's normal attendance/publication destination.

The reminder can also optionally ping the event's snapshotted ping roles.

---

# Signup-Close Reminders

A reminder relative to signup closure requires a signup-enabled event with a valid signup closing time.

A no-signup event has no signup-close reference point.

---

# Reminder Timing

The reminder's absolute scheduled time is calculated from:

```text
reference time
-
minutes-before
```

The resulting reminder must still be meaningful and valid.

The bot does not intentionally send obsolete reminder text after its purpose has already passed.

---

# `/event reminder-list`

Lists persistent reminders for an event.

Example:

```text
/event reminder-list
event-id: 42
```

Use this to obtain reminder IDs for editing or removal.

---

# `/event reminder-edit`

Edits a pending reminder.

Example:

```text
/event reminder-edit
event-id: 42
reminder-id: 8
minutes-before: 20
```

Editable areas include relevant reminder fields such as:

- timing reference
- minutes before
- message
- destination
- event-role ping behaviour

Changing timing reschedules the corresponding durable action.

Already-sent or otherwise-final reminders are not treated as ordinary unsent reminders that can simply be moved backwards in time.

---

# `/event reminder-remove`

Removes a pending reminder.

Example:

```text
/event reminder-remove
event-id: 42
reminder-id: 8
```

Its scheduled delivery becomes cancelled or otherwise harmless.

---

# Reminder Behaviour After Event Editing

Pending reminders tied to event timing are recalculated when their reference changes.

For example:

```text
event-start reminder
    -> moves when event start moves

signup-close reminder
    -> moves when signup close moves
```

An already-sent reminder is not sent again merely because the event was edited.

---

# Missed Reminders

If a reminder can no longer be sent meaningfully, it may be recorded as missed instead of delivered late.

For example, the bot should not intentionally send:

```text
Signups close in 10 minutes
```

after signups have already closed.

Durability exists to preserve useful future work, not to guarantee the delivery of nonsense on schedule plus several hours.

---

# `/event announce`

Sends an immediate event-related announcement.

Example:

```text
/event announce
event-id: 42
message: Teams have now been assigned.
```

An optional channel may be supplied.

The command can optionally ping the event's snapshotted ping roles.

An announcement:

- is sent immediately
- does not create a future reminder
- does not change the event's publication state
- does not change the event lifecycle merely because a message was sent

---

# Actual Attendance

Attendance signups record intent.

Actual attendance records observed presence.

They are separate datasets.

For example:

```text
Attending
```

before an event does not automatically prove the member attended.

Likewise, someone may attend without having selected Attending beforehand.

---

# `/attendance record`

Replaces the complete actual-attendance set for one event.

Example:

```text
/attendance record
event-id: 42
attendees: @MemberA @MemberB @MemberC
```

The attendees input can use the supported mention/ID format.

A special no-attendees input is supported for intentionally recording an empty attendance set.

An optional source/reference note can be stored where useful.

Use this command when supplying the authoritative full list.

Because it replaces the existing set, do not use it casually when you only mean to add one person.

---

# `/attendance add`

Adds one member to recorded actual attendance without replacing the rest of the attendance set.

Example:

```text
/attendance add
event-id: 42
user: @Member
```

---

# `/attendance remove`

Removes one member from recorded actual attendance without replacing everyone else.

Example:

```text
/attendance remove
event-id: 42
user: @Member
```

---

# `/attendance compare`

Compares signup intention with recorded actual attendance.

Example:

```text
/attendance compare
event-id: 42
```

Useful distinctions include:

- attended as expected
- signed up Attending but absent
- Tentative and attended
- Tentative and absent
- selected Not Attending but attended
- attended without a signup

These results are informational.

They are not automatic disciplinary judgements.

---

# Tentative Attendance

Tentative means uncertainty.

A Tentative member who does not attend should not automatically be interpreted in the same way as a confirmed Attending member who does not appear.

Reports preserve this distinction.

---

# No-Signup Events and Attendance Comparison

Actual attendance can still be recorded for a no-signup event.

However, the event should not produce ordinary signup-reliability conclusions because no signup obligation existed.

There is no meaningful "walk-in versus signup" discrepancy when the event deliberately did not collect signups.

---

# `/attendance user`

Displays attendance history or reliability context for one member.

Example:

```text
/attendance user
user: @Member
```

Optional filters include areas such as:

- event type
- start date
- end date

Use this as administrative context rather than an automatic disciplinary score.

---

# `/attendance issues`

Lists notable signup-versus-attendance discrepancies across relevant events.

Example:

```text
/attendance issues
```

Optional filters include areas such as:

- event type
- date range
- result limit

The report is intended to help administrators identify patterns worth understanding.

It does not automatically punish members.

Real participation can have legitimate context that the current attendance model does not yet capture fully.

---

# Participation Context Limitation

Actual attendance currently focuses primarily on whether someone was present.

A richer event-specific model distinguishing participation such as:

```text
participant
supervisor
organiser
server administrator
other
```

is planned but not yet complete.

Until then, administrators should interpret attendance discrepancies with appropriate context.

---

# Audit Log

The bot records administrative activity in PostgreSQL.

This remains true even if Discord log mirroring is disabled.

---

# `/audit recent`

Displays recent audit activity.

Example:

```text
/audit recent
```

Optional filters include:

- result limit
- user
- outcome

Current outcome filtering includes concepts such as:

```text
Success
Denied
Failure
```

Automatic actions may appear with system attribution rather than a Discord user actor.

---

# Database Audit Versus Discord Logging

These are separate concepts.

```text
PostgreSQL audit
    -> authoritative persistent record

Discord bot-log channel
    -> optional convenience mirror
```

Turning off Discord logging does not stop normal database auditing.

---

# `/ping`

Basic bot responsiveness check.

Example:

```text
/ping
```

Use this to confirm that the Discord bot process is responding.

It is not a full health diagnosis.

---

# `/dbcheck`

Administrative PostgreSQL connectivity check.

Example:

```text
/dbcheck
```

This command requires appropriate server-management permission.

Use it when you need to distinguish:

```text
bot is online
```

from:

```text
bot can currently reach PostgreSQL
```

It is a diagnostic command rather than an event-management workflow.

---

# Common Administrator Workflow

A typical one-off event might use the following sequence.

## 1. Create the event

```text
/event create
```

Choose:

- type
- region
- date
- time
- ping roles
- signup behaviour
- publication behaviour
- organisers where needed

---

## 2. Configure reusable or event-specific role requests

For an established event format:

```text
/role-preset apply
```

For bespoke manual setup:

```text
/event role-option-add
/event role-group-post
```

Remember:

```text
manual role-group-post
    -> posts immediately

preset application
    -> creates planned groups
    -> scheduler posts them at their configured opening times
```

---

## 3. Add reminders

Example:

```text
/event reminder-add
```

Possible uses include:

- signup reminder
- voice-channel reminder
- preparation reminder

---

## 4. Prepare organisers

If organisers were selected during creation, unpublished-event nominees remain dormant.

They normally activate when the event is published unless the organiser safety deadline has already superseded ordinary nominee timing.

Additional organiser changes can use:

```text
/event organiser-set
/event organiser-clear
```

---

## 5. Publish

Depending on the creation mode:

```text
Immediate
```

requires no later administrator action.

```text
Scheduled
```

publishes automatically.

```text
Manual
```

requires:

```text
/event publish
```

---

## 6. During the signup period

Members use:

```text
Attending
Tentative
Not Attending
```

Role-request groups open according to their own timing.

Administrators can inspect:

```text
/event responses
/event role-requests
/event role-group-list
```

---

## 7. Near event start

The bot can automatically:

- close signups
- send reminders
- close role-request groups
- escalate unresolved organisers
- move to general organiser cover
- warn if the event still lacks an organiser at start

Administrators can still intervene through the normal event and organiser commands.

---

## 8. After or during the event

Record actual attendance with:

```text
/attendance record
```

or adjust individual members with:

```text
/attendance add
/attendance remove
```

Then inspect:

```text
/attendance compare
```

where useful.

---

# Preparing an Event Before Public Announcement

A more advanced workflow is:

```text
/event create
publish-now: No
```

or create it with scheduled publication.

Before publication, administrators can:

- inspect the event
- edit it
- assign organisers
- add reminders
- add bespoke role options
- apply a role-request preset

This is intentional.

The event is persistent before the public announcement exists.

---

# Reusable Preset Workflow

A normal reusable preset workflow is:

```text
/role-preset create
        |
        v
/role-preset option-add
        |
        v
/role-preset group-add
        |
        v
/role-preset show
        |
        v
apply to fresh event
        |
        v
/event role-option-list
/event role-group-list
```

Use lifecycle commands when temporarily retiring reusable configuration:

```text
/role-preset set-active

/role-preset option-set-active

/role-preset group-set-active
```

Do not expect lifecycle changes to rewrite events that already received the preset.

---

# Example Preset Timing

Suppose a preset group is configured:

```text
Open 120 minutes before event start
Close 10 minutes after event start
```

Applying it three days before the event creates the event-level group immediately but does not post the Discord request message yet.

The lifecycle might look like:

```text
Three days before
    -> Planned

T - 120 minutes
    -> scheduler attempts publication

Publication succeeds
    -> Open

T + 10 minutes
    -> Closed
```

If Discord cannot publish when the opening time arrives:

```text
Pending publication
```

accurately describes the state until publication succeeds or the window becomes obsolete.

---

# Event-Time Change Example

Suppose an event is moved from:

```text
20:00
```

to:

```text
21:00
```

A planned preset group configured to open:

```text
60 minutes before
```

moves from:

```text
19:00
```

to:

```text
20:00
```

Its closing rule moves similarly.

A manual group already posted at 18:30 remains historically opened at 18:30.

Only its still-relevant future closing time moves.

This prevents event editing from rewriting things that have already happened.

---

# Snapshot Behaviour Administrators Should Know

Several areas intentionally use snapshot semantics.

## Event ping roles

Selected when the event is created or explicitly edited.

Later server default changes do not rewrite the event automatically.

---

## Publication destination

Stored for the event.

Changing the guild attendance channel later does not silently move an already-prepared event.

---

## Role-request preset application

Copied into ordinary event-level role-request records.

Later source-preset changes do not rewrite the event.

---

## Preset default channel resolution

A preset group with no fixed channel resolves the current guild default **when the preset is applied**.

The resulting event group then owns that channel.

---

## Qualification roles

Relevant role identity and readable snapshots are stored as part of reusable or event-level configuration.

Later Discord changes do not cause the event to begin following a completely different qualification role automatically.

---

# Common ID Mistakes

The bot exposes several numeric internal IDs to make administration explicit.

These IDs are not interchangeable.

## Event ID

Used by commands such as:

```text
/event edit
/event publish
/event responses
/event role-option-list
/event role-group-list
/event role-requests
/event reminder-add
/attendance record
```

---

## Event role-option ID

Shown by:

```text
/event role-option-list
```

Used by:

```text
/event role-group-post
```

---

## Event role-request group ID

Shown by:

```text
/event role-group-list
```

Used by:

```text
/event role-group-close
```

---

## Preset ID

Shown by:

```text
/role-preset list
```

Used by the other `/role-preset` administration commands.

---

## Preset option ID

Shown by:

```text
/role-preset show
```

Used when creating reusable preset groups or changing option lifecycle.

---

## Preset group ID

Shown by:

```text
/role-preset show
```

Used when changing reusable group lifecycle.

When a command rejects a perfectly real ID, confirm that it is the correct **kind** of ID before assuming the bot has developed a philosophical objection to integers.

---

# Troubleshooting

## "Server is not initialised"

Run:

```text
/setup initialise
```

with Manage Server permission.

Then complete the rest of the setup.

---

## Event-management command says I am not authorised

You need either:

- the configured Event Admin role
- Manage Server permission

Check:

```text
/setup status
```

if you believe the configured role is wrong.

---

## Organiser assignment is rejected

Check:

- `/setup features` has Organisers enabled
- the selected member is not a bot
- backup has a primary
- primary and backup differ
- the member holds the configured Event Organiser role if one is required
- the event is not cancelled or completed

---

## Organiser DM did not arrive

If Organiser DMs are enabled, the bot falls back to the Event Administration channel when the DM cannot be delivered.

Check:

- Event Administration channel is configured
- bot can see and send in that channel
- the organiser workflow is still current

If Organiser DMs are disabled, the administrative channel is the expected delivery route.

---

## Organiser warning still says someone has not confirmed

The bot normally reconciles posted warnings after organiser resolution.

If a warning remains stale:

- confirm the current organiser state
- confirm the warning message still exists
- confirm the Event Administration channel still exists
- inspect audit/error output

This should be treated as a presentation/reconciliation issue rather than manually changing database state.

---

## A scheduled event did not publish

Check:

- event is not already published
- event is not cancelled
- event is not completed
- event start has not passed
- publication destination still exists
- bot still has channel permissions
- `/event list` for current status
- audit logs
- scheduler or application logs if you administer the deployment

Do not create a duplicate replacement event before checking whether the original persistent event still exists.

---

## Event message was deleted

For a published event, try:

```text
/event refresh
event-id: <ID>
```

If the original authoritative channel still exists, the bot may recreate and relink the presentation.

It should not re-ping the normal event audience during recovery.

---

## Role-request message was deleted

The role-request group and member requests remain stored.

A later refresh-capable role-request operation may rebuild the message when the authoritative destination still exists.

The bot does not intentionally recreate it in an unrelated channel if the original destination is gone.

---

## Role group says Planned

Its configured opening time has not yet arrived.

This is normal for preset-derived scheduled groups.

---

## Role group says Pending publication

The opening time has arrived but the Discord request message is not currently linked.

This is different from an Open group.

Check channel availability, bot permissions, and logs.

---

## Role request is marked unavailable

Possible reasons include the member's attendance state.

A retained request may remain stored while the member is currently Not Attending.

If their attendance later becomes eligible again, the same request can become available without being recreated.

---

## Qualified member cannot request a role

Check:

- the exact Discord role currently held by the member
- the option's qualification configuration
- whether the role is fully qualified or supervision-required
- whether the role option is active
- whether the group is actually open
- whether the event is cancelled or completed
- whether signup requirements are satisfied

Use the event/preset inspection commands to confirm IDs rather than relying on similar role names.

---

## Preset does not appear in `/role-preset list`

The preset may be inactive.

Use the command option to include inactive presets.

Then inspect:

```text
/role-preset show
```

---

## Preset cannot be applied

Check:

- preset is active
- target event belongs to this guild
- event type supports role requests
- target event does not already have this preset applied
- active groups contain active usable options
- signup-required groups are compatible with the target event
- required default channel is configured
- logical option keys do not conflict with existing event role options

An option lifecycle warning may have deliberately left the preset in a temporarily invalid state awaiting administrator repair.

---

## Preset changed but an older event did not change

That is expected.

Preset application uses snapshot semantics.

The event owns the configuration copied at the time of application.

Later preset changes affect future applications, not previously-applied events.

---

## Changing the default role-request channel did not move an existing event group

That is also expected.

The destination was resolved and snapshotted when the event group was created.

Changing a guild default is not a command to relocate existing event presentation.

---

## Signups closed earlier than expected after an event edit

Check the event's updated:

- start time
- signup close offset
- current lifecycle

Relative deadlines move with event timing.

If signups are already closed, an ordinary edit does not necessarily reopen them.

Use `/event reopen` when reopening is deliberately required.

---

# Current Feature Boundaries

The following are **implemented now**:

- persistent event creation
- immediate publication
- manual publication
- scheduled publication
- optional signups
- attendance responses
- close and reopen
- cancellation
- event editing
- message refresh and core deleted-message recovery
- organiser primary and backup nomination
- organiser confirmation and decline
- organiser escalation
- general cover
- organiser safety deadlines
- post-start cover where still needed
- organiser DM control
- event-level role options
- qualification rules
- supervision-required qualification
- manual request groups
- scheduled preset-derived request groups
- role-request closing
- multi-select volunteer requests
- explicit withdrawal
- reusable role-request presets
- preset application
- preset lifecycle controls
- reminders
- immediate announcements
- actual attendance recording
- signup-versus-attendance reports
- persistent audit logging

---

# Not Yet Complete

The following should **not** be treated as implemented administrator features yet.

## Full preset editing

Current presets cannot yet be comprehensively edited in place through a complete supported command workflow.

This is the immediate next development area.

---

## Event templates

The repository contains some template-related schema groundwork.

There is not yet a complete administrator-facing event-template workflow.

There is no current production command that should be documented as a finished `/template` feature.

---

## Recurring event generation

Automatic recurring-series generation is planned after templates.

It is not currently available as a complete user feature.

---

## Confirmed organiser self-unavailability

A fully integrated workflow for a confirmed organiser to later declare themselves unavailable is planned but not complete.

---

## Rich attendance participation roles

Actual attendance does not yet provide a complete event-specific classification system for participant versus organiser, supervisor, server administrator, and similar contexts.

---

## Automatic role allocation

Role requests are volunteer interest.

The bot does not currently replace organiser judgement with automatic final role assignments.

---

# Administrative Principles

Administrators should keep the following behaviour in mind.

## Database state is authoritative

Do not assume deleting or editing a Discord message deletes the underlying event.

Use the bot's administration commands.

---

## Unpublished does not mean disposable

An unpublished event may already have significant configuration and scheduled work.

Prefer publishing, editing, or cancelling the existing event rather than creating another because no public message is visible yet.

---

## Cancellation is final

Do not expect reopen, scheduled publication, reminders, or stale buttons to revive a cancelled event.

---

## Requests are not assignments

A volunteer request is input for the organiser.

It is not a guarantee.

---

## Tentative is meaningful

Do not treat Tentative as identical to Attending when interpreting attendance reports.

---

## Presets are sources, events are snapshots

Use the preset to define future reusable defaults.

Use the event-level commands to inspect what an already-applied event actually owns.

---

## Discord delivery can fail without destroying domain state

A missing message or channel does not automatically mean the event, request group, organiser assignment, or reminder vanished from PostgreSQL.

Check current bot state before recreating data manually.

---

# Recommended Administrator Setup Checklist

After first installing the bot:

- [ ] Run `/setup initialise`
- [ ] Run `/setup configure`
- [ ] Configure Event Admin role
- [ ] Configure attendance channel
- [ ] Configure role-request channel
- [ ] Configure Event Organiser role if wanted
- [ ] Configure Event Administration channel if using organiser workflow
- [ ] Review organiser timing
- [ ] Run `/setup regions`
- [ ] Review organiser feature state
- [ ] Review Organiser DMs setting
- [ ] Configure optional bot-log channel
- [ ] Run `/setup status`
- [ ] Create a disposable test event
- [ ] Confirm public event message works
- [ ] Confirm attendance buttons work
- [ ] Test organiser notification if organisers are enabled
- [ ] Test one role-request workflow
- [ ] Test a reusable preset before relying on it for a live event

---

# Recommended Pre-Event Administrator Checklist

For an important event:

- [ ] Confirm event date and time
- [ ] Confirm timezone
- [ ] Confirm ping roles
- [ ] Confirm publication mode
- [ ] Confirm signup mode
- [ ] Confirm signup closing time
- [ ] Confirm organiser nominees
- [ ] Confirm Event Administration fallback is available
- [ ] Confirm reminders
- [ ] Confirm role-request preset or manual role configuration
- [ ] Confirm role-group opening and closing times
- [ ] Use `/event list` to review summary state
- [ ] Use `/event role-group-list` where role requests are configured

---

# Recommended Post-Event Checklist

After an event:

- [ ] Record actual attendance
- [ ] Correct individual attendance mistakes where needed
- [ ] Review signup comparison if useful
- [ ] Review organiser or role-request issues if something unusual happened
- [ ] Use audit history when diagnosing an administrative sequence
- [ ] Leave historical event data intact unless there is a deliberate retention reason to remove it

---

# Related Documentation

See:

- [`../README.md`](../README.md) for the public project overview
- [`ARCHITECTURE.md`](ARCHITECTURE.md) for the current system design
- [`DECISIONS.md`](DECISIONS.md) for durable product and engineering invariants
- [`ROADMAP.md`](ROADMAP.md) for planned functionality
- [`CURRENT-WORK.md`](CURRENT-WORK.md) for the current development checkpoint
- [`TESTING-GUIDE.md`](TESTING-GUIDE.md) for automated and manual verification

When administrator behaviour described here appears to conflict with current command output, check the current command definitions and `DECISIONS.md` before assuming either behaviour should be changed casually.
