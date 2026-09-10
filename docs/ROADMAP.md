# Holdfast Event Bot Roadmap

## Purpose

This document records the intended future development direction for the Holdfast Event Bot.

It is broader than an issue tracker.

It exists to preserve:

- agreed feature direction
- sequencing between major subsystems
- architectural prerequisites
- known reliability work
- portability and integration intentions
- deliberately deferred ideas

It should not be used as a list of functionality that already exists.

Implemented behaviour belongs primarily in:

- `README.md`
- `ARCHITECTURE.md`
- `DECISIONS.md`
- `ADMIN-GUIDE.md`

The exact current development checkpoint belongs in:

- `CURRENT-WORK.md`

Priorities may change as:

- community testing continues
- implementation exposes new edge cases
- requirements become clearer
- Discord platform constraints change
- collaboration with other community tooling develops

---

# Roadmap Status Vocabulary

This document uses four broad priority levels.

| Priority | Meaning                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------- |
| **P0**   | Immediate work or reliability issue that should be addressed before substantial feature expansion |
| **P1**   | Near-term functionality that forms the next planned development phase                             |
| **P2**   | Useful medium-term product or architectural development                                           |
| **P3**   | Later, optional, integration, analytics, or quality-of-life work                                  |

A roadmap priority is not a promise of a release date.

---

# Current Project Checkpoint

The project has moved well beyond the original reaction-signup prototype.

Major established areas now include:

- persistent event lifecycle
- optional attendance sign-ups
- no-signup events
- actual attendance recording
- signup-versus-attendance reporting
- immediate and scheduled event publication
- event editing and cancellation
- persistent reminders
- immediate announcements
- PostgreSQL-backed audit logging
- durable scheduled actions
- organiser nomination and confirmation
- primary-to-backup organiser escalation
- general organiser cover
- organiser safety deadlines
- missing-organiser-at-start handling
- organiser DM-first delivery with administrative fallback
- server-level organiser controls
- event-level role options
- qualification and supervision-required rules
- independent multi-role requests
- shared volunteer pools across request groups
- scheduled role-request group opening
- scheduled role-request group closing
- attendance-aware role-request availability
- deleted event-message recovery
- deleted role-request-message recovery
- reusable role-request presets
- preset snapshot application
- reversible preset, option, and group lifecycle management
- unit and real-PostgreSQL integration testing
- regression coverage for important race conditions

The immediate development focus is no longer establishing the preset subsystem.

The next phase is to make existing reusable presets fully maintainable, then use the resulting stable configuration model as a foundation for event templates and recurring event generation.

---

# Current Development Sequence

The intended major sequence is:

```text
Reusable role-request presets
        |
        | implemented foundation,
        | application and lifecycle
        v
Preset editing
        |
        v
Event templates
        |
        v
Recurring event generation
        |
        v
Broader administration,
integration and reporting work
```

This sequence is deliberate.

Templates should not be built around reusable configuration that administrators cannot yet edit properly.

Recurrence should not be built before template-generated one-off events are reliable and independently editable.

---

# P0 - Complete Role-Request Preset Editing

## Objective

Complete the administrator workflow for maintaining an existing reusable role-request preset without requiring it to be recreated.

The current system supports:

- preset creation
- preset inspection
- role-option creation
- request-group creation
- application to an event
- preset activation/deactivation
- option activation/deactivation
- group activation/deactivation

The missing area is **editing the stored definitions themselves**.

---

## P0.1 - Preset metadata editing

Add a service and administrator command for changing reusable preset metadata.

Likely editable fields include:

- name
- description

Requirements:

- enforce guild ownership
- preserve unique preset naming rules
- allow inactive presets to be edited
- update `updatedAt` only when a real mutation occurs
- return an explicit unchanged/no-op result where appropriate
- preserve all child options and groups
- preserve all event snapshots already created from the preset

Potential command shape:

```text
/role-preset edit
    preset-id
    name
    description
```

Exact Discord option design should avoid making every field mandatory when only one needs changing.

---

## P0.2 - Preset role-option editing

Add editing for existing reusable role options.

Candidate editable fields include:

- display name
- description
- request restriction
- capacity
- qualification-role configuration

The logical key needs deliberate treatment.

Before exposing key editing, decide whether:

1. the key should remain stable after creation
2. the key can be changed when it does not conflict
3. changing it should be treated as a more explicit operation

Do not accidentally make a human-readable rename also change the logical identity used for event-level conflict detection.

---

## P0.3 - Qualification-role replacement

Qualification configuration should support editing after option creation.

The service should be able to replace or otherwise deliberately update:

```text
qualified
supervision_required
```

Discord role mappings.

Requirements include:

- reject `@everyone`
- reject one Discord role appearing at conflicting qualification levels
- preserve role-name snapshots
- enforce `qualified_only` consistency
- keep the complete mutation atomic
- use the preset parent mutation lock

