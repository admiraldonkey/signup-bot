# Holdfast Event Bot Roadmap

## Purpose

This document records likely future work for the Holdfast Event Bot.

It is intentionally broader than a conventional issue tracker.

Priorities and implementation details may change as:

- Public testing continues
- Architecture is reviewed
- Requirements become clearer
- Collaboration with the other community bot developer develops

Priority levels used here:

| Priority | Meaning                                                                    |
| -------- | -------------------------------------------------------------------------- |
| **P0**   | Architecture, reliability or safety work to address before major expansion |
| **P1**   | Important near-term functionality                                          |
| **P2**   | Medium-term feature development                                            |
| **P3**   | Useful later improvements/integration                                      |
| **P4**   | Optional, experimental or lower-priority ideas                             |

---

# Current Development Phase

The bot has moved beyond its original signup prototype.

Major implemented areas include:

- Configurable Discord guild setup
- Event types
- Event regions/audiences
- Attendance signups
- Optional no-signup events
- Attendance response buttons
- Public event messages
- Event editing
- Attendance close/reopen
- Event cancellation
- Event refresh/rebuild
- Actual attendance recording
- Signup vs actual attendance comparison
- Historical attendance reporting
- Immediate announcements
- Scheduled reminders
- Persistent scheduler
- Administrative audit logging
- Event organiser assignment
- Organiser confirmation/decline
- Organiser timeout warnings
- Primary-to-backup escalation
- Cover requests
- Claim Event functionality
- Event-level role options
- Role qualification rules
- Supervision-required qualification
- Role-request groups
- Shared role pools across groups
- Independent multi-role requests
- Explicit request withdrawal
- Role-request group scheduled closure
- Closing role requests before, at, or after event start
- Unpublished/draft events
- Manual event publication
- Automatic scheduled event publication

The next phase should focus substantially on **code quality, modularity, reliability and portability** before continuing to expand the command surface aggressively.

---

# P0 - Repository-Wide Architecture Review

Perform a fresh review of the complete repository.

Review for:

- Potential bugs
- Race conditions
- Oversized modules/functions
- Duplicated authorisation
- Duplicated database queries
- Duplicated validation
- Inconsistent naming
- Dead code
- Legacy schema fields
- Missing comments
- Missing tests
- Weak subsystem boundaries
- Discord-specific logic leaking into business logic
- Scheduler edge cases
- Error handling
- Public-repository quality

The review should favour **incremental refactoring** rather than wholesale rewrites.

---

# P0 - Improve Portability of Major Subsystems

Particularly review portability for:

```text
event publication
organiser assignment
organiser escalation
durable scheduling
role requests
role qualification
attendance comparison
audit logging
```

Desired direction:

```text
Discord interaction
        |
        v
Command/interaction adapter
        |
        v
Domain/service layer
        |
        +---- persistence
        |
        +---- Discord notification/rendering
        |
        +---- scheduler
```

The goal is to avoid requiring the complete `/event` implementation if functionality is transplanted into another bot.

---

# P0 - Define Clear Internal Service Interfaces

Consider explicit reusable operations such as:

```text
publishEvent(...)
assignOrganiser(...)
activateOrganiser(...)
declineOrganiser(...)
escalateOrganiser(...)
addRoleRequest(...)
withdrawRoleRequest(...)
evaluateRoleQualification(...)
closeRoleRequestGroup(...)
compareAttendance(...)
```

These do not need to become external APIs.

TypeScript interfaces/types around service boundaries may be sufficient.

---

# P0 - Reduce Large Command Handlers

The main event command implementation has become large.

Refactor gradually so command handlers primarily perform:

1. Interaction-specific input extraction
2. Authorisation
3. Basic validation
4. Service invocation
5. Discord response formatting

Avoid introducing a large generic "god service" while trying to eliminate a large command file.

---

# P0 - Review Common Event Loading

Several commands need overlapping event information.

