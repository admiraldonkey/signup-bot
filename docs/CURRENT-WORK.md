# Current Development State

**Last reconciled:** 10 September 2026

This document is the short-form handoff for the current development checkpoint.

It is intentionally not a chronological changelog.

For durable context, read these alongside it:

- [`README.md`](../README.md)
- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`DECISIONS.md`](./DECISIONS.md)
- [`ROADMAP.md`](./ROADMAP.md)
- [`TESTING-GUIDE.md`](./TESTING-GUIDE.md)
- [`ADMIN-GUIDE.md`](./ADMIN-GUIDE.md)

If this document becomes substantially longer because completed work keeps being appended to it, rewrite it around the new checkpoint instead.

---

# Current Repository Checkpoint

The most recent completed development slice is the role-request publication-intent reliability pass.

The implementation has been committed and pushed.

Current automated verification is green across:

```text
npm run test:unit
npm run test:integration
npm run test:coverage
npm run typecheck
npm run typecheck:test
```

Relevant focused PostgreSQL integration suites are also green.

Manual Discord smoke testing confirmed the intended publication behaviour for:

```text
manual-held unpublished event
    -> due automatic role group remains unpublished

manual publication
    -> already-due valid role group wakes and posts

future scheduled event publication
    -> deliberately earlier role group may post first

future role group
    -> remains scheduled after event publication
```

Always verify local branch and working-tree state before beginning the next development slice.

---

# Current Activity

The role-request publication-intent reliability pass addressed an ambiguity discovered during manual preset testing.

Previously, a preset-derived scheduled role-request group could publish whenever its opening time arrived even if the parent event was being deliberately held for manual publication.

Automatic role-request publication now distinguishes:

```text
event published
    -> due group may publish

event unpublished
manual publication required
    -> automatic group waits

event unpublished
future scheduled publication
    -> deliberately earlier group may publish

event unpublished
scheduled publication already due
    -> later groups wait for event publication
```

Waiting for event publication is represented as:

```text
awaiting-event-publication
```

and is treated as deliberate domain deferral rather than scheduler failure.

A deferred opening action is parked at the group's closing boundary with retry state reset.

Successful event publication wakes already-due, still-valid role-group opening actions in the same PostgreSQL transaction as publication.

Future groups retain their existing schedule.

Role-request publication also re-checks event publication intent after Discord message creation.

If the event changes to a manual hold while a message is in flight, the stale Discord candidate is not linked and is deleted where possible.

The next production feature objective is:

```text
editing existing reusable role-request presets
```

The intended sequence remains:

```text
preset editing
    |
    v
event templates
    |
    v
recurrence
```

---

# Most Recently Completed Feature Area

## Role-request publication intent

Automatic preset-derived role-request publication now respects how the parent event is intended to become public.

Current behaviour is:

```text
Published event
    -> due group may post

Manual-held unpublished event
    -> due automatic group waits

Future scheduled publication
    -> deliberately earlier due group may post

Scheduled publication overdue
event still unpublished
    -> later automatic group waits
```

Manual `/event role-group-post` remains a separate explicit administrator action.

---

## Durable deferral

Waiting for event publication does not consume scheduler retry attempts.

Instead:

```text
due opening
    |
    v
awaiting event publication
    |
    v
opening action parked at closesAt
```

If the parent event publishes while the request window remains valid:

```text
event publication
    |
    v
due deferred opening reset to pending
dueAt = publishedAt
attemptCount = 0
```

If the event never publishes, the action eventually reaches the closing boundary and expires naturally.

---

## Publication wake-up

The reusable event-publication service wakes already-due deferred role-group openings in the same transaction that commits event publication.

Only groups satisfying:

```text
opensAt <= publishedAt < closesAt
```

are resumed.

Future groups retain their original opening schedule.

The wake-up helper supports both:

```text
pending
processing
```

opening actions.

Resetting a processing action to fresh pending state uses the scheduler's existing attempt/status fencing so a stale worker cannot later overwrite the newer schedule.

---

## Discord in-flight race

Role-group publication re-checks parent-event publication intent after the Discord send and before authoritative linkage.

If publication intent becomes incompatible while Discord is in flight:

```text
candidate message sent

event changes

linkage rejected

candidate deleted
```

