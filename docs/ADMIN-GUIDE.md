# Administrator Guide

This guide describes the main Discord commands and workflows currently available to server administrators.

The exact command surface may continue to evolve while the bot is under active development. For implementation details and design rationale, see:

- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`DECISIONS.md`](./DECISIONS.md)
- [`ROADMAP.md`](./ROADMAP.md)

---

# Server Setup

## `/setup initialise`

Initialises the current Discord server in the bot database.

This should normally be one of the first commands run when configuring the bot for a new server.

---

## `/setup configure`

Configures the server's main event-management roles, channels and organiser settings.

Core configuration includes:

- Event Admin role
- Default event announcement/sign-up channel
- Default role-request channel

It can also configure:

- Event Organiser role
- Private Event Administration channel
- Primary organiser response time
- Backup organiser response time
- Organiser warning time

These settings are used as defaults by later event-management workflows.

---

## `/setup regions`

Creates or updates the default event regions/audiences:

- EU
- NA
- EU & NA / Global

Regions provide sensible default timezones for event creation.

An event can still override its timezone when required.

---

## `/setup logging`

Sets the Discord channel where administrative audit activity should be mirrored.

The Discord log is a convenience view. The authoritative audit record remains in the database.

---

## `/setup logging-disable`

Stops Discord audit-log mirroring.

Database auditing continues even when Discord mirroring is disabled.

---

## `/setup status`

Shows the server's current bot configuration.

This is useful when checking configured:

- Administrative roles
- Organiser roles
- Event channels
- Role-request channels
- Event Administration channel
- Audit-log channel
- Organiser timing settings

---

# Creating Events

## `/event create`

Creates a new event.

Required information includes:

- Event type
- Region
- Event name
- Date
- Time
- At least one Discord role to notify

Optional settings include:

- Description
- Timezone
- Duration
- Attendance sign-ups
- Signup closing time
- Detailed signup deadline display
- Primary organiser
- Backup organiser
- Publication timing
- Additional notification roles

---

## Publication Options

An event can be created in one of three publication modes.

### Immediate publication

The public event message is posted as part of event creation.

This is the simplest workflow for events which require no private preparation.

### Scheduled publication

The event is created internally and automatically published a chosen number of minutes before the event starts.

For example:

```text
Event start:
Sunday 20:00

Automatic publication:
1440 minutes before start

Public announcement:
Saturday 20:00
```

### Manual publication

The event is created internally but remains unpublished until an administrator explicitly publishes it.

Unpublished events still receive a normal event ID and can be configured before the public announcement is sent.

This allows administrators to prepare:

- Organiser assignments
- Event role options
- Early/private role-request groups
- Event details
- Publication timing

before notifying the wider membership.

---

## Event Time Display

The event stores the timezone used when it was scheduled.

Member-facing times use Discord timestamps where appropriate, allowing Discord to display times in each member's own local timezone.

This applies to information such as:

- Event start
- Signup closure
- Scheduled publication

---

## `/event publish`

Immediately publishes an unpublished event.

This can be used for:

- A manually held unpublished event
- An event whose automatic publication is scheduled for later

If an automatically scheduled event is published early, the outstanding scheduled publication action is made obsolete so the event is not published twice.

---

# Event Management

## `/event list`

Shows upcoming events.

The list includes information such as:

- Event ID
- Event name
- Region
- Event time
- Current event/publication state
- Signup totals where applicable
- Scheduled publication information for active unpublished events

Cancelled events should be shown as cancelled rather than continuing to display a publication countdown.

---

## `/event edit`

Changes the configuration of an existing event.

Editable information includes:

- Name
- Description
- Date
- Time
- Timezone
- Duration
- Signup deadline
- Detailed deadline display
- Publication schedule
- Ping roles

Supplying ping roles during editing replaces the event's current ping-role set rather than adding to it.

Changing event timing automatically reschedules relevant future work, including where applicable:

- Signup closure
- Event completion
- Scheduled publication
- Event reminders
- Role-request group closure

For unpublished events, the publication schedule can also be:

- Changed
- Rescheduled by moving the event
- Removed entirely

Publication scheduling can no longer be changed after the event has already been published.

---

## `/event responses`

Shows members grouped by attendance response:

- Attending
- Tentative
- Not Attending

This command applies to events using attendance sign-ups.

---

## `/event close`

Manually closes attendance sign-ups for a published event.

Automatic signup closure is still performed by the scheduler when the configured deadline is reached.

---

## `/event reopen`

Reopens attendance sign-ups for a future published event.

A new signup closing deadline can be supplied.