If a role option is changed to:

```text
qualified_only
```

it must have at least one valid qualification role before the edit becomes authoritative.

---

## P0.4 - Preset request-group editing

Add editing for reusable request-group fields.

Candidate editable fields include:

- name
- description
- destination channel override
- notification role
- signup requirement
- opening offset
- closing offset

The current signed-offset semantics must remain:

```text
positive = before event start
zero     = at event start
negative = after event start
```

Discord-facing options should continue using clearer concepts such as:

```text
open-minutes-before-start
open-minutes-after-start

close-minutes-before-start
close-minutes-after-start
```

rather than requiring administrators to enter negative values directly.

Opening must remain strictly before closing.

---

## P0.5 - Group-option mapping editing

Administrators need to change which reusable role options appear in an existing preset request group.

Likely requirements include:

- add an option to an existing group
- remove an option from an existing group
- replace the complete ordered option set
- change mapping order

A complete replacement operation may be simpler and easier to validate than a large collection of individual mutation commands.

Whichever interface is selected must preserve:

- the same logical option being usable in several groups
- mapping order
- independent option lifecycle state
- group lifecycle state

The service should reject a final active group configuration that references no usable option where doing so would make the edit itself nonsensical.

Alternatively, if incomplete intermediate configuration is deliberately allowed for consistency with lifecycle editing, the command must warn clearly and preset application must remain the final validator.

That choice should be recorded in `DECISIONS.md` when implemented.

---

## P0.6 - Preset edit concurrency contract

All preset editing must preserve the existing locking rule:

```text
preset application
    -> role_request_presets FOR SHARE

preset mutation
    -> role_request_presets FOR UPDATE
```

An application must observe either:

```text
complete configuration before edit
```

or:

```text
complete configuration after edit
```

It must never snapshot a half-edited preset graph.

This applies to:

- metadata editing
- role-option editing
- qualification changes
- request-group editing
- mapping changes
- future delete/retire operations

---

## P0.7 - Preserve snapshot independence

No preset edit operation may silently alter event-level configuration that was already created through preset application.

For example:

```text
Naval preset
    Captain closes at T+10

apply to Sunday event

later edit preset
    Captain closes at T+20
```

The existing Sunday event must retain:

```text
T+10
```

unless an administrator explicitly edits the event itself.

This is a core product invariant, not merely an implementation preference.

---

## P0.8 - Preset editing Discord UX

Once service operations are stable, review the `/role-preset` command surface as a whole.

Current administration is intentionally ID-based.

Potential usability improvements include:

- clearer edit success summaries
- easier discovery of preset IDs
- easier discovery of option/group IDs
- autocomplete where Discord and current architecture make it worthwhile
- clearer indication of inactive children
- warnings when an edit leaves a preset temporarily unusable
- concise display of fixed-channel versus apply-time-default behaviour

Do not introduce autocomplete simply to avoid typing IDs if it requires fragile or expensive lookup behaviour.

---

## P0.9 - Preset-edit testing expectations

Each new mutation should receive direct integration coverage.

Important cases include:

- correct edit
- idempotent/no-op edit
- foreign guild
- child belongs to different preset
- inactive parent remains editable
- invalid option restriction
- invalid qualification configuration
- duplicate qualification role
- invalid group window
- invalid channel/notification input where applicable
- option-key conflict where key editing is supported
- concurrent application versus editing
- rollback of a multi-row edit after validation failure

Discord adapter tests should separately cover:

- option parsing
- Discord role resolution
- Discord channel resolution
- permission-related UX where relevant
- service-result formatting
- audit behaviour

---

# P0 - Remaining Reliability Checks Before Template Expansion

The broad organiser, scheduler, publication, role-request, and recovery reliability passes are complete enough to support continued feature work.

A few known reliability questions remain worth addressing before or alongside template development.

---

## P0.10 - Event Administration channel deletion behaviour

Review organiser notification and escalation behaviour when the configured Event Administration channel has been deleted.

Distinguish carefully between:

```text
Discord explicitly reports unknown/deleted channel
```

and:

```text
transient or unexpected Discord failure
```

Do not silently treat every failed fetch/send as permanent channel deletion.

Desired behaviour should:

- preserve authoritative organiser state
- avoid duplicate side effects
- retain scheduler retry where a transient error may recover
- provide useful audit/error visibility
- not guess an unrelated replacement channel

---

## P0.11 - Deleted organiser notification role

Review behaviour when the configured organiser/event-admin notification role is removed from Discord.

Expected principles:

- organiser state remains authoritative
- absence of a ping role must not corrupt assignment state
- notification may degrade to a message without the role ping where appropriate
- unexpected errors should remain observable
- `@everyone` must not become an accidental fallback

---

## P0.12 - Continue regression-led reliability work

Do not perform another repository-wide reliability rewrite merely because reliability remains important.

Instead:

- add regressions when concrete failures are discovered
- preserve existing concurrency contracts
- extract services where a real reusable boundary emerges
- keep the full test gate green
- review new template/recurrence work for races as it is introduced

---

# P1 - Event Templates

## Objective

Add reusable event templates after preset editing is complete.

A template should describe reusable **defaults** for creating an event.

It should not become a live runtime configuration object that existing events continuously consult.

Conceptually:

```text
template
    |
    | generate
    v
ordinary event
```

After generation, the event should behave like any manually-created event.

---

## P1.1 - Reconcile existing template schema scaffolding

The repository already contains early template-related schema concepts.

Before building the feature, review existing fields and tables against the architecture now established by:

- `createStoredEvent()`
- reusable role-request presets
- event-level organiser assignments
- reminders
- publication scheduling
- snapshot semantics

Do not preserve obsolete scaffolding merely because it predates the newer architecture.

Generate explicit new migrations for intentional schema changes.

---

## P1.2 - Template identity and lifecycle

A template will likely need persistent fields such as:

- guild owner
- name
- description
- active state
- creator
- created timestamp
- updated timestamp

Possible lifecycle operations include:

```text
create
list
show
edit
set-active
```

Destructive deletion should be considered carefully if generated event provenance depends on the template.

A reversible inactive/archive model is likely preferable.

---

## P1.3 - Reusable event defaults

Templates should be able to define practical defaults such as:

- event type
- region/audience
- timezone
- name
- description
- local start time
- duration
- signup enabled/disabled
- signup-close offset
- detailed-response timing where relevant
- publication offset
- publication destination/default behaviour
- ping roles
- organiser defaults
- role-request configuration
- reminder definitions

Not every field needs to ship in the first template implementation.

The first version should favour a coherent usable workflow over attempting every conceivable option at once.

---

## P1.4 - Default event duration

The current default duration for newly-created events is approximately:

```text
60 minutes
```

Template behaviour should respect explicit configured duration rather than reverting to older assumptions that regiment events normally last two hours.

---

## P1.5 - Template organiser defaults

Templates should be able to define:

- primary organiser default
- backup organiser default

When an event is generated:

```text
template defaults
       |
       v
ordinary dormant event organiser assignments
```

They must then follow the normal event organiser workflow.

The generated event, not the template, owns the runtime assignment.

---

## P1.6 - Template role-request defaults

Do not create a second incompatible reusable role-request system inside templates.

Prefer building on the existing role-request preset model.

Potential approaches include:

```text
template references role-request preset(s)
```

followed by:

```text
occurrence generation
    -> snapshot preset configuration
    -> event-level role options/groups
```

The exact relationship should be designed before schema implementation.

Important requirements:

- generated event receives ordinary event-level configuration
- runtime does not depend on the preset
- event remains independently editable
- later preset changes do not rewrite generated events

---

## P1.7 - Template reminder defaults

Templates should support reusable reminder definitions.

Example recurring event:

```text
10 minutes before signup close
    -> remind members to sign up

10 minutes before event start
    -> ask members to begin joining the event voice channel
```

Generation should produce:

```text
template reminder definition
        |
        v
event_reminders
        |
        v
ordinary durable scheduler action
```

The reminder then belongs to the generated event.

---

## P1.8 - Review reminder lifecycle before generating unpublished events far in advance

Current reminder behaviour was developed primarily around manually-created events.

Template-generated events may remain:

```text
scheduled
unpublished
```

for days or weeks.

Before using the existing reminder rescheduling helper during template generation, review signup-close reminder validity logic carefully.

A valid future signup-close reminder must not be cancelled merely because the event is still unpublished or has not yet entered its public signup phase.

This is a known implementation consideration, not a hypothetical nice-to-have.

---

## P1.9 - Template ping-role snapshots

Template defaults may reference guild roles.

When generating an event:

- resolve the configured role
- snapshot the role ID
- snapshot readable role name where appropriate
- create ordinary event ping-role rows

Changing the template later must not rewrite an already-generated event's ping audience.

---

## P1.10 - Template-generated events must be independently editable

Once generated, an event should be ordinary event state.

Administrators should be able to change that occurrence's:

- date/time
- duration
- description
- publication schedule
- organisers
- reminders
- role requests
- audience
- signup behaviour

without changing:

- the source template
- earlier occurrences
- other already-generated occurrences

---

## P1.11 - Template edits affect future generated events by default

Normal template editing should use:

```text
edit template
    -> affects not-yet-generated occurrences
```

It should not silently propagate into existing event rows.

If bulk propagation is ever useful, design it as a separate explicit operation with:

- preview
- clear scope
- conflict handling
- protection for individually-customised occurrences

Do not make propagation implicit.

---

## P1.12 - Template preview

Consider an administrator preview before generation or activation.

Useful preview information might include:

- event type
- region
- normal start time
- duration
- signup settings
- publication timing
- organiser defaults
- role-request preset
- reminder schedule