The Discord send does not become authoritative merely because it completed first.

---

# Current Role-Request Preset Capability

The reusable preset subsystem is now established enough that future work should treat it as existing architecture rather than a prototype.

Current administrator capabilities include:

```text
/role-preset create
/role-preset list
/role-preset show
/role-preset option-add
/role-preset group-add
/role-preset apply
/role-preset set-active
/role-preset option-set-active
/role-preset group-set-active
```

The system currently supports reusable:

- logical role options
- descriptions
- request restrictions
- capacities
- qualification-role snapshots
- fully-qualified and supervision-required qualification levels
- multiple request groups
- ordered option mappings
- signup requirements
- fixed destination channels
- apply-time default-channel resolution
- notification-role snapshots
- event-relative opening offsets
- event-relative closing offsets

The major missing administration capability is editing existing definitions.

---

# Preset Snapshot Architecture

Preset application uses snapshot semantics.

Conceptually:

```text
Reusable preset
       |
       | apply
       v
Event-level role-request configuration
       |
       v
Runtime uses event-level state
```

After application, the event does not continuously consult the source preset.

Later preset changes must not alter an already-applied event.

This includes:

- lifecycle changes
- future metadata edits
- future qualification edits
- future group timing edits
- future mapping edits

Source IDs remain useful as provenance.

They are not live inheritance.

---

# Preset Application Concurrency Contract

Preset application and mutation serialise through the preset parent row.

Current contract:

```text
preset application
    -> role_request_presets FOR SHARE

preset mutation
    -> role_request_presets FOR UPDATE
```

Future preset-edit operations must participate in the same contract.

The intended guarantee is:

```text
application sees complete state before mutation

or

application sees complete state after mutation
```

It must not observe a half-edited preset graph.

This is one of the most important requirements for the next feature phase.

---

# Role-Request Preset Application

Applying a reusable preset to an event currently:

1. validates the event and event type
2. verifies the preset belongs to the guild
3. verifies the preset is active
4. locks the preset for application
5. validates active role options
6. validates qualification configuration
7. validates active groups
8. validates group-option mappings
9. validates signup requirements
10. resolves any apply-time default role-request channel
11. validates request-group timing
12. creates event-level role options
13. snapshots qualification roles
14. creates event-level request groups
15. snapshots mappings and notification metadata
16. stores source provenance
17. creates durable opening actions
18. creates durable closing actions
19. records that this preset was applied to this event

The operational snapshot and the required scheduler work are created atomically.

Do not split those into independent best-effort operations.

---

# Current Role-Request Scheduling State

Scheduled role-request opening and closing are implemented.

Preset-derived groups may have event-relative opening and closing rules.

Application creates durable actions using keys such as:

```text
role_request_group_open:<groupId>
role_request_group_close:<groupId>
```

Current group lifecycle presentation distinguishes:

```text
Planned
Pending publication
Open
Closed
```

A request group is not considered genuinely open merely because its opening time has arrived.

If its usable Discord message has not successfully been linked yet, it remains pending publication.

Automatic opening also respects event publication intent.

```text
published event
    -> normal due publication

manual-held unpublished event
    -> defer

future scheduled publication
    -> intentional earlier group may publish

overdue scheduled publication
    -> defer until event publishes
```

A deferred opening is parked at `closesAt` without consuming scheduler retry attempts.

Successful event publication wakes already-due groups whose request windows remain valid.

Future groups are not pulled forward.

---

# Event Start Changes and Role-Request Groups

Changing the event start recalculates still-relevant role-request scheduling.

Current rules include:

```text
Unposted group with relative opening
    -> recalculate opening
    -> reschedule opening action
    -> recalculate closing
    -> reschedule closing action

Already-posted group
    -> preserve historical opening
    -> recalculate closing
    -> reschedule closing action

Manual immediate group
    -> preserve immediate opening
    -> recalculate closing only

Closed group
    -> remain closed
```

A manually-created immediately-posted group has:

```text
openMinutesBeforeStart = null
```

This means:

```text
no event-relative opening rule
```

Do not infer a synthetic offset later.

---

# Role-Request Message Recovery

Deleted role-request group messages can now be recovered where the authoritative destination remains known.

Current behaviour:

```text
stored message exists
    -> edit it

Discord explicitly reports message deleted
    -> rebuild from PostgreSQL
    -> send replacement
    -> conditionally claim new linkage

another recovery already won
    -> remove losing replacement
    -> preserve winner

channel deleted or unavailable
    -> do not guess another destination

unexpected Discord error
    -> propagate rather than pretending deletion occurred
```

Recovery does not replay the original notification-role ping.

The same broad database-authoritative pattern is used for attendance/event message recovery.

---

# Current Organiser Architecture

The organiser subsystem is mature enough that future feature work should preserve its existing service boundaries and concurrency rules.

Current organiser assignment slots include:

```text
primary
backup
cover
```

Assignments retain history through statuses such as:

```text
pending
confirmed
declined
timed_out
replaced
removed
```

Current ownership is represented separately.

The event creator is not implicitly the organiser.

---

# Dormant Organiser Semantics

Organisers assigned to an unpublished event remain dormant.

Normally:

```text
activatedAt = null
responseDeadlineAt = null
```

until the organiser workflow activates.

This prevents private preparation time from consuming the organiser's response period.

Normal primary activation happens around event publication.

However, publication timing is subordinate to the organiser safety rules described below.

---

# Organiser Notification Delivery

The organiser subsystem currently supports:

```text
organisersEnabled
organiserDmsEnabled
```

When organiser DM delivery is enabled:

```text
try DM
    |
    +---- success
    |
    +---- failure
            |
            v
Event Administration channel
```

When DM delivery is disabled:

```text
skip DM
    |
    v
Event Administration channel
```

These are separate controls.

Disabling organiser DMs does not disable organiser management as a whole.

---

# Organiser Escalation

Normal progression is:

```text
Primary
   |
   +---- confirms -> resolved
   |
   +---- declines / times out
                |
                v
             Backup
                |
                +---- confirms -> resolved
                |
                +---- declines / times out
                             |
                             v
                         General Cover
```

General cover is claimable by an eligible organiser.

The system must never produce multiple simultaneous current organisers through a race between:

- confirmation
- timeout
- backup activation
- cover escalation
- cover claim
- replacement
- cancellation
- completion

---

# Organiser Warning and Cover Reconciliation

Administrative organiser-warning messages are linked back to their assignment.

Once an assignment resolves, the warning is updated where possible.

Current warning-resolution cases include:

- confirmed
- declined
- timed out
- replaced
- removed
- cancelled event
- completed event

General-cover and missing-organiser-at-start messages are separately tracked through `event_messages`.

Outstanding tracked cover presentation is reconciled after relevant states including:

```text
cover claimed
active organiser established
older cover message superseded at event start
organisers disabled
event cancelled
event completed
```

Reconciliation removes interactive components so old `Claim Event` buttons do not remain apparently usable.

Known deleted Discord messages or channels are recorded as missing presentation without invalidating authoritative organiser state.

Unexpected Discord failures remain distinguishable from deletion.

The event-start supersession path first sends and durably links the new T+0 alert, then resolves older general-cover messages.

---

# Organiser Safety Deadline

The organiser workflow now includes an event-level safety deadline.

Default guild configuration currently uses a lead of approximately:

```text
15 minutes before event start
```

subject to guild configuration.

At the safety deadline, if no organiser has confirmed:

- unresolved nominee flow is retired
- obsolete nominee warning/timeout work is cancelled or made irrelevant
- general cover becomes the authoritative path

This prevents the normal primary or backup response window from consuming the final useful period before the event.

---

# Missing Organiser at Event Start

There is a separate event-level check at:

```text
T + 0
```

If the event still has no organiser, the system can issue urgent administrative handling.

The safety deadline and the event-start alert solve different problems.

Do not merge them into one action.

Stable keys include:

```text
organiser_cover_deadline:<eventId>
organiser_missing_at_start:<eventId>
```

---

# Late Publication and Organisers

An event may be published after its normal organiser safety deadline.

In that case the system must not activate the dormant primary and grant a fresh full response window that has already become operationally obsolete.

Current event timing remains authoritative.

Late publication should therefore enter the appropriate cover/safety path.

This behaviour is regression tested and must be preserved.

---

# Cover Claims After Event Start

An older rule rejected all organiser cover claims after event start.