Cancelled and completed events cannot be reopened.

---

## `/event cancel`

Cancels an event.

Cancellation disables active event controls and is currently treated as a final administrative state.

For unpublished events:

- Pending automatic publication is cancelled
- The event will not later become public merely because its original publication time arrives

For published events, the public event message is refreshed to show its cancelled state where possible.

Existing attendance information is retained.

---

## `/event refresh`

Rebuilds a published Discord event message from current database state.

This is useful if:

- A message appears out of date
- Event details have changed
- The database is correct but the Discord view needs rebuilding

The database is authoritative.

If the original Discord message has been manually deleted, the refresh operation may report that the linked message is unavailable.

---

# Events Without Attendance Sign-Ups

Events can be created with attendance sign-ups disabled.

This is useful for announcement-style events where members do not need to select:

- Attending
- Tentative
- Not Attending

No-signup events:

- Do not create attendance buttons
- Do not require a signup deadline
- Can still use organisers
- Can still use relevant role-request workflows
- Can still have actual attendance recorded
- Are excluded from signup reliability/discrepancy calculations

This prevents no-signup events from generating meaningless walk-in or no-show results.

---

# Event Organisers

Events can currently have:

- A **Primary Organiser**
- An optional **Backup Organiser**

If automatic escalation reaches the final fallback stage, an eligible member may also become the event's **Cover Organiser**.

---

## Primary Organiser Confirmation

The Primary Organiser receives a private Confirm/Decline request when the event is published.

If the bot cannot deliver the request by direct message, it falls back to the configured private Event Administration channel.

Organiser response timing begins when the event becomes public.

Assigning an organiser to an unpublished event does **not** start their response countdown immediately.

---

## Organiser Escalation

If the Primary Organiser declines or fails to respond before their deadline:

1. The Backup Organiser is activated, if one exists.
2. The backup receives their own confirmation period.
3. If no organiser is secured, a cover request can be sent to the configured Event Organiser role.
4. An eligible organiser can claim the event through the **Claim Event** button.

The bot may also warn administrators shortly before an organiser response deadline expires.

The workflow is approximately:

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
               Claim Event button
```

---

## `/event organiser-set`

Assigns or replaces the current:

- Primary Organiser
- Backup Organiser

Organisers can be configured while an event is still unpublished.

---

## `/event organiser-clear`

Removes the current:

- Primary Organiser
- Backup Organiser

Organiser assignment history is retained internally rather than being represented only by a single mutable event field.

---

# Requestable Event Roles

Events can define logical roles which members may volunteer to perform.

Examples include:

- Captain
- Supervisor
- Gunner
- Carpenter
- Other event-specific specialist roles

The names and qualification rules are configurable rather than hardcoded.

---

## `/event role-option-add`

Adds a requestable role to an event.

A role may be:

- Open to everyone
- Restricted to qualified members

Discord roles may be configured to represent:

- Full qualification
- Qualification requiring supervision

For example:

```text
Captain

Experienced Captain role
    -> Fully qualified

Trainee / Midshipman role
    -> Supervision required
```

A member who requires supervision may still be permitted to volunteer for the role.

The organiser view displays the qualification context rather than treating all eligible volunteers as identical.

---

## `/event role-option-list`

Lists the requestable roles currently configured for an event.

Information includes:

- Role-option ID
- Role name
- Request restrictions
- Qualification requirements

Role-option IDs are used when configuring role-request groups.

---

# Role-Request Groups

## `/event role-group-post`

Posts a role-request message containing selected event roles.

Different groups can:

- Be posted in different channels
- Display different combinations of event roles
- Require Attending/Tentative signup status
- Allow requests without attendance signup
- Close automatically before event start
- Close automatically at event start
- Close automatically after event start
- Optionally notify a Discord role when posted

---

## Shared Role Pools

The same logical role can appear in several request groups.

For example:

```text
Early Command Interest
    Captain
    Supervisor

Main Naval Role Requests
    Captain
    Supervisor
    Gunner
    Carpenter