This could catch configuration mistakes before recurrence generates several events from them.

---

## P1.13 - Template provenance

Generated events should retain source-template provenance.

That provenance is useful for:

- administration
- recurrence identity
- debugging
- future reporting

It must not create a live dependency on current template configuration.

---

# P1 - Recurring Event Generation

## Objective

Generate future ordinary event occurrences from reusable templates.

Do not represent a recurring series as one magical event row whose date keeps changing.

---

## P1.14 - Standards-based recurrence representation

Prefer a recognised recurrence model such as:

```text
RFC 5545 RRULE
```

where practical.

Example concept:

```text
FREQ=WEEKLY
BYDAY=MO
```

A recurrence library should be evaluated rather than implementing calendar recurrence rules manually.

Requirements include correct handling of:

- weekly schedules
- timezone context
- daylight-saving changes
- exclusions
- series start/end
- occurrence counting

---

## P1.15 - Rolling generation horizon

Do not materialise an unlimited future series.

Generate occurrences for a rolling future horizon.

A working design target discussed so far is roughly:

```text
21 days
```

The final value may be configurable or adjusted after real use.

Benefits include:

- manageable database size
- manageable scheduled-action volume
- easier template edits
- easier series cancellation
- fewer unnecessary hypothetical events
- natural future-only application of template changes

---

## P1.16 - Generate before public announcement

A recurring occurrence should normally exist before it is publicly announced.

Desired sequence:

```text
occurrence enters generation horizon
        |
        v
persistent event created
        |
        +---- dormant organisers created
        |
        +---- role-request configuration snapshotted
        |
        +---- reminders created
        |
        +---- scheduled actions created
        |
        +---- administrator can inspect/edit
        |
        v
normal publication time arrives
```

Do not wait until publication time to create the occurrence for the first time.

---

## P1.17 - Immutable occurrence identity

A generated recurring occurrence needs an immutable identity separate from:

```text
event.startsAt
```

Example failure without one:

```text
Monday occurrence generated

administrator moves it to Tuesday

generator runs again

original Monday slot appears absent

duplicate event generated
```

Use a stable occurrence key derived from the series schedule's original occurrence identity.

Changing the event time must not change that key.

---

## P1.18 - Idempotent generation

Running the recurrence generator several times for the same horizon must not create duplicate occurrences.

Generation should have a durable uniqueness rule based on something like:

```text
template/series
+
occurrence key
```

Exact schema should be decided during implementation.

Concurrency must also be covered so two generation workers cannot create the same occurrence.

---

## P1.19 - Individual occurrence edits remain local

Editing one generated event should not rewrite:

- the recurrence rule
- the template
- neighbouring occurrences

A moved occurrence remains part of the same logical series through its immutable occurrence identity.

---

## P1.20 - Individual occurrence cancellation

Administrators must be able to cancel one occurrence without cancelling the whole recurring series.

Its immutable occurrence identity must prevent the generator from interpreting that cancellation as:

```text
occurrence missing, regenerate it
```

A cancelled generated event remains the occurrence record for that slot.

---

## P1.21 - Series/template disable behaviour

Define clearly what happens when recurring generation is disabled.

Likely default behaviour:

```text
disable future generation
    -> stop creating new occurrences
    -> leave already-generated events intact
```

Do not automatically cancel already-generated events unless the administrator explicitly requests that separate action.

---

## P1.22 - Recurrence schedule changes

When the recurrence definition changes:

- already-generated events should normally remain unchanged
- not-yet-generated occurrence calculation should use the new rule

More complex operations such as regenerating a future horizon should be explicit and carefully scoped.

---

## P1.23 - Daylight-saving behaviour

Recurring local event times must retain the intended local meaning.

Example:

```text
Every Monday at 20:00 Europe/London
```

should remain a 20:00 London event across daylight-saving transitions.

Do not implement recurrence by repeatedly adding fixed UTC durations if that changes the intended local wall-clock time.

---

## P1.24 - Recurrence scheduler architecture

Decide how rolling occurrence generation itself is triggered.

Possible approaches include:

- periodic durable scheduler work
- startup plus periodic sweep
- a dedicated recurring-generation action

Whichever approach is selected must be:

- restart-safe
- idempotent
- bounded
- concurrency-safe
- testable without relying on wall-clock sleeps

---

# P1 - Confirmed Organiser Unavailability

## Objective

Allow an organiser who has already confirmed to state that they can no longer operate the event.

This remains one of the most important unfinished organiser workflows.

---

## Desired primary flow

```text
Confirmed Primary
        |
        v
Unavailable
        |
        +---- viable Backup
        |       |
        |       v
        |   activate Backup
        |
        +---- no viable Backup
                |
                v
            General Cover
```

---

## Confirmed backup or cover becomes unavailable

Conceptually:

```text
Confirmed Backup/Cover
        |
        v
Unavailable
        |
        v
General Cover
```

Reuse:

- organiser assignment history
- current-owner semantics
- escalation services
- general-cover services
- safety deadlines

Do not introduce a parallel emergency-organiser model.

---

## Requirements

The workflow should:

- preserve assignment history
- remove current ownership safely
- activate a viable next path
- cancel obsolete scheduled actions
- respect event cancellation/completion
- respect organiser feature disable
- reconcile warning/administrative messages
- audit the transition
- handle concurrency with timeout/cover operations

---

# P1 - Remaining Server-Level Feature Controls

The organiser subsystem currently has server-level controls for:

- organisers as a whole
- organiser DM-first delivery

Additional administrator-only feature controls remain useful.

---

## P1.25 - Role-request parent feature switch

Consider a guild-level switch for the role-request subsystem.

Current role-request availability is influenced by event-type configuration.

A guild-level parent switch could provide:

```text
role requests disabled for this server
```

without removing event-type configuration.

If implemented, determine:

- whether existing open groups remain usable
- what happens to scheduled open/close actions
- whether application of presets is blocked
- whether manual event-level role configuration is blocked
- the required shared/exclusive locking contract
- what happens when the feature is re-enabled

Do not implement it as an unlocked boolean check if disabling must serialise against in-flight role-request operations.

---

## P1.26 - Other feature switches

Potential future controls include:

- actual attendance reporting
- reminders
- announcements
- reusable role-request presets
- automatic organiser escalation if a real use case requires separating it from organiser assignment

Only add switches that solve a real server-level configuration need.

Avoid producing a settings matrix larger than the features it controls.

---

# P2 - Event-Level Role-Request Administration

Reusable preset administration is the immediate priority.

Event-level role configuration could later receive richer edit operations as well.

---

## P2.1 - Event role-option editing

Potential operations include:

- edit display name
- edit description
- change request restriction
- replace qualification roles
- change capacity
- deactivate/reactivate an option

Historical requests may already reference an option.

Prefer non-destructive lifecycle changes over deleting records that have operational or historical meaning.

---

## P2.2 - Existing event request-group editing

Potential operations include:

- edit group name
- edit description
- change displayed options
- change signup requirement
- move future opening
- change closing rule
- change notification role
- move destination before publication
- retire/deactivate a planned group
- reopen where domain rules permit it

Editing a group after it has already posted requires care because:

```text
stored schedule
historical opening
Discord presentation
existing requests
```

may all already exist.

Do not treat this as the same problem as editing a reusable preset source.

---

## P2.3 - Explicit message move/repost administration

Automatic recovery currently handles important cases where an authoritative Discord message has been deleted but its destination is still known.

Administrators may still benefit from explicit tooling for cases such as:

- intentionally move an event message
- intentionally move a role-request group
- recreate in a new channel after the old channel was deleted
- force a presentation rebuild after repairing permissions

Such tools must not:

- duplicate role pings unexpectedly
- duplicate event state
- duplicate role-request records
- treat a new destination as automatic recovery

Moving presentation is an explicit administrative operation.

---

# P2 - Actual Attendance Participation Context

## Objective

Extend actual attendance beyond the current present/not-present model.

Initial event-specific context could include:

```text
participant
supervisor
organiser
server_admin
other
```

---

## Reporting goals

Potential reports could distinguish:

```text
Total present
Participants
Supervisors
Organisers
Server administrators
Other support attendance
```

---

## Signup comparison semantics

Participation context should improve discrepancy reporting.

Examples:

```text
participant + no signup
    -> likely walk-in

supervisor + no signup
    -> present
    -> not automatically a signup problem

organiser + no signup
    -> present
    -> not automatically a signup problem

server_admin + no signup
    -> present
    -> not automatically a signup problem
```

Bulk attendance recording should normally default to:

```text
participant
```

unless another context is supplied.

Discord roles may suggest a context.

They must not silently become immutable historical evidence.

---

# P2 - Cancellation Notifications

Extend event cancellation with optional notification of affected members.

Potential audiences include:

- Attending members
- Tentative members
- current organiser
- other specifically relevant operational roles

Avoid notifying people unnecessarily when they are already the actor performing the cancellation or otherwise clearly aware.

The event message should remain visibly cancelled.

Cancellation notification should be separate from the final database transition so a Discord delivery problem cannot undo event cancellation.

---

# P2 - Event Duplication

A convenient one-off event duplication workflow may still be useful even after templates exist.

Potential command:

```text
/event duplicate
```

Reasonable data to offer for copying:

- event configuration
- ping roles
- organiser nominees as fresh dormant assignments
- role options
- qualification rules
- request-group definitions
- reminder definitions

Do not copy historical/live state such as:

- signup responses
- actual attendance
- role requests
- organiser response history
- sent reminder state
- audit history
- Discord message IDs
- completed scheduled-action state