That rule is obsolete.

Current intended behaviour allows an eligible organiser to claim cover after the event begins when:

- the event remains operational
- organisers are enabled
- no valid organiser currently owns the event
- general cover remains the appropriate path

The fact that the start timestamp has passed does not make finding an organiser pointless.

Do not reintroduce the blanket post-start rejection.

---

# Organiser Feature Locking

Normal organiser operations use the guild settings row as part of a feature-lock contract.

Conceptually:

```text
normal organiser operation
    -> guild_settings FOR SHARE

disable organiser subsystem
    -> guild_settings FOR UPDATE
```

This prevents a normal organiser operation from reading "enabled", waiting, then completing after the administrator has already disabled the subsystem.

New organiser operations should participate in the established contract.

---

# Current Event Creation Boundary

Database-side event creation is centralised in:

```text
src/events/event-creation-service.ts
```

The primary reusable boundary is:

```ts
createStoredEvent(...)
```

It handles persistent creation concerns such as:

- event row
- ping-role snapshots
- dormant organiser assignments
- scheduled publication
- attendance closure
- completion scheduling
- template provenance where supplied

Discord command parsing and immediate Discord presentation remain adapter concerns.

This boundary is intentionally important for future template and recurrence work.

Future generators should reuse event creation rather than simulate `/event create`.

---

# Event Publication

Event publication supports:

```text
immediate
manual
scheduled
```

Publication state remains separate from event lifecycle.

An unpublished event is still a real persistent event.

Scheduled publication uses:

```text
publish_event
```

Manual publication can supersede outstanding scheduled publication safely.

Publication uses conditional database authority so concurrent publication attempts cannot both become authoritative.

A losing duplicate Discord message is removed where practical.

---

# Attendance State

Attendance intention and actual attendance remain separate.

Signup states include:

```text
Attending
Tentative
Not Attending
```

Actual attendance is recorded independently after or during the event.

No-signup events remain a first-class mode.

A no-signup event:

- has no attendance-response buttons
- has no signup deadline
- may still record actual attendance
- may use organisers
- may use role requests where enabled
- may use reminders and announcements
- must not create fake signup-reliability conclusions

---

# Role-Request Domain Invariants

Future work must preserve the following current rules.

## Requests are event-level

A logical request is identified by:

```text
event
+ user
+ role option
```

The Discord request group is presentation/provenance.

It does not own a separate volunteer pool.

---

## Shared pools across groups

The same logical role may appear in several request groups.

For example:

```text
Early Command Interest
    Captain

Main Naval Roles
    Captain
```

Both represent the same event-level Captain pool.

---

## Requests are independent

Members may request several roles at once.

They are not ranked first, second, and third preferences.

---

## Duplicate clicks are not withdrawals

Clicking an already-requested role keeps the request intact.

Withdrawal is explicit through request management.

---

## Qualification and notification are separate

Qualification answers:

```text
Who may request this role?
```

Notification answers:

```text
Who should be told the request group opened?
```

Do not merge these concepts.

---

## Supervision-required eligibility is intentional

A role may distinguish:

```text
qualified
supervision_required
```

A supervision-required member can still express interest where allowed.

The organiser needs visibility of that distinction.

---

## Attendance availability does not destroy role willingness

Changing attendance to Not Attending may make a stored request unavailable.

It does not automatically delete the request.

If the member returns to an eligible attendance state, the existing request can become available again without receiving a new request timestamp.

---

# Durable Scheduler State

The PostgreSQL-backed scheduler currently handles work including:

```text
publish_event
close_attendance
complete_event

event reminders

organiser warnings
organiser timeouts
organiser escalation
organiser cover deadlines
missing organiser at event start

role-request group opening
role-request group closing
```

The scheduler includes:

- persistent action rows
- conditional action claiming
- processing locks
- stale-lock recovery
- bounded retry
- increasing retry delay
- terminal failure
- cancellation
- authoritative rescheduling
- stale-worker completion fencing

---

# Scheduler Retry Policy

Current retry behaviour begins approximately:

```text
Attempt 1 -> retry after 1 minute
Attempt 2 -> retry after 2 minutes
Attempt 3 -> retry after 4 minutes
Attempt 4 -> retry after 8 minutes
Attempt 5 -> terminal failure
```