Consider whether a small set of reusable event repository/load functions would improve:

- Consistency
- Ownership checks
- Type safety
- Unpublished event handling
- Testability

Do not create one enormous query returning every event-related table for every operation.

---

# P0 - Review Common Administrative Authorisation

Administrative commands repeatedly perform:

- Guild configuration lookup
- Enabled check
- Event Admin permission check
- Denied-command audit logging

Consider consolidating this into reusable helpers without obscuring command behaviour.

---

# P0 - Strengthen Automated Test Coverage

Increase automated tests around lifecycle-critical behaviour.

## Event publication tests

Test:

- Immediate publication
- Manual publication
- Scheduled publication
- Manual early publication overriding scheduled publication
- Cancellation before scheduled publication
- Cancellation close to publication time
- Editing event start after publication is scheduled
- Editing publication offset
- Clearing publication schedule
- Event moved so publication time changes
- Publication rejected after event start
- Publication rejected after signup closure
- Publication rejected at signup closure
- Duplicate/racing publication attempts
- Publication channel missing
- Ping role missing
- Bot unable to mention ping role

---

## Organiser tests

Test:

- Primary assignment
- Primary confirmation
- Primary decline
- Primary timeout
- Primary warning
- Backup activation
- Backup confirmation
- Backup decline
- Backup timeout
- Cover request
- Cover claim
- Cancellation
- Completion
- Assignment while event unpublished
- Assignment after publication
- Replacement
- Clearing organisers
- Scheduler cleanup

---

## Role-request tests

Test:

- Single role request
- Several independent role requests
- Duplicate button press
- Manage My Requests
- Withdrawal
- Re-request ordering
- Shared role across early/main groups
- Signup-gated group
- No-signup early group
- Qualified member
- Supervision-required member
- Unqualified member
- Closing before event start
- Closing at event start
- Closing after event start
- Event cancellation
- Event completion
- Attendance-state changes

---

# P1 - Finish Role-Request Attendance-State Integration

Role-request views should clearly indicate current signup state.

Desired organiser output resembles:

```text
CAPTAIN

1. Nelson  ✅ Attending      • Qualified
2. Hardy   ❔ Tentative       • Supervisor required
3. Smith   ⚪ No signup      • Qualified
4. Jones   🚫 Not attending  • Qualified
```

Desired semantics:

| Attendance state | Role-request state                                  |
| ---------------- | --------------------------------------------------- |
| Attending        | Active                                              |
| Tentative        | Active, visibly tentative                           |
| Not Attending    | Request retained but unavailable                    |
| No signup        | Valid where the workflow permits no-signup requests |

Changing attendance should refresh relevant role-request messages.

Returning from Not Attending to Attending should reactivate the existing request without changing its original creation timestamp.

Public volunteer counts should generally exclude explicitly unavailable Not Attending requests.

---

# P1 - Confirmed Organiser "Unavailable" Workflow

Allow a previously confirmed organiser to indicate that they can no longer organise the event.

Desired flow:

```text
Confirmed Primary
        |
        v
Unavailable
        |
        +---- activate Backup
        |
        +---- OR issue Cover Request
```

If the confirmed Backup/Cover organiser later becomes unavailable:

```text
Unavailable
    |
    v
Cover Request
```

Reuse the existing escalation infrastructure.

Audit each state transition.

---

# P1 - Actual Attendance Participation Context

Extend actual attendance records with event-specific participation context.

Initial values:

```text
participant
supervisor
organiser
server_admin
other
```

Desired reporting could distinguish:

```text
Total present
Players/participants
Supervisors
Organisers
Server administrators
Other support attendance
```

Signup discrepancy behaviour should only flag appropriate participation.

Examples:

```text
participant + no signup
    -> walk-in

supervisor + no signup
    -> present
    -> not a walk-in issue

organiser + no signup
    -> present
    -> not a walk-in issue

server_admin + no signup
    -> present
    -> not a walk-in issue
```