```

The Captain role shown in both groups refers to the same underlying event-level role.

Requests are therefore shared rather than creating separate early and main Captain lists.

---

## Multi-Role Requests

Members may volunteer for several roles at the same event.

For example:

```text
Captain
Carpenter
Gunboat Gunner
```

Role requests represent willingness or interest.

They do **not** automatically allocate the role to that member.

Final role assignment remains an organiser decision.

---

## Managing Existing Requests

Clicking a role which a member already requested does not remove the request.

Instead, the bot informs them that the request already exists.

Members use **Manage My Requests** to deliberately withdraw existing requests.

If a member withdraws and later requests the same role again, the new request receives a new request time and therefore returns to the back of the request order.

---

## `/event role-group-list`

Lists the role-request groups configured for an event.

---

## `/event role-group-close`

Immediately closes a role-request group.

Groups may also close automatically according to their configured schedule.

---

## `/event role-requests`

Shows the administrative/organiser view of role requests for an event.

Depending on the role and available information, this may include:

- Request order
- Qualification status
- Supervision requirements
- Other roles requested by the same member
- Attendance/signup state
- Other suitable signed-up members where applicable

Role requests and attendance state are related but represent different concepts:

```text
Role request
    = willingness to perform a role

Attendance response
    = whether that willingness is currently actionable
```

---

# Event Announcements and Reminders

## `/event announce`

Immediately sends a custom event-related announcement.

This can optionally notify the event's configured ping roles.

---

## `/event reminder-add`

Schedules a custom reminder.

Reminder timing can currently be relative to:

- Signup closure
- Event start

The destination channel and notification behaviour can also be configured.

---

## `/event reminder-edit`

Edits a pending event reminder.

Depending on the supplied options, this can change information such as:

- Timing reference
- Minutes before the reference point
- Message
- Destination channel
- Whether event roles are notified

---

## `/event reminder-list`

Shows reminders configured for an event and their current status.

---

## `/event reminder-remove`

Removes a reminder which has not yet been sent.

---

## Reminder and Announcement Mentions

Where applicable, configured event-role mentions are kept visually unobtrusive while still notifying the intended members.

Message refreshes deliberately avoid generating a fresh notification merely because an administrator rebuilt or edited an existing event display.

---

# Recording Actual Attendance

Signup intention and actual attendance are stored separately.

This allows the bot to compare:

```text
What somebody said they intended to do
```

with:

```text
What actually happened
```

---

## `/attendance record`

Replaces an event's recorded actual attendance using Discord user IDs or mentions.

This is useful for importing or recording the full attendance list in one operation.

---

## `/attendance add`

Adds one member to the event's recorded actual attendance.

Useful for individual corrections.

---

## `/attendance remove`

Removes one member from the event's recorded actual attendance.

Useful for correcting an attendance record without replacing the entire list.

---

# Comparing Sign-Ups With Actual Attendance

## `/attendance compare`

Compares recorded actual attendance with signup responses.

For signup-enabled events, the report can identify members who:

- Attended as expected
- Signed up but did not attend
- Attended without signing up
- Attended after selecting Not Attending

Tentative members who ultimately do not attend are shown for context but are not treated as normal no-shows.

No-signup events can still have actual attendance recorded, but do not generate signup discrepancies.

Attendance reporting is intended to provide useful context to administrators rather than automatically punish members.

---

# Historical Attendance Reporting

## `/attendance user`

Shows attendance/sign-up history for a particular member.

Reports can be filtered by:

- Event type
- Date range

---

## `/attendance issues`

Shows members with signup/attendance discrepancies across completed events.

Only relevant completed events with recorded actual attendance are included.

No-signup events do not create false no-show or walk-in issues.

---

# Audit Trail

## `/audit recent`

Shows recent administrative actions recorded by the bot.

The output can be filtered by information such as:

- User
- Outcome

The database audit record remains authoritative even if Discord audit-log mirroring has been disabled.

Audit information and event IDs are useful when investigating unexpected behaviour.

---

# Typical Event Workflow

A simple published event may follow:

```text
Create event
    |
    v
Public event message
    |
    v
Members respond
    |
    v
Reminders
    |
    v
Signups close
    |
    v
Run event
    |
    v
Record actual attendance
    |
    v
Compare signups with attendance
```

A more advanced event can instead use:

```text
Create unpublished event
        |
        v
Assign organisers
        |
        v
Configure event roles
        |
        v
Post early/private role requests
        |
        v
Finalise event details
        |
        v
Scheduled or manual publication
        |
        v
Attendance responses
        |
        v
General role requests
        |
        v
Reminders
        |
        v
Run event
        |
        v
Record and compare attendance
```

Not every event needs every stage.

---

# Troubleshooting

When something appears incorrect, the most useful information is usually:

- Event ID
- Role-option ID where relevant
- Role-request group ID where relevant
- Command or button used
- Approximate time of the problem
- Expected result
- Actual result

The database audit trail can often help identify the exact administrative or scheduler action which occurred.

For the dedicated community testing deployment, bugs should be reported through the server's designated testing/bug-report channel.