A sixth execution attempt must not be created accidentally.

The exact delay numbers are less important than preserving:

```text
bounded
persistent
increasing
```

retry behaviour.

---

# Stale Scheduler Worker Fencing

A worker may:

1. claim work
2. become stalled
3. lose ownership through recovery or authoritative rescheduling
4. later resume

That stale worker must not overwrite the newer scheduler state.

Completion/retry updates therefore depend on continued ownership of the claimed attempt.

This invariant is regression tested.

Do not weaken it for convenience.

---

# Administrative Rescheduling

An administrator moving event timing is not a scheduler failure.

When a logical action is authoritatively rescheduled, stale attempt metadata should be reset where appropriate.

Typical reset:

```text
status = pending
attemptCount = 0
lockedAt = null
completedAt = null
lastError = null
```

The new schedule becomes authoritative.

---

# Discord Message Recovery

Core automatic message recovery is implemented for:

- event attendance/publication messages
- role-request group messages

Important recovery rules:

```text
database state remains authoritative

only known deleted-message conditions trigger recreation

destination must still be known

recovery must not replay normal notification pings

concurrent replacements must leave one authoritative linkage

deleted destination channel does not trigger guesswork

unexpected Discord errors are not silently treated as deletion
```

Further administrative tooling for intentionally moving or recreating messages in a different channel remains future work.

---

# Audit State

Administrative audit records are persisted in PostgreSQL.

The database audit record is authoritative.

Discord log-channel output is optional presentation.

Automatic scheduler actions are also audited where appropriate.

Idempotent lifecycle no-ops should not be recorded as though a mutation occurred.

---

# Automated Testing State

The project currently uses:

```text
Vitest
PostgreSQL
Testcontainers
V8 coverage
TypeScript production typecheck
TypeScript test typecheck
```

Database integration tests run against real disposable PostgreSQL instances.

They are not in-memory database simulations.

This is required because important behaviour depends on:

- transactions
- locks
- uniqueness constraints
- migration behaviour
- concurrent claims
- row ownership
- PostgreSQL error semantics

---

# Current Test Commands

Focused tests should normally be run during implementation.

Full commands available include:

```bash
npm run test:unit
npm run test:integration
npm run test:coverage
npm run typecheck
npm run typecheck:test
```

The normal full pre-PR verification gate is:

```bash
npm run test:unit
npm run test:integration
npm run test:coverage
npm run typecheck
npm run typecheck:test
```

See `TESTING-GUIDE.md` for detailed sequencing.

---

# Regression-First Workflow

When a bug is found:

```text
reproduce problem
      |
      v
write regression
      |
      v
confirm it fails for the intended reason
      |
      v
implement narrow production fix
      |
      v
add companion/positive coverage where useful
      |
      v
run targeted tests
      |
      v
run broader subsystem tests
      |
      v
run full verification gate
```

The red regression should be observed before the fix.

It does not normally need to be committed as a permanently failing commit.

This supersedes older documentation which recommended committing every red regression separately.

---

# Concurrency Test Convention

Race tests should prefer deterministic coordination.

Use techniques such as:

- explicit PostgreSQL row locks
- transactions
- controlled promises/barriers
- conditional updates
- known service boundaries

Avoid relying on arbitrary sleep durations as proof that one operation probably reached a race point before another.

---

# Manual Discord Testing

Manual Discord smoke testing remains useful when a change depends on behaviour that mocks or PostgreSQL tests do not fully represent.

Examples include:

- slash-command registration
- Discord command option UX
- role selection
- channel selection
- real permission behaviour
- mentionability
- DM delivery
- Event Administration fallback
- deleted real messages
- real button/component behaviour
- message appearance

Do not perform manual Discord testing for every pure database helper.

Do perform it when the Discord surface itself changed materially.

---

# Current Known or Deliberately Deferred Work

There is no known blocker at this checkpoint preventing continued feature development.

The following work is deliberately unfinished.

---

## Preset editing

Immediate next feature phase.

The current system can create and lifecycle-manage presets but does not yet provide a complete administrator workflow for editing existing definitions.

Planned areas include:

- preset name/description editing
- option metadata editing
- request restriction editing
- capacity editing
- qualification-role editing
- request-group metadata editing
- destination editing
- notification-role editing
- signup-rule editing
- opening/closing timing editing
- group-option mapping editing