Template support may reduce the urgency of this feature.

Reassess after templates are in real use.

---

# P2 - Supervisor Availability Warnings

Where volunteers require supervision, organisers could receive useful warnings.

Example:

```text
Captain volunteers requiring supervision: 3
Qualified Supervisor volunteers available: 0
```

Possible presentation:

```text
⚠️ Three Captain volunteers currently require supervision,
but no qualified Supervisor volunteer is available.
```

Do not automatically allocate supervisors at this stage.

The system should inform a human organiser.

---

# P2 - Reminder Improvements

The current persistent reminder system is functional.

Potential extensions include:

- publication-relative reminders
- role-request-opening-relative reminders
- role-request-closing-relative reminders
- easier duplication
- richer destination options
- template-defined reminder sets
- recurrence-aware defaults
- additional timing references where a real use case exists

Missed reminders should continue to remain auditable rather than disappearing silently.

---

# P2 - `/event` Command Structure Review

The `/event` command has accumulated a broad administrator surface.

Before Discord's command limits or usability become active blockers, review whether some functionality should move to dedicated top-level command families.

Possible future direction:

```text
/event
    create
    edit
    list
    publish
    cancel
    refresh

/organiser
    set
    clear
    status
    ...

/roles
    option-add
    group-post
    requests
    ...

/reminder
    add
    edit
    list
    remove
```

The exact names should be driven by administrator usability.

A command-layout redesign should:

- preserve underlying services
- preserve authorisation
- preserve audit semantics
- avoid breaking existing workflows without good reason
- avoid mixing the redesign with unrelated domain changes

Do not move code merely to obtain prettier slash-command names.

---

# P2 - Health and Diagnostics

As scheduled and recoverable workflows continue growing, administrator diagnostics would become increasingly useful.

Potential diagnostics include:

- scheduler health
- pending action counts
- failed scheduled actions
- overdue actions
- stale processing actions
- failed event publication
- failed role-group publication
- missing Discord messages
- missing channels
- missing roles
- invalid reusable presets
- reminder failures
- organiser workflow anomalies
- database connectivity

Possible surfaces include:

```text
/health
```

or a future administrative portal.

Diagnostics should report state.

They should not silently mutate or "repair" records unless an explicit repair operation exists.

---

# P2 - Privacy and Data Management

Before substantially wider deployment, formalise policies and administrator tooling around stored data.

Relevant areas include:

- attendance history
- signup history
- role requests
- organiser history
- audit retention
- member deletion requests
- exports
- portal access
- administrator permissions

The project should avoid collecting information merely because Discord makes it technically available.

Retention and deletion decisions should preserve legitimate administrative requirements without creating unnecessary permanent member profiling.

---

# P2 - Targeted Architecture Improvements

The earlier broad reliability and modularity phase has already produced substantial service extraction.

Further architecture work should now be driven by concrete pressure rather than a standing instruction to refactor everything.

Likely useful areas include:

- reducing oversized command adapters when new changes touch them
- splitting scheduler action executors if action breadth becomes difficult to maintain
- extracting common event loading only where it removes real duplication
- preserving shared authorisation helpers
- strengthening direct service tests
- documenting lock order near race-sensitive transactions

Avoid:

- generic repository layers without a need
- large framework rewrites
- speculative dependency injection
- microservices
- abstraction motivated only by line count

---

# P3 - Portal Integration

A future web portal could expose information such as:

- upcoming events
- event details
- template management
- recurring-series management
- attendance history
- signup-versus-attendance comparison
- role requests
- organiser administration
- member attendance history
- event statistics
- diagnostics

If collaboration with the existing community bot proceeds, prefer extending a suitable existing portal over creating a redundant competing one.

A portal should consume reusable domain/application boundaries.

It should not reproduce Discord slash-command parsing.

---

# P3 - Integration With Existing Attendance Tooling

Another community bot may already record actual attendance automatically.

If that remains the authoritative source, future integration should prefer:

1. reusing or importing authoritative attendance data
2. introducing an adapter/service boundary
3. mapping stable event identifiers
4. mapping guild and user identity explicitly
5. avoiding duplicate attendance capture

Direct shared-database access should only be used if both systems deliberately adopt that architecture.

Do not couple two independently-evolving schemas accidentally.

---

# P3 - Migration and Transplant Support

If major subsystems are later moved into another bot:

1. identify the portable service boundary
2. document the required domain concepts
3. map source and destination event identity
4. map guild identity
5. map user identity
6. map authorisation
7. adapt scheduling hooks
8. adapt Discord rendering
9. write destination-specific migrations
10. preserve audit requirements

Candidate portable areas include:

- event creation
- event publication
- organisers
- role requests
- role-request presets
- reminders
- scheduler patterns
- attendance reporting

A shared package or monorepo should be introduced only if actual code-sharing requirements justify the added maintenance cost.

---

# P3 - Cross-Server Event Support