Bulk attendance recording/import should default to:

```text
participant
```

unless another type is provided.

---

# P1 - Server-Level Feature Flags

Introduce server-level switches for major optional systems.

Likely initial configuration:

```text
organisersEnabled
organiserEscalationEnabled
roleRequestsEnabled
attendanceReportingEnabled
```

Potential organiser semantics:

```text
Organisers OFF
    -> organiser workflow unavailable

Organisers ON
Escalation OFF
    -> assignment and confirmation available
    -> decline/unavailability requires manual handling

Organisers ON
Escalation ON
    -> automatic Primary -> Backup -> Cover workflow
```

Role requests should also continue respecting event-type configuration.

Prefer runtime checks over dynamically registering a different slash-command set for every guild.

Potential configuration command:

```text
/setup features
```

---

# P1 - Cancellation Notifications

Extend `/event cancel` with optional attendee notification.

Possible flow:

```text
/event cancel

Notify attendees?
    Yes
    No
```

If enabled, appropriate notifications may include:

- Attending members
- Tentative members
- Current organiser

Avoid unnecessary duplicate notifications where the organiser or cancelling administrator is already aware.

The public event message should remain visibly cancelled and its controls disabled.

---

# P1 - Audit Unpublished-Event Compatibility Across Commands

Review all event commands to ensure unpublished events behave deliberately.

Check:

```text
/event list
/event edit
/event cancel
/event organiser-set
/event organiser-clear
/event role-option-add
/event role-option-list
/event role-group-post
/event role-group-list
/event role-group-close
/event role-requests
/event reminder-add
/event reminder-list
/event reminder-edit
/event reminder-remove
/event announce
/event refresh
/event responses
```

Commands which fundamentally require a published/public Discord message should fail with a clear explanation rather than through missing joins or accidental assumptions.

---

# P1 - Review `/event list` State Presentation

The event list should clearly distinguish:

- Unpublished manual draft
- Unpublished with scheduled publication
- Published/open
- Published/closed
- Cancelled
- Completed where relevant

A cancelled event must **not** continue displaying:

```text
Publishes in 5 minutes
```

merely because `publishMinutesBeforeStart` remains stored historically.

Publication countdowns should only be displayed for active unpublished events with a valid outstanding publication intention.

---

# P2 - Event Templates

Implement practical recurring-event templates.

Templates should eventually support defaults including:

- Event type
- Region/audience
- Timezone
- Event name
- Description
- Local start time
- Duration
- Signup enabled/disabled
- Signup close offset
- Publication offset
- Ping roles
- Organiser behaviour
- Role options
- Qualification rules
- Role-request groups
- Reminders

Changes to a template should affect future occurrences.

Historical generated events should retain their snapshotted configuration.

---

# P2 - Recurring Event Generation

Generate future event occurrences from templates.

Likely recurrence representation:

```text
RFC 5545 RRULE
```

Example:

```text
Weekly Sunday Naval Event
```

Occurrences should be generated sufficiently early to permit:

- Organiser assignment
- Early command interest
- Admin edits
- Scheduled publication

Do **not** wait until public announcement time to first create the event.

---

# P2 - Scheduled Role-Request Group Opening / Posting

Role-request groups are currently primarily posted explicitly.

Future templates/events should support scheduled group opening/posting.

Example:

```text
Friday
    -> early Captain/Supervisor interest

Sunday afternoon
    -> main role requests

Sunday evening
    -> event begins
```

This should use the durable scheduler.

Potential action concept:

```text
open_role_request_group
```

The implementation should deliberately decide whether scheduled opening means:

1. Create/post the Discord message at that time, or
2. Create it earlier but enable interaction at that time

Prefer the option which is easiest to recover, audit and reason about.

---

# P2 - Role-Request Group Administration

Add richer management of existing role-request groups.