This work must preserve the current preset mutation lock.

---

## Confirmed organiser becomes unavailable

A confirmed organiser does not yet have a complete self-service unavailability workflow.

Intended direction:

```text
confirmed primary unavailable
        |
        +---- viable backup
        |
        +---- otherwise general cover
```

This should reuse existing organiser assignment and escalation services.

---

## Event Administration channel deletion

Organiser behaviour should receive further targeted reliability coverage for the case where the configured Event Administration channel itself is deleted.

Requirements include distinguishing:

```text
definitive Discord deletion
```

from:

```text
transient/unexpected failure
```

Do not guess a new administrative destination automatically.

---

## Organiser notification role deletion

Further targeted verification is worthwhile when the configured organiser notification role no longer exists.

Missing notification presentation must not corrupt authoritative organiser state.

---

## Event-level role-request editing

Current event-level role options/groups are functional but do not yet have a full rich edit lifecycle comparable to the planned preset edit surface.

This is lower priority than reusable preset editing and templates.

---

## Rich attendance participation context

Actual attendance currently records presence.

Future reporting may distinguish event-specific roles such as:

```text
participant
supervisor
organiser
server_admin
other
```

This remains planned.

---

# Immediate Next Objective

After this reliability PR is merged, start a fresh feature branch from updated `main` for:

```text
reusable role-request preset editing
```

The current preset foundation, application, lifecycle, scheduling, publication-intent, and snapshot behaviour should be treated as established architecture rather than work to redesign casually.

The next feature phase should build on those boundaries.

---

# Expected Preset-Editing Development Order

A sensible initial sequence is:

```text
1. decide edit command/service surface

2. preset metadata editing

3. role-option editing

4. qualification-role editing

5. request-group editing

6. group-option mapping editing

7. complete command UX review

8. full preset administration manual smoke test
```

The exact split into commits or PRs should remain reviewable rather than forcing the entire edit subsystem into one enormous change.

---

# Preset Editing Requirements

Before implementing any edit operation, preserve these invariants.

## Parent lock

```text
mutation
    -> preset parent FOR UPDATE
```

---

## Snapshot independence

Existing event snapshots do not change.

---

## Guild isolation

A guild cannot mutate another guild's preset.

---

## Child ownership

An option or group from preset B cannot be edited through preset A.

---

## Idempotency

Requesting a value already stored should normally return:

```text
unchanged
```

without falsely updating timestamps or creating a success audit mutation.

---

## Atomic multi-row edits

Qualification replacements and mapping changes should be transactional.

A partially-applied edit graph must not become visible.

---

## Application remains authoritative

Discord-side validation may improve UX.

Preset application must still validate the complete graph itself.

---

# Next Likely Preset-Editing Decisions

A few questions should be answered deliberately when implementation reaches them.

---

## Logical option key editing

Decide whether a preset role option's logical key should:

```text
remain immutable
```

or:

```text
be editable with conflict validation
```

Display-name editing does not necessarily imply identity-key editing.

Avoid conflating the two.

---

## Group mapping update style

Decide whether administrator UX should primarily support:

```text
add mapping
remove mapping
```

or:

```text
replace complete ordered mapping set
```

A complete replacement operation may provide simpler atomic validation.

---

## Temporarily invalid preset edits

Lifecycle operations already permit a temporarily invalid graph and warn the administrator.

For edit operations, decide which invalid intermediate states should also be allowed.

Whatever choice is made should be:

- explicit
- service validated
- documented in `DECISIONS.md`
- regression tested

---

# Work After Preset Editing

The intended main sequence remains:

```text
Preset editing
      |
      v
Event templates
      |
      v
Recurring event generation
```

---

# Event Template Direction

Event templates are planned but not complete.

Some schema scaffolding exists.

Do not treat that scaffolding as a finished architecture contract.

Future templates should generate:

```text
ordinary persistent events
```

through reusable event-creation boundaries.

Generated events should receive event-level snapshots and become independently editable.

---

# Template Snapshot Expectations

Future template generation should be able to snapshot concepts including:

- event defaults
- ping roles
- organisers
- role-request configuration
- reminders
- publication timing
- signup timing