The community operates more than one Discord server.

A possible long-term model is:

```text
One canonical event
        |
        +---- message in primary server
        |
        +---- optional presentation in another server
        |
        +---- shared event-level participation state
```

This is not equivalent to simply sending the same embed twice.

A proper model must consider:

- canonical event identity
- guild ownership
- multiple Discord presentation records
- administrator permissions
- cross-server users
- audiences
- channel configuration
- notification targeting
- role qualification across guilds
- signup and role-request authority

Do not implement naïve mirrored messages before the domain model can represent multiple Discord surfaces deliberately.

---

# P3 - Export and Interoperability

Potential export formats include:

- CSV
- JSON
- spreadsheet output
- portal/API adapters

Useful export areas include:

- actual attendance
- signup responses
- signup-versus-attendance reports
- role requests
- event summaries
- historical reporting

Exports should use database/domain state.

Do not scrape rendered Discord messages to reconstruct information already stored in PostgreSQL.

---

# P3 - Improved Discord Presentation

Current Discord presentation is functional rather than final.

Future improvements may use newer Discord components to improve:

- event readability
- attendance summaries
- organiser information
- role-request presentation
- preset administration
- pagination
- compactness
- mobile usability

Do not perform a major UI redesign while underlying domain workflows are still changing substantially.

Stable services should remain usable even if the Discord presentation is later replaced.

---

# P3 - Pagination

Introduce pagination or other bounded display strategies where Discord limits justify it.

Likely candidates include:

- large event lists
- role-request organiser views
- attendance-response lists
- historical attendance reports
- audit history
- large preset definitions
- future template lists

Do not introduce a pagination framework everywhere pre-emptively.

Use it where output size is a real problem.

---

# P3 - Role Capacity and Waitlists

Role options already have a capacity concept.

Before implementing capacity enforcement, decide what capacity means.

Possibilities include:

```text
organiser guidance only
automatic waitlist
hard request limit
soft warning threshold
```

The current system records volunteer interest.

It does not automatically allocate roles.

Capacity behaviour must not accidentally convert:

```text
request
```

into:

```text
guaranteed assignment
```

---

# P3 - Automated Role Allocation

Automatic role allocation is deliberately not a current priority.

A meaningful allocation system would need to consider:

- qualification
- supervision
- attendance availability
- multiple requested roles
- capacities
- event-specific needs
- request timing
- organiser judgement
- potentially team composition

The current volunteer-request model should remain until there is a strong practical reason to automate allocation.

If allocation is ever introduced, organisers should retain meaningful control.

---

# P3 - Advanced Analytics

Potential later analytics include:

- signup accuracy by event type
- attendance trends
- participation frequency
- role volunteering trends
- organiser coverage
- no-show patterns
- walk-in patterns
- template usage
- recurrence attendance trends

Analytics must remain informational.

Do not automatically turn them into disciplinary scores or punitive automation.

Context matters, particularly for:

- Tentative members
- supervisors
- organisers
- technical problems
- exceptional event circumstances

---

# P3 - Additional Integrations

Possible future external systems include:

- existing community attendance bot
- existing community portal
- Google Sheets
- other event systems

External integrations should use adapters.

Provider-specific assumptions should not spread throughout the core event-management services.

---

# Development Practices That Apply Across the Roadmap

These are not individual roadmap features.

They are expectations for all future work.

---

## Regression-first bug fixing

For discovered bugs:

```text
reproduce
   |
   v
add failing regression
   |
   v
confirm correct failure
   |
   v
implement narrow fix
   |
   v
run targeted coverage
   |
   v
run full gate
```

Do not skip the regression simply because the fix appears obvious.

---

## Direct service integration testing

New reusable service boundaries should receive direct integration coverage where they interact with PostgreSQL.

This is particularly important for:

- ownership
- locks
- transactions
- persistence
- idempotency
- scheduled actions
- concurrency

---

## Real PostgreSQL for integration tests

Continue using Testcontainers and real PostgreSQL for database integration tests.

Do not replace race-sensitive database tests with an in-memory approximation.

---

## Deterministic race testing

Prefer:

- explicit locks
- promises/barriers
- controlled interleavings

over arbitrary sleeps.

A concurrency test should prove the intended race ordering rather than merely hope the machine was slow enough.

---

## Discord side effects after authoritative decisions

External Discord calls cannot be transactional.

Future workflows must deliberately decide:

- what database decision happens before Discord
- what state is rechecked afterwards
- what happens if Discord fails
- how a losing concurrent Discord side effect is cleaned up

---

## Full verification before PR-ready work

The expected full gate remains:

```bash
npm run test:unit
npm run test:integration
npm run test:coverage
npm run typecheck
npm run typecheck:test
```

Manual Discord smoke tests should also be performed when a change depends materially on:

- command registration
- components
- role selection
- channel selection
- permissions
- mentions
- DMs
- real Discord error behaviour