Potential operations:

- Edit group
- Change description
- Change displayed roles
- Change signup requirement
- Change closing time
- Reopen group
- Retire/delete group
- Repost missing Discord message
- Move/recreate group in another channel

Historical role requests should be preserved where reasonable.

---

# P2 - Role Option Administration

Add commands/services for:

- Editing role option name
- Editing description
- Changing request restriction
- Changing qualification roles
- Deactivating role option
- Changing capacity where used

Avoid destructive deletion where historical request records depend on the option.

---

# P2 - Supervisor Availability Warnings

For roles which require supervision, provide useful organiser warnings.

Example:

```text
3 Captain volunteers require supervision
0 qualified Supervisor volunteers available
```

Possible output:

```text
⚠️ 3 Captain volunteers currently require supervision,
but no Supervisor volunteer is available.
```

Do not automatically assign supervisors at this stage.

---

# P2 - Template Qualification Configuration

Templates should eventually define reusable role qualification rules.

Example:

```text
Captain
    Flag Captain -> qualified
    Midshipman    -> supervision required
```

Generated event occurrences should copy the rules into event-level configuration.

This preserves historical stability when templates later change.

---

# P2 - Event-Type / Template Role Request Defaults

Different events should support different role-request structures.

Example regular naval event:

```text
Captain
Supervisor
2-Gun Gunner
Gunboat Gunner
Carpenter
```

Example linebattle event:

```text
CO
XO
Auxiliary
```

Possible later specialist group:

```text
Cavalry
Artillery
Skirmishers
```

depending on what the host grants.

Avoid hardcoding every variation into application enums.

---

# P2 - Reminder Improvements

Potential reminder extensions include:

- Publication-relative reminders
- Role-request opening reminders
- Role-request closing reminders
- Template-defined reminders
- Recurring-event reminder defaults
- Easier duplication/copying
- Additional timing references

Missed reminders should remain auditable rather than being silently discarded.

---

# P2 - Event Duplication

Add an easy way to clone a one-off event.

Potential command:

```text
/event duplicate
```

Reasonable data to copy:

- Event configuration
- Ping roles
- Role options
- Qualification rules
- Optional role-request group definitions
- Optional reminder definitions

Do **not** copy:

- Signup responses
- Actual attendance
- Role requests
- Organiser response history
- Audit history

---

# P2 - Message Recovery / Repost Tools

Discord messages may be manually deleted.

Add recovery tooling for:

- Public event message
- Role-request group message
- Other recoverable administrative surfaces

Reposting should avoid generating duplicate role pings unless explicitly requested.

---

# P2 - `/event` Command Structure Redesign

The `/event` command is approaching Discord's maximum subcommand count.

Restructure before the limit becomes an active blocker.

Possible future structure:

```text
/event create
/event edit
/event list
/event publish
/event cancel

/organiser set
/organiser clear
/organiser status

/roles option-add
/roles group-post
/roles requests

/reminder add
/reminder edit
/reminder list
/reminder remove
```

Exact naming should be reviewed for usability.

Migration should avoid unnecessary disruption for current administrators.

---

# P3 - Portal Integration

Potential portal features include:

- Upcoming events
- Event detail pages
- Event/template management
- Attendance history
- Signup/actual comparison
- Role requests
- Organiser administration
- Member attendance history
- Event statistics

If collaboration with the existing community bot proceeds, prefer extending its portal over building a redundant standalone portal.

---

# P3 - Integration With Existing Attendance Bot

The other community bot already automatically records actual attendance.

Potential integration should prefer:

1. Reusing/importing the authoritative attendance data
2. Creating an adapter/service boundary
3. Sharing or mapping stable event identifiers
4. Only using direct shared-database access if both projects deliberately adopt that architecture

Avoid duplicate attendance tracking where an authoritative source already exists.

---

# P3 - Migration / Transplant Support

If organiser, role-request or publication systems move to the other bot:

1. Extract portable service logic
2. Document required domain concepts
3. Map source and destination event identities
4. Map guild/user identities
5. Adapt scheduling hooks
6. Adapt Discord rendering
7. Write destination-specific database migrations
8. Preserve auditing

A shared package/monorepo should only be introduced if actual code-sharing requirements justify the additional complexity.

---

# P3 - Cross-Server Event Support

The community uses more than one Discord server.

Possible long-term architecture:

```text
One canonical event
        |
        +---- public message in main server
        |
        +---- optional mirrored surface in naval server
        |
        +---- shared attendance/role state
```

This requires careful modelling of:

- Event identity
- Guild ownership
- Discord messages
- Permissions
- Cross-server user participation
- Audiences

Avoid implementing naive message duplication before the domain model supports multiple Discord surfaces properly.

---

# P3 - Export and Interoperability

Potential exports include:

- CSV
- JSON
- Google Sheets
- Portal/API adapters

Useful export areas:

- Attendance
- Role requests
- Event summaries
- Historical reporting

Exports should use database/domain state rather than scraping rendered Discord messages.

---

# P3 - Improved Discord Presentation

Current Discord displays are functional and intentionally not final.

Future presentation improvements may use newer Discord UI/components to improve:

- Readability
- Compactness
- Role-request layout
- Organiser information
- Attendance information
- Customisation

Underlying workflows should stabilise before substantial UI redesign.

---

# P3 - Pagination

Introduce pagination when Discord limits require it.

Likely candidates:

- Role-request organiser views
- Large attendance response lists
- Historical attendance reports
- Audit history
- Event lists

---

# P3 - Health and Diagnostics

Potential administrative diagnostics include:

- Scheduler health
- Failed actions
- Overdue actions
- Events which failed publication
- Missing Discord messages
- Deleted ping roles
- Deleted channels
- Invalid configuration
- Database connectivity
- Reminder failures

Possible future command:

```text
/health
```

or an admin portal diagnostics page.

---

# P3 - Privacy and Data Management

Before wider deployment, formalise policies/behaviour around:

- Data retention
- Attendance history
- Signup history
- Member deletion requests
- Audit retention
- Export access
- Portal access
- Administrator permissions

The project should avoid collecting data merely because it is technically available.

---

# P4 - Role Capacity and Waitlists

Role options already contain a capacity concept in the schema.

Potential future uses include:

```text
Captain capacity = N
```

Before implementing capacity behaviour, decide whether capacity means:

- Organiser guidance only
- Automatic waitlist
- Hard request limit

Do not accidentally turn role requests into automatic allocations.

---

# P4 - Automated Role Allocation

Automatic allocation is deliberately not a current priority.

A real allocation system would need to consider:

- Qualifications
- Supervision
- Attendance state
- Multiple requested roles
- Capacities
- Event requirements
- Organiser judgement

The current request/volunteer model should remain until there is a strong practical reason to automate allocation.

---

# P4 - Advanced Analytics

Potential later analytics include:

- Signup accuracy by event type
- Attendance trends
- Participation frequency
- Role volunteering trends
- Organiser coverage
- No-show/walk-in patterns

Analytics must remain informational.

Do not automatically create disciplinary scores from these statistics.

---

# P4 - Additional Integrations

Possible future sources/destinations include:

- Existing community attendance bot
- Existing community portal
- Google Sheets
- External event systems

Integrations should use adapters so external-system assumptions do not spread throughout the main event-management domain.

---

# Deliberately Not Prioritised

The following are currently lower priority than reliability and architecture:

- Complete Discord UI redesign
- Automatic disciplinary systems
- Automatic role assignment
- Hardcoding many naval/linebattle subtypes
- Premature microservices
- Premature monorepo/shared-package architecture
- Building a competing portal where collaboration is possible

The current goal is a **robust, understandable and portable event-management system**.