After generation, the event owns those values.

Changing the template later should normally affect only subsequently generated occurrences.

---

# Template Organisers

Template organiser defaults should become:

```text
ordinary dormant event organiser assignments
```

They should then follow the same organiser activation, escalation, safety, and cover workflow as any manually-created event.

---

# Template Role Requests

Templates should build on the existing reusable role-request preset subsystem rather than inventing a second incompatible reusable role graph.

The exact relationship still needs design work.

Whatever approach is chosen must ultimately produce normal event-level role-request state.

---

# Template Reminders

Reminder defaults should become ordinary:

```text
event_reminders
```

and normal durable scheduled actions for each generated event.

Known future implementation concern:

Generated events may exist in:

```text
scheduled
unpublished
```

state for weeks.

Current signup-close reminder rescheduling/validity behaviour must be reviewed before templates use it so valid future reminders are not incorrectly marked obsolete merely because public signups have not opened yet.

Do not forget this check when template work begins.

---

# Recurrence Direction

Recurring generation should come after one-off template generation is stable.

Current intended model:

```text
recurrence rule
      |
      v
rolling generator
      |
      v
ordinary event occurrences
```

Likely recurrence representation:

```text
RFC 5545 compatible RRULE
```

A rolling generation horizon of roughly several weeks has been discussed, with approximately 21 days as a plausible initial value.

The exact horizon is not yet a fixed product requirement.

---

# Immutable Occurrence Identity

Recurring events must not use mutable `startsAt` as their sole occurrence identity.

A generated occurrence needs an immutable schedule identity so moving one event does not cause the generator to recreate the original slot.

This is a critical future recurrence invariant.

---

# Development Workflow Rules

A fresh development conversation should follow these rules unless explicitly changed.

---

## Read project documentation first

Before substantial work, review:

```text
README.md
docs/ARCHITECTURE.md
docs/DECISIONS.md
docs/ROADMAP.md
docs/CURRENT-WORK.md
docs/TESTING-GUIDE.md
```

Read `ADMIN-GUIDE.md` when working on Discord administrator UX.

---

## Inspect current code before proposing patches

Do not assume an older conversation's line numbers or file contents still match the repository.

Use the current branch.

If local source differs from the public branch, locally supplied code/output is authoritative for the active change.

---

## Provide exact implementation instructions

When giving implementation help, prefer:

- exact file path
- exact insertion/replacement location
- complete pasteable code
- explicit new-file versus replacement instructions
- exact test commands
- expected red or green result
- explicit commit boundary

Avoid vague instructions such as:

```text
add something like this somewhere in the handler
```

when the exact integration point can be determined.

---

## Regression first for bugs

For a bug:

```text
red regression first
then production fix
```

Do not recreate a regression the developer reports is already implemented.

---

## PostgreSQL is authoritative

Do not make Discord messages authoritative state.

---

## External side effects come after authoritative state where appropriate

Discord operations cannot be transactional.

Structure flows so stale Discord success cannot overwrite newer PostgreSQL state.

Re-check after external calls where races matter.

---

## Preserve lock order

Before adding a new transaction that touches several shared rows:

1. inspect neighbouring services
2. determine their lock order
3. use a compatible order
4. add a concurrency regression if the new operation can race

Do not independently invent the reverse order.

---

## Prefer narrow reusable services

Extract domain/application services when they create a real reusable or testable boundary.

Do not refactor into generic frameworks merely to reduce line counts.

---

## Preserve portability

High-value domain behaviour should not depend unnecessarily on:

- Discord interaction objects
- one slash-command layout
- hardcoded regiment role names
- one deployment environment

Portability does not require turning the application into a framework.

---

## Preserve public-repository quality

Code and documentation should remain credible to:

- collaborators
- recruiters
- potential employers
- future maintainers

Do not exaggerate scale, production readiness, or unimplemented functionality.

---

# Full Verification Expectations

For a normal completed feature or reliability PR:

```bash
npm run test:unit
npm run test:integration
npm run test:coverage
npm run typecheck
npm run typecheck:test
```

Also run:

```bash
git diff --check
```

before committing or opening the PR.

Schema work should additionally include migration generation/review and relevant migration-chain tests.

---

# Manual Test Expectations for Upcoming Preset Editing