---

## Small reviewable commits and PRs

Prefer coherent milestones over extremely large feature branches.

Useful boundaries include:

```text
domain/service foundation
Discord adapter
reliability follow-up
complete subsystem milestone
```

A PR should tell one understandable story where practical.

---

## Documentation checkpoints

After a substantial architectural milestone:

- update `ARCHITECTURE.md`
- update `DECISIONS.md` when invariants changed
- reconcile `ROADMAP.md`
- rewrite stale `CURRENT-WORK.md`
- update `ADMIN-GUIDE.md` for public command changes
- update `TESTING-GUIDE.md` when workflow changes

Do not allow completed features to remain indefinitely described as future work.

---

# Recently Completed Milestones

The following areas were previously roadmap work but are now established enough that they are **not future roadmap items**.

This section is intentionally concise.

Detailed current behaviour belongs elsewhere in the documentation.

---

## Reliability and automated testing foundation

Completed work includes:

- Vitest unit tests
- PostgreSQL integration tests using Testcontainers
- coverage reporting
- production and test typechecking
- deterministic concurrency testing patterns
- scheduler retry regression coverage
- scheduler stale-lock handling
- scheduler stale-worker fencing
- migration-chain testing

---

## Publication reliability

Completed work includes:

- immediate publication
- manual publication
- scheduled publication
- duplicate/racing publication protection
- publication destination snapshotting
- lifecycle revalidation
- cancellation safety
- deleted attendance-message recovery

---

## Organiser reliability and escalation

Completed work includes:

- dormant unpublished-event nominees
- primary confirmation/decline
- primary timeout
- backup escalation
- backup timeout
- general cover
- cover claiming
- warning reconciliation
- organiser feature locking
- DM-first delivery control
- organiser safety deadline
- missing-organiser-at-start handling
- late-publication safety behaviour
- post-start cover claiming when still required

The confirmed-organiser unavailability workflow remains future work.

---

## Core role-request system

Completed work includes:

- event-level role options
- qualification rules
- supervision-required qualification
- independent multi-select role requests
- explicit withdrawal
- shared pools across groups
- signup-gated groups
- attendance-aware request availability
- scheduled closing
- signed before/after-start timing
- scheduled opening
- durable opening/closing actions
- event-start rescheduling
- publication-intent-aware automatic opening
- manual-hold deferral without consuming scheduler retries
- publication wake-up for already-due groups
- intentional pre-publication role-group support
- in-flight publication-intent race protection
- deleted-message recovery
- concurrent publication/recovery protection

Richer editing of existing event-level role configuration remains future work.

---

## Reusable role-request preset foundation

Completed work includes:

- preset schema
- reusable options
- qualification snapshots
- reusable request groups
- ordered mappings
- fixed or apply-time-default channels
- notification-role snapshots
- signed opening/closing defaults
- preset create/list/show commands
- option creation
- group creation
- application to existing events
- event-level provenance
- durable action creation during application
- parent preset lifecycle
- option lifecycle
- group lifecycle
- warning when option deactivation leaves an active group unusable
- snapshot independence
- preset application/mutation locking

Editing existing preset definitions remains the immediate next phase.

---

# Deliberately Not Prioritised

The following remain lower priority than reliable event administration, templates, recurrence, and useful integration:

- complete Discord UI redesign
- automated disciplinary systems
- automated role allocation
- hardcoding many naval or linebattle subtypes
- premature microservices
- premature monorepo architecture
- speculative generic framework abstractions
- building a competing portal where collaboration is practical
- large-scale analytics before the underlying event workflows stabilise

The project goal remains:

```text
a robust,
understandable,
well-tested,
portable event-management system
```

rather than maximum feature count.

---

# Review Points

The roadmap should be reconciled again after major milestones.

The next obvious review points are:

```text
preset editing complete

event templates complete

recurring generation complete

confirmed-organiser unavailability complete

major external integration begins
```

At each checkpoint:

1. remove completed work from future sections
2. move enduring behaviour into architecture/decision documentation
3. reconsider priorities using actual community use
4. record newly-discovered reliability requirements
5. avoid retaining obsolete plans solely because they appeared in an older roadmap

---

# Related Documentation

See:

- [`../README.md`](../README.md) for the project overview
- [`ARCHITECTURE.md`](ARCHITECTURE.md) for current implementation structure
- [`DECISIONS.md`](DECISIONS.md) for durable invariants and design rationale
- [`CURRENT-WORK.md`](CURRENT-WORK.md) for the exact current development checkpoint
- [`TESTING-GUIDE.md`](TESTING-GUIDE.md) for verification workflow
- [`ADMIN-GUIDE.md`](ADMIN-GUIDE.md) for currently available administrator commands

Where this roadmap conflicts with an implemented invariant recorded in `DECISIONS.md`, the decision record takes precedence until the project explicitly changes that decision.