Manual Discord testing will be warranted once the command surface changes.

Likely scenarios include:

- rename preset
- edit description
- edit inactive preset
- edit role option
- replace qualification roles
- edit group timing
- edit channel behaviour
- edit notification role
- change mappings
- inspect updated preset
- apply edited preset to a fresh event
- confirm existing previously-applied event remains unchanged
- verify invalid edit/application feedback
- verify idempotent edits

Automated service tests should establish the persistence and snapshot guarantees first.

---

# Do Not Regress These Behaviours

A future implementation should stop and investigate if it would violate any of the following.

```text
PostgreSQL state is authoritative.

Publication state is separate from event lifecycle.

Unpublished events are persistent real events.

Cancellation remains final.

Event creator is not implicitly organiser.

Unpublished organiser nominees begin dormant.

Organiser nominee flow yields to the event safety deadline.

Cover may remain claimable after event start while the event is still operational.

Once endsAt has passed, new organiser escalation is obsolete even if completion status has not caught up yet.

Tracked organiser cover/start messages are reconciled when they become obsolete.

A T+0 replacement alert is durably linked before older cover messages are superseded.

Only one organiser assignment may own the event at a time.

Normal organiser operations participate in the guild feature lock.

Role options are event-level.

Role requests are event + user + option.

Several request groups may share one volunteer pool.

Role requests are independent and multi-select.

Repeated request clicks do not withdraw.

Qualification and notification audience are different concepts.

Supervision-required eligibility is deliberate.

Changing attendance does not automatically destroy stored role willingness.

Manual immediate role-request opening remains distinct from relative scheduled opening.

Scheduled work is durable and idempotent.

Stale scheduler workers cannot overwrite newer state.

Administrative rescheduling resets stale retry state.

Deleted-message recovery requires a known destination.

Recovery does not replay normal notification pings.

Unexpected Discord failures are not proof of deletion.

Role-request presets are reusable source configuration.

Preset application creates independent event-level snapshots.

Runtime role requests do not continuously consult their source preset.

Preset application takes the parent shared lock.

Preset mutation takes the parent exclusive lock.

Preset lifecycle changes are non-destructive.

Option deactivation does not silently cascade into group deactivation.
```

---

# Current Public Testing Position

The bot is being developed for real community use and has undergone substantial automated and manual verification.

The current Discord presentation is functional but not considered the final UI.

Near-term effort should continue to prioritise:

- correct behaviour
- reliability
- administrator workflow
- maintainable services
- regression coverage
- portability

over large cosmetic Discord-message redesigns.

---

# Handoff Checklist

A fresh development session should orient itself in this order.

```text
1. Confirm current branch and git status

2. Read:
   README.md
   ARCHITECTURE.md
   DECISIONS.md
   ROADMAP.md
   CURRENT-WORK.md
   TESTING-GUIDE.md

3. Read ADMIN-GUIDE.md for command/admin changes

4. Inspect the exact current source and tests for the target subsystem

5. Treat PostgreSQL and regression tests as behavioural evidence

6. Preserve the decision record unless a newer explicit decision supersedes it

7. Write failing regression first for bugs

8. Build new reusable functionality behind direct service tests

9. Run targeted tests before broader suites

10. Run the full gate before considering work PR-ready

11. Perform a targeted manual Discord smoke test when the real Discord surface changed
```

---

# Immediate Handoff Summary

At this checkpoint:

```text
role-request preset foundation is implemented

preset application is implemented

scheduled preset-derived group opening/closing is implemented

automatic role-group publication respects event publication intent

manual-held events do not leak scheduled role groups

intentional pre-publication role groups remain supported

deferred role-group openings do not consume retry attempts

successful event publication wakes due deferred openings

future role groups remain scheduled normally

role-request publication revalidates after Discord side effects

preset parent lifecycle is implemented

preset option lifecycle is implemented

preset group lifecycle is implemented

message recovery is implemented for core attendance and role-request messages

organiser safety and cover-message reconciliation are implemented

automated unit/integration/coverage/typechecking is green

next production feature:
    edit existing reusable role-request presets
```

Do not resume an older reliability or preset-foundation task simply because an older chat or stale document says it is still pending.

Use the current repository and reconciled documentation as the development baseline.
