# Project Decisions and Domain Invariants

## Purpose

This document records product, architectural, persistence, concurrency, and development decisions that may not be obvious from reading individual source files.

Some current behaviours are deliberately more defensive than a simpler implementation might appear to require.

That complexity often exists because of:

- previously discovered race conditions
- Discord being an external and fallible system
- bot restarts and deployments
- administrator actions racing scheduled work
- requirements for historical clarity
- plans to reuse major subsystems elsewhere
- the need for generated and reusable configuration to remain independently editable

This document exists to prevent a future developer, collaborator, or AI assistant from "simplifying" deliberate behaviour into something incorrect.

When a decision changes:

1. update this document
2. record the new intended invariant
3. update affected automated tests
4. remove or amend superseded implementation assumptions

Source code describes what the application does.

This file records **why important behaviour should continue to work that way**.

---

# How to Read This File

Decisions marked as **current** describe behaviour that should be preserved unless explicitly reconsidered.

Decisions marked as **planned** describe agreed architectural direction that is not yet fully implemented.

A planned decision must not be presented elsewhere as an already-complete feature.

Where current production behaviour is known to be wrong and a regression test exists to demonstrate that problem, the intended invariant takes precedence over the buggy implementation.

---

# Decision Map

This file is chronological within broad topic areas.

Use the following topic map when looking for a particular design concern:

| Area                        | Typical decisions covered                                                        |
| --------------------------- | -------------------------------------------------------------------------------- |
| Core events and persistence | database authority, lifecycle, publication, snapshots                            |
| Organisers                  | assignment ownership, escalation, cover, feature locking, notification behaviour |
| Role requests               | role identity, qualification, groups, scheduling, publication                    |
| Reusable presets            | snapshot semantics, lifecycle, editing, locking, mappings                        |
| Scheduler and reliability   | durable work, retries, recovery, ownership fencing                               |
| Attendance                  | signups, actual attendance, reporting semantics                                  |
| Reminders and announcements | durable reminders, destinations, rescheduling                                    |
| Feature configuration       | server-level feature controls                                                    |
| Testing and development     | regression-first workflow, deterministic races, PR gates                         |
| Templates and recurrence    | generated-event independence, template snapshots, occurrence identity            |
| Integration and portability | public documentation, service boundaries, future external interfaces             |

The [`Summary of Highest-Risk Invariants`](#summary-of-highest-risk-invariants) near the end is the quickest reference before a substantial refactor.

---

# Core Event and Persistence Decisions

## D001 - PostgreSQL is the authoritative source of application state

**Status: Current**

Discord messages are projections of PostgreSQL state.

The application must not rely on the current contents of a Discord message as the authoritative source of:

- event lifecycle
- publication state
- attendance intention
- actual attendance
- organiser state
- role requests
- reusable preset configuration
- scheduled work
- audit history

Where practical, Discord presentation should be rebuildable from database state.

### Reason

Discord messages may be:

- deleted
- manually edited
- temporarily inaccessible
- located in channels which are later removed
- duplicated because two external operations raced
- stale relative to newer database state

Durable application behaviour must survive those conditions.

A visible message is therefore evidence of presentation, not proof of domain state.

---

## D002 - Publication and event lifecycle are separate concepts

**Status: Current**

Do not add a `draft` lifecycle state merely to represent an unpublished event.

Current event lifecycle statuses are:

```text
scheduled
open
closed
cancelled
completed
```

Publication is represented separately, primarily through:

```text
publishedAt
```

Therefore:

```text
status = scheduled
publishedAt = null
```

is valid.

### Reason

An event can be internally scheduled and fully persistent while still being privately prepared.

Publication and lifecycle are independent dimensions.

---

## D003 - Unpublished events are real persistent events

**Status: Current**

An unpublished event is not a temporary command form.

It receives a normal event ID and may already be used for:

- organiser nomination
- event editing
- reminders
- role-option configuration
- role-request planning
- reusable preset application
- scheduled publication
- future template-generated preparation

### Reason

Administrators need stable event identity before members receive a public announcement.

Several later workflows depend on the event already existing before publication.

---

## D004 - Event-specific configuration should be snapshotted where later default changes would be unsafe

**Status: Current**

Mutable guild defaults should not unexpectedly alter already-configured events.

Examples of values that may require event-level snapshots include:

- publication destination
- ping-role identity and readable role name
- organiser nominees
- reminder destinations
- qualification roles
- role-request notification roles
- role-request group channels
- reusable preset configuration

### Reason

Changing a guild default tomorrow should not unexpectedly alter an event that was deliberately configured today.

Snapshots also make historical configuration understandable after Discord entities change.

---

## D005 - Scheduled publication must be durable

**Status: Current**

Automatic event publication uses persistent scheduled actions.

The stable publication action key is:

```text
publish_event
```

Do not implement important future publication behaviour using only an in-memory timer.

### Reason

Publication must survive:

- bot restarts
- deployments
- process crashes
- temporary worker interruption

---

## D006 - Manual publication makes scheduled publication obsolete

**Status: Current**

An administrator may publish a scheduled event early through the manual publication workflow.

Once publication succeeds, an outstanding scheduled publication action must not publish the same event again.

The scheduler must also defensively recognise that the event is already published.

### Reason

Manual and automatic paths may legitimately race.

Database state must make repeat execution harmless.

---

## D007 - Signup-enabled events must be published before signup closure

**Status: Current**

A signup-enabled event must not be configured to publish:

- after signup closure
- at exactly the same instant as signup closure

### Reason

Members need a meaningful opportunity to respond.

Publishing and closing simultaneously also creates an unnecessary race between scheduled actions.

---

## D008 - Publication destination is event-level state

**Status: Current**

The intended publication channel is snapshotted onto the event.

Do not rely only on the guild's current default attendance channel when publication eventually occurs.

### Reason

Changing the guild default should not unexpectedly move an event that has already been prepared or scheduled.

---

## D009 - Event cancellation is final

**Status: Current**

Cancellation is an explicit administrative final state.

Later work must not convert:

```text
cancelled
```

into:

```text
open
closed
completed
```

or otherwise revive normal event processing.

### Reason

A stale scheduled action may have been created before cancellation.

Final administrator intent must dominate old work.

---

## D010 - Automatic completion must not overwrite cancellation

**Status: Current**

An event completion action must re-check the current lifecycle.

A cancelled event must remain cancelled.

### Reason

Completion timing is automation.

Cancellation is explicit administrator intent.

---

## D011 - Scheduled work must become harmless after cancellation

**Status: Current**

When an event is cancelled, related pending work should be cancelled where appropriate.

Executors must also defensively re-check event state.

### Reason

Cancellation and scheduler execution can race.

Relying only on bulk cancellation of scheduled-action rows would leave a gap for already-claimed work.

---

# Organiser Decisions

## D012 - Event creator and event organiser are separate concepts

**Status: Current**

The administrator who creates an event is not automatically its organiser.

The system must preserve separate concepts for:

```text
event creator
primary organiser
backup organiser
cover organiser
```

### Reason

Creating an event is an administrative action.

Operating the event is a separate responsibility.

---

## D013 - Organiser nominees for unpublished events begin dormant

**Status: Current**

Assigning primary or backup organisers before publication must not immediately start their response countdown.

A dormant assignment normally has:

```text
activatedAt = null
responseDeadlineAt = null
```

### Reason

Private event preparation time should not consume the organiser's operational response window.

---

## D014 - Normal organiser activation begins around publication

**Status: Current, refined by safety-deadline decisions below**

For a normally-timed event, publication activates the current primary nominee.

Activation establishes:

- activation time
- response deadline
- warning work where applicable
- timeout work
- organiser notification

### Reason

Operational responsibility normally begins when the event becomes public.

### Important refinement

This is not an unconditional rule for very late publication.

If the event has already reached its organiser safety deadline, publication must not revive an obsolete full nominee response window.

See D022 and D023.

---

## D015 - Organiser escalation uses one coherent ownership workflow

**Status: Current**

The normal organiser progression is:

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

Future "confirmed organiser becomes unavailable" behaviour should feed into the same ownership and escalation infrastructure.

Do not build a parallel replacement mechanism without a deliberate product decision.

---

## D016 - Organiser assignment history should be preserved

**Status: Current**

Normal organiser changes should not destructively overwrite historical assignments.

Assignment records retain states such as:

```text
pending
confirmed
declined
timed_out
replaced
removed
```

Current ownership is represented separately.

### Reason

Historical assignment state is useful for:

- debugging
- auditing
- understanding escalation
- future reporting

It also prevents one mutable row from carrying incompatible meanings over time.

---

## D017 - Only one organiser assignment should be current at a time

**Status: Current**

The organiser workflow must not produce multiple simultaneous authoritative current organisers for one event.

This applies across:

- primary
- backup
- cover
- replacement
- concurrent claims
- timeout races

### Reason

Organiser escalation represents ownership transfer.

Multiple current owners would make later transitions ambiguous.

---

## D018 - Organiser confirmation and timeout races are resolved by PostgreSQL

**Status: Current**

A confirmation or decline interaction and a scheduled timeout may race.

The database transition decides which state becomes authoritative.

Discord response timing must not decide ownership.

### Reason

Both operations may have started from valid stale reads.

The authoritative row must be re-checked or locked at the transition boundary.

---

## D019 - Organiser warning and cover presentation must be reconciled after resolution

**Status: Current**

Organiser warning messages and claimable organiser-cover messages are Discord projections of authoritative organiser state.

They must not remain misleading or actionable after the underlying organiser situation has resolved.

Pending organiser warnings retain their Discord location on the assignment so they can be reconciled after states including:

- confirmed
- declined
- timed out
- replaced
- removed
- event cancelled
- event completed

General-cover and missing-organiser-at-start messages are tracked separately through `event_messages` using message kinds including:

```text
organiser_cover
organiser_missing_at_start
```

Tracked organiser-cover presentation records retain their Discord channel/message linkage and a resolution timestamp.

Outstanding cover presentation is reconciled when appropriate after:

- cover is claimed
- an active organiser assignment supersedes cover
- the event-start alert supersedes an earlier general-cover message
- organisers are disabled
- the event is cancelled
- the event completes

When the event-start alert supersedes an earlier general-cover message, the older message must not be retired until the new T+0 alert has been successfully sent and durably linked.

### Reason

A visible Discord button which is no longer valid is operationally misleading even when the authoritative interaction handler would eventually reject it.

Presentation should follow authoritative state.

Tracking the exact Discord messages also allows several historical cover requests for one event to be reconciled instead of leaving stale Claim Event controls scattered through the administration channel.

---

## D020 - Missing organiser presentation must not roll back authoritative state

**Status: Current**

If an organiser warning, general-cover message, missing-at-start message, or its Discord channel has disappeared, authoritative organiser state remains valid.

Known deleted-message or deleted-channel conditions are presentation failures.

For tracked organiser-cover presentation, a definitively missing Discord message or channel may be marked resolved and deleted in `event_messages`.

Unexpected Discord failures must not be silently reclassified as deletion.

Where organiser ownership, cancellation, completion, or another domain transition has already committed successfully, later Discord reconciliation failure must not roll that transition back.

### Reason

Discord presentation is external and fallible.

A missing or temporarily inaccessible message cannot be allowed to undo a valid PostgreSQL transition.

Likewise, an unexpected Discord outage should remain distinguishable from a message that is known to have been deleted.

---

## D021 - Organiser automation is controlled by server-level runtime settings

**Status: Current, superseding the older planned-only flag design**

The current server-level organiser controls include:

```text
organisersEnabled
organiserDmsEnabled
```

`organisersEnabled` controls the organiser subsystem as a whole.

`organiserDmsEnabled` controls notification delivery preference.

When DM-first delivery is enabled:

```text
try DM
then use Event Administration channel as fallback
```

When disabled:

```text
skip DM
use Event Administration channel directly
```

Assigning organisers remains optional per event.

### Future possibility

A separate switch for automatic escalation may still be considered later if a concrete requirement arises.

It is not currently a distinct implemented feature flag.

---

## D022 - Normal nominee response windows must yield to an event-level organiser safety deadline

**Status: Current**

The organiser workflow must not keep waiting for primary or backup responses so late that general cover has no useful time to operate.

Each relevant event therefore has a safety deadline based on:

```text
event start - organiserCoverBeforeStartMinutes
```

At the safety deadline, if no organiser has confirmed:

- unresolved nominee ownership is retired
- obsolete nominee warning and timeout work becomes irrelevant
- general cover becomes the authoritative path

### Reason

Per-assignment response windows and event operational urgency solve different problems.

The event start must ultimately dominate nominee convenience.

---

## D023 - Late publication must not revive an obsolete organiser response window

**Status: Current**

If an event is published after its organiser safety deadline, the system must not blindly activate the dormant primary nominee with a fresh normal response period.

The event's current timing is authoritative.

Late publication should transition directly into the appropriate cover or near-start safety behaviour.

### Reason

A full primary response window that extends beyond the event start is operationally meaningless.

---

## D024 - Missing organiser at event start is a separate escalation condition

**Status: Current**

The general-cover safety deadline and the event-start missing-organiser check are distinct.

Conceptually:

```text
T - safety lead
    -> stop waiting for nominees
    -> ensure general cover path is active

T + 0
    -> if still unresolved, issue urgent missing-organiser handling
```

The stable event-level action keys include:

```text
organiser_cover_deadline:<eventId>
organiser_missing_at_start:<eventId>
```

### Reason

"Start looking for cover" and "the event is beginning without an organiser" are different operational conditions.

---

## D025 - Organiser escalation may continue after event start but ends at the event's operational end

**Status: Current, superseding the older blanket post-start rejection**

Passing the event start timestamp does not automatically invalidate organiser escalation or a general-cover claim.

If:

- the event has started but has not ended
- organisers remain enabled
- the event still has no valid organiser
- general cover remains the authoritative path
- the claimant is otherwise eligible

then cover may still be claimed after start.

The event's absolute end time is different.

Once:

```text
endsAt <= now;
```

new organiser operational work is obsolete.

This applies even if the persisted lifecycle still temporarily says:

```text
open
```

or:

```text
closed
```

because an overdue `complete_event` action has not yet caught up after downtime.

After the event end, organiser warning, timeout, safety-deadline, missing-at-start, cover-eligibility, and cover-claim paths must not create fresh operational escalation.

### Reason

Finding an organiser after an event begins can still be useful.

Finding one after the event has already finished is not.

Using `endsAt` as an independent operational boundary also prevents scheduler catch-up order after downtime from producing stale organiser messages before the later completion action has had a chance to update lifecycle status.

---

## D026 - Event-time edits must reschedule organiser safety work

**Status: Current**

Changing an event's start time must update relevant event-level organiser safety actions.

The safety executor must also re-evaluate the current deadline when it runs.

### Reason

A scheduler worker may already have claimed an action using an older start time.

The old due time must not become permission to retire organiser ownership under a newer event schedule.

---

## D027 - Organiser feature disable must serialise against normal organiser operations

**Status: Current**

Normal organiser operations participate in a shared lock on the guild settings row.

Conceptually:

```text
normal organiser operation
    -> guild_settings FOR SHARE

disable organisers
    -> guild_settings FOR UPDATE
```

### Reason

A feature switch is not safe if an in-flight operation can read "enabled", wait, then successfully mutate organiser state after the administrator has disabled the subsystem.

The lock contract gives a deterministic winner.

---

## D028 - Confirmed-organiser unavailability should reuse existing escalation infrastructure

**Status: Planned**

A complete self-service workflow for a confirmed organiser becoming unavailable is not yet implemented.

When added, it should conceptually feed into:

```text
confirmed organiser unavailable
        |
        +---- viable backup
        |
        +---- otherwise general cover
```

### Reason

The existing assignment, escalation, and cover model already represents organiser ownership.

A separate emergency replacement model would duplicate state and race rules.

---

# Role-Request Decisions

## D029 - Logical role options belong to events, not request messages

**Status: Current**

A role such as:

```text
Captain
```

exists once as an event-level logical role option.

Discord request groups reference that option.

Do not create separate role identities merely because the same role appears in several Discord messages.

---

## D030 - Role-request groups are presentation and workflow containers

**Status: Current**

A request group controls where and how event roles are exposed.

It does not own the underlying role request.

This permits:

```text
Early private Captain request
+
Later public Captain request
```

to share one Captain volunteer pool.

---

## D031 - Role requests use a shared event-level volunteer pool

**Status: Current**

A member request is logically identified by:

```text
event
+ user
+ role option
```

not by:

```text
event
+ request group
+ user
+ role option
```

The group may be retained as provenance, but it does not create an independent pool.

### Reason

The same logical role can be exposed through different audiences or phases without splitting volunteer intent.

---

## D032 - Role requests are independent and multi-select

**Status: Current**

Members may express willingness for several roles simultaneously.

Do not restore a ranked-preference model without an explicit product decision.

The current domain does not mean:

```text
first preference
second preference
third preference
```

It means independent willingness for each selected role.

---

## D033 - A role request is not an allocation

**Status: Current**

Requesting a role records willingness.

It does not guarantee that the member will receive that role.

Final allocation remains a human organiser decision.

### Reason

Capacity, team balance, supervision, operational needs, and organiser judgement may all affect assignment.

User-facing wording should preserve this distinction.

---

## D034 - Role-request buttons are not toggles

**Status: Current**

Clicking an already-requested role should not withdraw it.

Current behaviour is:

```text
first click
    -> add request

repeated click
    -> keep request
    -> explain that it already exists
```

Withdrawal is explicit.

### Reason

A repeat click should not accidentally destroy a request or its queue position.

---

## D035 - Withdraw and re-request creates a new request position

**Status: Current**

If a member withdraws a role request and later submits it again:

- the old request remains removed
- a new request is created
- the new creation time becomes its request time

The member therefore returns to the later request position.

---

## D036 - Request order is useful context, not automatic selection

**Status: Current**

Role requests may be displayed in creation order.

However:

```text
requested first
```

does not mean:

```text
must receive the role
```

Organisers retain discretion.

---

## D037 - Qualification and notification audience are separate concepts

**Status: Current**

Do not use notification targeting as a substitute for eligibility.

Example:

```text
Who may request Captain?
    -> qualification rules

Who should be informed that this request group opened?
    -> notification roles
```

These must remain independently configurable.

---

## D038 - Qualification supports fully-qualified and supervision-required states

**Status: Current**

The qualification model includes:

```text
qualified
supervision_required
unqualified
```

A supervision-required member may still express interest in a `qualified_only` role.

The organiser must be able to see that supervision is required.

### Reason

Eligibility is not always binary.

Some communities deliberately allow developing members to perform specialised roles under supervision.

---

## D039 - Qualification rules must be configurable rather than hardcoded around regiment role names

**Status: Current**

Names such as:

```text
Flag Captain
Midshipman
```

are examples of one community's Discord roles.

Business logic should use stored Discord role IDs, snapshots, and qualification levels rather than hardcoded community-specific role names.

### Reason

This preserves configurability and portability.

---

## D040 - Discord roles indicate current qualification, not immutable historical truth

**Status: Current**

Eligibility is generally evaluated against a member's current Discord roles.

Role-name snapshots exist so stored configuration remains understandable if a Discord role is later renamed or deleted.

A role membership should not automatically be treated as permanent historical fact.

---

## D041 - Signup gating is configured per request group

**Status: Current**

A role-request group may require the member to currently be:

```text
Attending
or
Tentative
```

before adding a new request.

Other groups may deliberately allow requests without a signup.

### Reason

Early or private planning may occur before public attendance signups exist.

---

## D042 - Role willingness and current attendance availability are separate

**Status: Current**

A role request records willingness.

Attendance can determine whether that willingness is currently actionable.

Current intended semantics include:

```text
Attending
    -> available

Tentative
    -> available but uncertain

Not Attending
    -> request retained
    -> unavailable

No signup
    -> may remain usable where that group permits it
```

Changing to Not Attending should not automatically delete the request.

Returning to an eligible attendance state should restore availability without resetting the original request timestamp.

---

## D043 - Do not enumerate the entire guild as fallback volunteers

**Status: Current**

Organiser-facing role-request views may suggest potentially suitable people.

Fallback candidates should normally be restricted to relevant members such as those who:

- are Attending or Tentative
- meet qualification rules
- have not already requested the role

For early or no-signup request groups, do not enumerate an entire large guild merely because many members hold a qualification role.

### Reason

The role-request system records volunteered willingness.

It should not casually turn qualification membership into an unsolicited candidate list.

---

## D044 - Role-request groups may remain open after event start

**Status: Current**

Some request workflows legitimately continue after the event begins.

Signed offsets use:

```text
positive value = minutes before start
zero           = event start
negative value = minutes after start
```

User-facing commands should expose explicit before-start and after-start options rather than requiring administrators to enter negative numbers.

---

## D045 - Manual immediate opening and event-relative opening are different states

**Status: Current**

For event-level request groups:

```text
openMinutesBeforeStart = number
```

means the opening is relative to event start.

```text
openMinutesBeforeStart = null
```

means there is no event-relative opening rule.

The main current example is a manually-posted group that opens immediately.

### Reason

When event start changes, a manually-opened message should not suddenly gain a synthetic future opening schedule.

---

## D046 - Event-time edits must reschedule only still-relevant role-request work

**Status: Current**

When event start changes:

```text
unposted group with relative opening rule
    -> recalculate opensAt
    -> reschedule opening action

all still-unclosed groups
    -> recalculate closesAt
    -> reschedule closing action

already-posted group
    -> preserve historical opening
    -> move closing only

manual immediate group
    -> preserve opening
    -> move closing only

closed group
    -> do not revive
```

### Reason

Editing an event time changes future scheduling.

It must not rewrite historical facts or resurrect completed group lifecycle.

---

## D047 - A role-request group is not "open" until its usable Discord presentation exists

**Status: Current**

Administrator-facing group lifecycle distinguishes:

```text
Planned
Pending publication
Open
Closed
```

An opening deadline arriving does not itself prove that members can use the group.

If:

```text
opensAt <= now
messageId = null
```

the group is pending publication rather than open.

Pending publication can represent several situations, including:

- Discord publication is delayed or temporarily unavailable
- the parent event is deliberately being held for manual publication
- the parent event's scheduled publication time has arrived but event publication has not yet succeeded

A role-request group becomes operationally open only after its usable Discord presentation has been successfully created and authoritatively linked.

### Reason

The stored opening schedule and the external Discord presentation are separate concerns.

A due timestamp cannot prove that members actually have a request surface.

The same lifecycle representation can therefore remain accurate whether publication is waiting on Discord or deliberately waiting on the parent event.

---

## D048 - Automatic role-request publication must respect event publication intent

**Status: Current**

Scheduled role-request groups must not expose parts of an event contrary to the administrator's event-publication intent.

Current automatic publication rules are:

```text
event already published
    -> due role-request group may publish normally

event unpublished
manual publication required
publishMinutesBeforeStart = null
    -> automatic role-request publication waits

event unpublished
future scheduled publication still pending
    -> a deliberately earlier role-request group may publish

event unpublished
scheduled publication time already reached or passed
but event publication has not succeeded
    -> later automatic role-request publication waits
```

This allows workflows such as:

```text
early command requests: T - 120

main event publication: T - 60

main role requests: T - 45
```

where the early command group intentionally appears before the main event.

It prevents this:

```text
event held for manual publication

role-request opening arrives

role-request group leaks into Discord anyway
```

and also prevents later role groups from appearing independently when scheduled event publication is overdue or has failed.

Waiting for the parent event is represented as a normal domain outcome:

```text
awaiting-event-publication
```

It is not treated as a Discord delivery failure.

The scheduler therefore parks the opening action at the group's closing boundary without consuming the retry budget.

If event publication succeeds while the group window is still valid:

```text
opensAt <= publishedAt < closesAt
```

the event-publication transaction wakes the due opening action immediately.

Future groups keep their existing opening schedule.

If the event never publishes, the parked opening eventually reaches the group's closing boundary and becomes obsolete without being exposed.

Publication intent is also re-checked after Discord side effects.

If the event changes to manual publication while a Discord group message is being sent, the stale candidate must not become authoritative and should be deleted where possible.

Explicit administrator use of:

```text
/event role-group-post
```

remains an immediate manual action and is not the same workflow as automatic scheduled opening.

### Reason

An unpublished event may represent either:

```text
a deliberately scheduled future announcement
```

or:

```text
an event intentionally held for manual release
```

Those states should not have identical automatic publication behaviour.

Deriving the rule from event publication intent avoids adding another per-group setting while preserving useful early/private request workflows.

Deferral must also remain durable and restart-safe without wasting scheduler retry attempts on a condition that is not an error.

---

## D049 - Role-request notification failures should degrade safely per role

**Status: Current**

A request group may have zero or more optional notification roles.

For each configured notification role independently:

- a missing role may be skipped
- an unmentionable role may be skipped if permissions do not allow it
- `@everyone` is not treated as a normal role-notification choice
- failure to deliver one role ping does not suppress other usable configured roles

The request group may still publish even when one or more optional notification pings cannot be delivered.

### Reason

Notification delivery and existence of the request surface are separate concerns.

Treating the notification collection per-role also prevents one stale Discord role from suppressing valid notifications to unrelated audiences.

---

# Attendance Decisions

## D050 - Signup intention and actual attendance are separate datasets

**Status: Current**

Do not overwrite signup responses based on actual attendance.

Do not infer actual attendance merely because somebody signed up.

Both are useful:

```text
signup
    -> stated intention

actual attendance
    -> observed outcome
```

---

## D051 - Attendance discrepancy reports are informational

**Status: Current**

The bot should not automatically punish users based on:

- no-shows
- walk-ins
- Not Attending discrepancies
- Tentative outcomes
- attendance history
- reliability summaries

Reports exist to support human judgement.

### Reason

Real event participation has context that a simple attendance table cannot always capture.

---

## D052 - No-signup events are a first-class event mode

**Status: Current**

An event may operate with signups disabled.

A no-signup event may still use:

- publication
- organisers
- reminders
- role requests
- actual attendance

It must not generate signup reliability conclusions because no signup obligation existed.

---

## D053 - No-signup events do not create signup discrepancy evidence

**Status: Current**

Actual attendance may still be recorded for a no-signup event.

However, that event must not produce normal:

- no-show discrepancies
- walk-in discrepancies
- signup reliability statistics

### Reason

There was no attendance-intention workflow against which to compare actual participation.

---

## D054 - Non-playing attendance should eventually be distinguishable

**Status: Planned**

Future actual-attendance records should support event-specific participation context.

Initial candidate categories include:

```text
participant
supervisor
organiser
server_admin
other
```

### Reason

Someone may legitimately be present without acting as a normal participant.

A supervisor or administrator should not automatically be reported as a signup walk-in.

---

## D055 - Discord roles may suggest participation context but are not authoritative

**Status: Planned direction**

A member holding an officer or administrator Discord role does not prove that they performed that role during a particular event.

Future participation context belongs on the event attendance record.

Discord roles may provide:

- suggestions
- defaults
- validation hints

They must not become historical truth.

---

# Durable Scheduler Decisions

## D056 - Important future work belongs in the persistent scheduler

**Status: Current**

Durable operations should use PostgreSQL-backed scheduled actions.

Do not implement important workflows using only:

```ts
setTimeout(...)
```

Short-lived UI refresh or debounce timers remain acceptable when losing the timer on restart cannot change authoritative state.

---

## D057 - Scheduled actions should be idempotent where practical

**Status: Current**

Execution must defensively handle cases where:

- an administrator already performed the action
- another worker won a race
- the event was cancelled
- the event was completed
- the target was removed
- the target state was already reached
- the schedule was changed after the action was created

Scheduling helpers should normally reschedule an existing stable logical action rather than create uncontrolled duplicates.

---

## D058 - A scheduled action is permission to re-evaluate, not permission to ignore current state

**Status: Current**

When an action becomes due, the executor must re-check current authoritative state.

Examples:

```text
publish event
    -> may already be published

organiser timeout
    -> organiser may already have responded

organiser cover deadline
    -> event start may have moved
    -> organiser may already be confirmed

role group opening
    -> group may already be posted
    -> opening may have moved
    -> window may have expired
    -> event may be held for manual publication
    -> scheduled event publication may be overdue

role group closing
    -> group may already be closed
```

### Reason

Scheduled rows are created from earlier information.

Domain state may change before execution.

---

## D059 - Scheduler claims must be conditional and bounded

**Status: Current**

A worker must successfully claim a pending due action before executing it.

The claim boundary also enforces the maximum attempt count.

No worker should execute an impermissible extra attempt merely because stale persisted state looked claimable in an earlier read.

---

## D060 - Scheduler retries use bounded backoff

**Status: Current**

Unexpected scheduled-action failures use increasing retry delay.

The current progression begins:

```text
attempt 1 -> 1 minute
attempt 2 -> 2 minutes
attempt 3 -> 4 minutes
attempt 4 -> 8 minutes
attempt 5 -> terminal failure
```

The exact values are implementation policy rather than public API.

The invariant is:

```text
bounded
increasing
persistent
```

---

## D061 - Stale processing locks may be recovered only while attempts remain

**Status: Current**

If a process stops after claiming a scheduled action, a stale `processing` row can be recovered.

If another attempt remains:

```text
processing
    -> pending
```

If the maximum attempt count has already been consumed:

```text
processing
    -> failed
```

### Reason

Recovery must not accidentally create attempt six when the policy permits only five.

---

## D062 - Stale workers must be fenced from completing newer scheduler state

**Status: Current**

A worker may:

1. claim an action
2. stall
3. lose ownership through stale recovery or authoritative rescheduling
4. later resume

That old worker must not mark the newer state completed.

Completion and retry updates therefore depend on the worker still owning the claimed attempt.

### Reason

Process scheduling and external API calls can pause execution for arbitrary periods.

Ownership must be represented in persistent state rather than assumed from call order.

---

## D063 - Administrative rescheduling is not a retry failure

**Status: Current**

When an administrator changes event timing and a logical scheduled action is rescheduled, stale retry metadata should be reset.

Relevant fields normally return to states equivalent to:

```text
status = pending
attemptCount = 0
lockedAt = null
completedAt = null
lastError = null
```

### Reason

A new authoritative due time is not another failed delivery attempt.

Carrying old failure count into a deliberately rescheduled action could cause premature terminal failure.

---

## D064 - Stable scheduled-action keys represent logical work

**Status: Current**

Where one event should have one logical action of a given kind, use a stable key.

Examples include:

```text
publish_event
close_attendance
complete_event

event_reminder:<reminderId>

organiser_warning:<assignmentId>
organiser_timeout:<assignmentId>
organiser_cover_deadline:<eventId>
organiser_missing_at_start:<eventId>

role_request_group_open:<groupId>
role_request_group_close:<groupId>
```

### Reason

Stable keys enable:

- idempotent scheduling
- deterministic cancellation
- authoritative rescheduling
- race-safe replacement
- clearer audit and debugging

---

# Discord Presentation and Recovery Decisions

## D065 - Known Discord deletion errors must be distinguished from unexpected failures

**Status: Current**

Automatic recovery should be triggered only when Discord explicitly reports a known missing-resource condition such as an unknown message.

Do not treat every fetch error as proof that the message was deleted.

### Reason

A timeout, network failure, or service error could otherwise create unnecessary duplicate messages.

---

## D066 - Message recovery requires an unambiguous authoritative destination

**Status: Current**

Deleted-message recovery is appropriate only when the database still identifies where the replacement belongs.

If the destination channel itself has disappeared, the bot must not guess a different channel merely because a guild default exists.

### Reason

Changing presentation destination is an administrative choice.

Recovery should restore lost presentation, not redesign configuration.

---

## D067 - Recovery must not replay normal notification pings

**Status: Current**

Rebuilding an attendance or role-request message after deletion must suppress ordinary role notifications.

### Reason

Recovery is repairing presentation.

It is not a new event announcement or a newly-opened request group.

Repeatedly notifying members because a message was deleted would be disruptive.

---

## D068 - Concurrent message recovery must leave one authoritative linkage

**Status: Current**

Two recovery operations may both send candidate replacement messages.

Only one may become authoritative in PostgreSQL.

A losing replacement should be deleted where practical.

### Reason

Discord message creation cannot be made transactional with PostgreSQL.

Conditional linkage and cleanup provide the nearest safe equivalent.

---

## D069 - Unexpected Discord errors should propagate when durable retry can help

**Status: Current**

Do not broadly catch Discord exceptions and convert them all into harmless no-ops.

Where an unexpected error represents a potentially transient failure and the operation has a scheduler retry boundary, allow that failure to reach the retry mechanism.

### Reason

Suppressing unexpected failures destroys observability and prevents durable recovery.

---

## D070 - Public Discord UI may evolve without changing domain semantics

**Status: Current**

Current event messages and command layouts are functional interfaces, not immutable domain architecture.

Future Discord component or command redesign should not require rewriting:

- event lifecycle
- attendance records
- organiser state
- role requests
- reusable presets
- scheduler semantics

### Reason

Rendering and interaction layout should remain downstream from persistent domain state.

---

# Reusable Role-Request Preset Decisions

## D071 - Presets are reusable source configuration, not live runtime policy

**Status: Current**

A role-request preset describes reusable guild-level configuration.

It is not intended to remain a live dependency after being applied to an event.

Conceptually:

```text
preset
   |
   | snapshot
   v
event-level configuration
```

Runtime role-request behaviour then reads the event-level rows.

---

## D072 - Preset application uses snapshot semantics

**Status: Current**

Applying a preset copies relevant active configuration into ordinary event-level state, including:

- role options
- qualification-role snapshots
- request groups
- group mappings
- resolved channels
- ordered notification-role collection snapshots
- signup rules
- opening rules
- closing rules

Later preset changes must not alter the already-applied event.

### Reason

Each event must remain independently editable and historically understandable.

Reusable defaults should not become hidden live configuration inheritance.

---

## D073 - Preset application records provenance without creating a live dependency

**Status: Current**

Event-level role options and groups may retain source preset IDs.

Application is also recorded through:

```text
event_role_request_preset_applications
```

These references provide:

- provenance
- idempotency
- debugging context

They do not mean the event should continuously read the source preset.

---

## D074 - Applying the same preset to the same event is idempotently rejected

**Status: Current**

The application identity is:

```text
event + preset
```

A repeated application must not duplicate the same preset snapshot.

The application record is checked before treating already-created logical option keys as an unrelated conflict.

### Reason

An administrator retry should produce an understandable "already applied" outcome rather than partial duplication.

---

## D075 - Preset application is atomic with creation of its durable role-request work

**Status: Current**

Preset application creates event-level configuration and required role-request opening and closing actions inside the same authoritative transaction.

If the transaction fails, neither the operational snapshot nor its future scheduled work should survive partially.

### Reason

A preset-derived request group without its scheduled opening or closing behaviour would be an incomplete application.

---

## D076 - Preset application and preset mutation serialise through the preset parent

**Status: Current**

Preset application takes:

```text
role_request_presets FOR SHARE
```

Compliant preset mutation takes:

```text
role_request_presets FOR UPDATE
```

### Reason

A preset is a small configuration graph containing:

- parent metadata
- options
- qualification roles
- groups
- option mappings

Application must see either the complete graph before an administrative edit or the complete graph after it.

It must not observe half of a mutation.

Future preset-edit operations must participate in this contract.

---

## D077 - Preset group `channelId = null` means resolve the guild default at application time

**Status: Current**

A preset request group may store:

```text
channelId = null
```

This deliberately means:

```text
resolve guild default role-request channel when applying the preset
```

It does not mean:

```text
follow the guild default forever
```

After application, the actual resolved channel is stored on the event-level group.

### Reason

A reusable preset can remain portable across changing guild defaults while each created event remains stable.

---

## D078 - Preset parent, option, and group active states are independent

**Status: Current**

Lifecycle controls are non-destructive and do not cascade automatically.

Deactivating a preset does not deactivate its child rows.

Reactivating the preset does not reset child states.

Deactivating an option does not automatically deactivate groups.

Deactivating a group does not deactivate its mapped options.

### Reason

These are independent administrator choices.

Hidden cascading state changes would make reactivation and inspection difficult to reason about.

---

## D079 - Preset lifecycle changes affect only future applications

**Status: Current**

Deactivating or reactivating:

- a preset
- a preset option
- a preset group

must not alter existing event-level snapshots.

### Reason

Applied events own their configuration after snapshotting.

---

## D080 - Deactivating a preset option preserves qualification rows and group mappings

**Status: Current**

An inactive option is excluded from future snapshots.

Its stored configuration remains intact.

### Reason

The administrator may later reactivate it.

Deleting or rewriting the surrounding graph would turn a reversible lifecycle operation into a destructive edit.

---

## D081 - Deactivating a preset group preserves its mappings and configuration

**Status: Current**

An inactive group is excluded from future application.

Its option mappings and other reusable configuration remain stored.

Reactivation restores the same definition.

---

## D082 - Preset option deactivation may temporarily produce an invalid active graph

**Status: Current**

If an administrator deactivates the last active option mapped into an active group, the lifecycle operation does not automatically deactivate that group.

Instead:

- the option deactivation succeeds
- affected active groups are reported to the caller
- the Discord command warns the administrator
- preset application rejects the unusable graph until it is repaired

### Reason

The application should not make unrelated administrative choices automatically.

Intermediate configuration may temporarily be incomplete while an administrator is editing it.

---

## D083 - Preset application remains the final authoritative graph validator

**Status: Current**

Command-layer validation may improve administrator feedback.

It does not replace authoritative validation inside preset application.

Application must independently validate matters including:

- active preset state
- active options
- active groups
- qualification consistency
- group mappings
- role-option key conflicts
- signup requirements
- channel resolution
- opening and closing windows

### Reason

Configuration may change between inspection and application.

Only the transactional application boundary can make the final race-safe decision.

---

## D084 - Inactive presets remain editable

**Status: Current**

Preset inactivity controls whether the preset is available for application.

It does not mean the reusable definition becomes immutable.

### Reason

Administrators need to be able to prepare or repair configuration while keeping it unavailable for new events.

---

## D085 - Editing existing preset definitions must preserve snapshot semantics

**Status: Current**

Preset-edit functionality alters the reusable source only.

Already-applied events must not be rewritten automatically.

Preset mutations use the parent-row mutation lock described in D076.

This invariant is currently implemented for:

- preset metadata editing
- preset role-option definition editing
- preset qualification-role replacement

Future request-group and mapping edits must preserve the same behaviour.

### Reason

Editing reusable defaults must not turn into hidden propagation across existing events.

---

# Reminder and Announcement Decisions

## D086 - Persistent reminders and immediate announcements are separate concepts

**Status: Current**

An immediate announcement is sent now.

A persistent reminder represents future durable work.

Neither should be confused with the event's main publication state.

---

## D087 - Reminder destinations are snapshotted

**Status: Current**

A reminder stores the resolved destination channel.

It should not blindly follow a later change to the guild default.

### Reason

The administrator configured a specific future message for an existing event.

---

## D088 - Pending reminders should follow relevant event timing edits

**Status: Current**

A pending event-start-relative reminder should move when event start changes.

A pending signup-close-relative reminder should move when signup close changes.

Already-sent reminders must not be recreated as though unsent.

---

## D089 - Obsolete reminders may be marked missed instead of delivered late

**Status: Current**

If a reminder's meaning is no longer valid, the scheduler should not send it merely because its action remained due.

Example:

```text
"Signups close in 10 minutes"
```

should not be delivered after signups have already closed.

### Reason

Durability should preserve intended behaviour, not mechanically produce stale messages.

---

# Feature Configuration Decisions

## D090 - Runtime feature controls are preferred over dynamically changing slash-command registration

**Status: Current direction**

Feature-specific commands may remain registered and return a clear disabled or unavailable response.

This is generally preferred over constantly registering and unregistering command definitions per guild.

### Reason

A stable command surface is easier to:

- understand
- document
- test
- deploy

Runtime state belongs in persistent configuration.

---

## D091 - Role requests are currently controlled at event-type and event configuration level

**Status: Current, refined from earlier broader flag plans**

The schema currently supports:

```text
event type roleRequestsEnabled
```

and an event must also have relevant role-request configuration.

A future guild-level parent feature switch may still be introduced if required.

It is not currently safe to document a generic guild-wide `roleRequestsEnabled` switch as implemented.

---

## D092 - Event subtypes are not currently a separate domain model

**Status: Current**

Do not introduce an `event_subtypes` table merely to distinguish configuration variants such as:

```text
Regular Naval
Internal Naval
Competitive Naval
```

without a concrete requirement.

Reusable presets and future templates can represent many configuration variants without inventing another classification hierarchy.

---

# Audit Decisions

## D093 - PostgreSQL audit logs are authoritative

**Status: Current**

Discord audit-channel messages are convenience mirrors.

Disabling or losing Discord log mirroring must not disable the database audit trail.

### Reason

Discord logging is presentation.

Audit history is persistent application data.

---

## D094 - Idempotent no-op administration should not be misrepresented as a mutation

**Status: Current**

When an administrative lifecycle command asks for a state that already exists, the operation should return an explicit unchanged result.

It should not be recorded as though a state mutation occurred.

### Reason

Audit history should distinguish:

```text
changed state
```

from:

```text
requested existing state
```

where practical.

---

# Time and Historical Snapshot Decisions

## D095 - Time input must be timezone-aware

**Status: Current**

Use IANA timezone identifiers such as:

```text
Europe/London
America/New_York
```

Persist absolute timestamps while retaining event timezone for later display and editing.

Ambiguous or invalid local times around daylight-saving transitions should be rejected rather than guessed.

---

## D096 - Historical human-readable snapshots are useful

**Status: Current**

Where Discord entities may later be renamed or disappear, retain useful display snapshots where practical.

Examples include:

```text
roleNameSnapshot
displayNameSnapshot
```

The Discord snowflake remains identity where applicable.

The snapshot provides readable historical context.

---

# Migration and Schema Decisions

## D097 - Applied migrations are implementation history

**Status: Current**

Once a migration may have been applied outside disposable local development, later schema changes should normally use a new migration.

Do not casually rewrite applied migration history.

### Reason

Different environments may already depend on that sequence.

---

## D098 - Migrations are not a portability contract

**Status: Current**

If functionality moves into another bot:

1. inspect the destination schema
2. map guild identity
3. map user identity
4. map event identity
5. map lifecycle semantics
6. map scheduling
7. map organiser and attendance concepts
8. adapt the domain or service layer
9. write destination-specific migrations

Do not blindly copy this project's migration directory into another application.

---

## D099 - Explicit database constraint names should be used when generated names risk PostgreSQL truncation collisions

**Status: Current**

PostgreSQL identifiers are limited to 63 bytes.

Long automatically-generated names for composite keys or constraints may truncate into identical identifiers.

Use concise explicit names when necessary.

### Reason

Two distinct logical constraints can otherwise become the same PostgreSQL identifier during migration.

This previously caused a real migration-generation problem in the preset schema work.

---

# Portability and Code-Structure Decisions

## D100 - Portability is a real project requirement

**Status: Current**

Some functionality may eventually move into another community bot or become accessible through another interface.

The code should increasingly separate:

```text
Discord command parsing
domain and application logic
database persistence
Discord rendering and notification
durable scheduling
```

High-value functionality should not require copying the complete `/event` command implementation.

---

## D101 - Reusable domain services are preferred where a real boundary exists

**Status: Current**

Examples of useful extracted service boundaries include:

- event creation
- event publication
- organiser assignment
- organiser response
- organiser escalation
- organiser cover
- organiser safety handling
- role-request preset application
- preset administration
- role-request group publication

### Reason

These boundaries improve:

- direct integration testing
- reuse
- portability
- concurrency reasoning
- command-handler size

---

## D102 - Avoid speculative abstraction

**Status: Current**

Do not introduce generic repositories, dependency injection layers, interface hierarchies, or framework-style abstractions merely because they might theoretically help a future integration.

Prefer concrete improvements that solve known problems.

### Reason

The project needs modularity, not ceremonial architecture.

---

## D103 - Incremental refactoring is preferred over wholesale rewrites

**Status: Current**

Refactoring should target concrete benefits such as:

- better testability
- reduced duplication
- improved portability
- safer lifecycle behaviour
- clearer domain boundaries
- smaller command adapters
- more deterministic concurrency

Avoid replacing working subsystems solely to adopt fashionable patterns.

---

## D104 - DRY is valuable only where it improves clarity

**Status: Current**

Shared behaviour should be extracted when duplication risks inconsistent rules or creates a genuine reusable boundary.

Do not force unrelated workflows through one generic abstraction merely because some lines look similar.

### Reason

Removing duplication is not useful if the resulting abstraction hides important domain differences.

---

## D105 - Preserve exact subsystem lock ordering when adding race-sensitive transactions

**Status: Current**

New cross-table transactions must inspect and follow established lock order in neighbouring operations.

Do not independently choose a convenient opposite order.

### Reason

Correct local locking can still deadlock if two workflows acquire the same rows in reverse order.

Lock ordering is part of subsystem architecture.

---

# Testing and Development Decisions

## D106 - Bugs should be fixed regression-first

**Status: Current**

Preferred workflow:

```text
reproduce bug
      |
      v
write failing regression
      |
      v
confirm failure is for the intended reason
      |
      v
implement narrow fix
      |
      v
add positive or companion coverage where useful
      |
      v
run targeted tests
      |
      v
run full verification gate
```

The regression should demonstrate the broken behaviour before production code changes.

### Important workflow refinement

The red regression normally does **not** need to be committed as a permanently failing revision.

The important requirement is that the failure is observed and understood before the fix is applied.

---

## D107 - Real PostgreSQL is required for database integration testing

**Status: Current**

Integration tests use real PostgreSQL through Testcontainers.

Do not replace concurrency-sensitive integration coverage with an in-memory database approximation.

### Reason

Important behaviour depends on PostgreSQL itself, including:

- row locks
- transactions
- uniqueness constraints
- migration behaviour
- concurrent claims
- lock ordering
- isolation
- conditional updates

---

## D108 - Deterministic concurrency tests are preferred over arbitrary sleeps

**Status: Current**

Race tests should use explicit barriers, locks, promises, or controlled boundaries where practical.

Avoid asserting correctness based on:

```text
sleep for N milliseconds
hope operation A wins
```

### Reason

Timing-based race tests are flaky and may not prove the intended interleaving.

---

## D109 - New service boundaries should receive direct service integration tests

**Status: Current**

When reusable domain behaviour is extracted into a service, important persistence and state-transition behaviour should be tested directly at that boundary.

Do not rely exclusively on a command test to prove:

- transaction behaviour
- ownership checks
- locks
- persistence
- idempotency
- scheduled-action state

### Reason

A command adapter test and a service integration test answer different questions.

---

## D110 - Targeted tests come before full-suite verification

**Status: Current**

During implementation:

1. run the smallest relevant test
2. expand to the affected subsystem
3. run both typechecks where relevant
4. run the complete gate before PR-ready work

The normal full gate is:

```bash
npm run test:unit
npm run test:integration
npm run test:coverage
npm run typecheck
npm run typecheck:test
```

### Reason

Fast local feedback and complete regression verification are both useful.

They solve different parts of the development loop.

---

## D111 - Manual Discord smoke testing is complementary, not a substitute for automated tests

**Status: Current**

Manual Discord testing is particularly useful for:

- command registration
- button behaviour
- role selectors
- channel selectors
- real permission combinations
- mentions
- DMs
- fallback delivery
- deleted-message behaviour
- visual layout

Database and domain invariants should still receive automated coverage where practical.

---

## D112 - Local test and repository state is authoritative during active development

**Status: Current development practice**

When public GitHub state lags behind current local work, locally reported:

- source
- test output
- branch state
- typecheck output
- migration state

takes precedence for debugging the current change.

### Reason

A collaborator may be diagnosing work that has not yet been pushed.

Do not assume the public branch contains a local uncommitted fix.

---

# Template and Recurrence Decisions

These decisions describe the durable architectural direction for P1 templates and later recurrence.

The template source schema and one-off generation service are implemented.

Administrator-facing template creation/editing/lifecycle commands and recurrence remain future work.

D120 records why the original template scaffolding could be revised rather than preserved.

D134 records the current reusable-source versus generated-event ownership boundary.

The current durable principles are:

```text
template = reusable source

generated event = ordinary independent event

one-off generation = atomic PostgreSQL transaction

organiser defaults = optional event organiser snapshots

reminder defaults = ordinary event reminder snapshots

role-request configuration = established preset snapshot model

template edits = future generation by default

generation source lock = parent FOR SHARE

template mutation lock = parent FOR UPDATE

recurrence identity != mutable event start time
```

---

## D113 - Templates generate ordinary persistent events

**Status: Current**

One-off template generation produces normal event rows through the existing event domain.

Conceptually:

```text
Template
    |
    v
Generate occurrence
    |
    v
ordinary persistent event
```

Generated events use the same event services and runtime architecture as manually-created events.

### Reason

Templates reuse the event domain rather than creating a second class of runtime event.

---

## D114 - Template-generated events may exist before public publication

**Status: Current**

Generation creates a persistent event before Discord publication.

Scheduled generation can therefore establish:

```text
generated event
        |
        +---- dormant organisers
        +---- reminders
        +---- role-request snapshots
        +---- durable future work
        |
        v
later public publication
```

Manual generation also creates a real unpublished event.

Immediate generation still commits authoritative database state before the external Discord publication side effect.

### Reason

Event preparation and authoritative state must not depend on the Discord publication moment.

---

## D115 - Generated occurrences become independent after generation

**Status: Current**

Once generated from a template, an event owns its runtime state.

Later changes to reusable source state do not rewrite the generated event.

PostgreSQL integration coverage verifies independence from later changes to:

- template core fields
- template ping roles
- template organiser defaults
- template reminders
- referenced preset options
- guild default publication destination

Administrators may therefore treat the generated event as an ordinary independently-editable event.

### Reason

One occurrence may require different configuration without redefining reusable source state or rewriting neighbouring events.

---

## D116 - Template edits affect future generation by default

**Status: Current generation contract; administration pending**

Generation reads the current reusable template source when each event is created.

Already-generated event state is not rewritten when the source later changes.

Future administrator mutation services must preserve this contract.

An explicit propagation feature, if ever useful, must be designed separately.

### Reason

Existing generated events may already contain manual customisation, published state, signups, requests, reminders, or organiser history.

Implicit propagation would be destructive and difficult to reason about.

---

## D117 - Template organiser defaults snapshot into dormant event assignments

**Status: Current**

Template primary and backup organiser defaults become ordinary dormant:

```text
event_organiser_assignments
```

during generation when organiser functionality is enabled.

The template itself does not become runtime organiser ownership.

If organisers are disabled for the guild, template generation still succeeds and organiser assignments are omitted.

---

## D118 - Template reminder definitions snapshot into ordinary event reminders

**Status: Current**

Template reminder definitions become normal:

```text
event_reminders
```

plus their ordinary durable scheduled actions during generation.

Fixed reminder destinations remain fixed.

Null reminder destinations resolve once through the generated event publication destination.

Later template reminder changes do not rewrite existing event reminders.

---

## D119 - Template role-request configuration reuses the established snapshot model

**Status: Current**

Templates do not own a second reusable role-request architecture.

A template may reference zero or one reusable role-request preset.

During generation, the existing preset application service snapshots that source into ordinary event-owned:

- role options
- qualification roles
- request groups
- group-option mappings
- notification roles
- durable group actions
- preset provenance

Preset application occurs inside the same authoritative generation transaction.

A preset failure aborts generation rather than committing a partially-generated event.

### Reason

The preset subsystem already solves qualification, groups, channels, scheduling, mappings, locking, and independent event ownership.

---

## D120 - Existing template schema scaffolding may be revised rather than preserved

**Status: Applied during P1.1**

The repository entered P1 with early template schema including:

```text
event_templates
template_role_options
events.template_id
```

That scaffolding predated several later architectural developments.

P1.1 therefore treated it as evidence of earlier intent rather than a compatibility contract.

Migration:

```text
0021_reconcile-event-template-schema
```

removed obsolete source concepts and established the current template source model.

In particular:

- `template_role_options` was removed
- template role requests now reference the established preset architecture
- singular template ping-role state became an ordered child collection
- template reminder definitions gained their own reusable source table
- primary/backup organiser defaults gained their own source table
- publication intent became explicit
- recurrence was removed from the one-off template aggregate
- `events.template_id` was retained as provenance

### Reason

Schema presence must not force the implementation to preserve an older incomplete model when later architecture establishes a clearer ownership and snapshot boundary.

---

## D121 - Recurrence uses an RFC 5545 rule representation behind a constrained domain adapter

**Status: Current**

Recurring series store an RFC 5545-compatible recurrence-rule string.

The implementation uses the `rrule` library for calendar recurrence parsing and bounded occurrence calculation.

The library is not exposed directly as the application's recurrence contract.

P1 accepts a deliberately constrained rule subset:

```text
FREQ
INTERVAL
BYDAY
BYMONTHDAY
BYMONTH
WKST
```

Supported frequencies are:

```text
DAILY
WEEKLY
MONTHLY
YEARLY
```

Clock and timezone components are deliberately excluded.

In particular, P1 recurrence rules do not own:

```text
DTSTART
TZID
BYHOUR
BYMINUTE
BYSECOND
```

The event template remains authoritative for:

```text
timezone
normal local start time
```

The recurrence layer answers:

```text
Which local calendar dates belong to this series?
```

A later occurrence-generation layer combines each local date with the template's local start time and timezone to resolve an absolute event start instant.

The initial P1 recurrence-rule adapter also does not yet expose:

```text
COUNT
UNTIL
RDATE
EXDATE
EXRULE
```

Those features may be added deliberately when their product semantics, mutation behaviour, and occurrence-identity effects are defined.

### Bounded enumeration

Recurrence calculation always receives an explicit bounded date window.

The shared recurrence-rule adapter refuses excessively large enumeration windows rather than permitting accidental unlimited materialisation.

The rolling production-generation horizon is a separate policy and may be substantially smaller than the adapter's safety bound.

### Timezone boundary

The recurrence library is used as a calendar-date engine.

Synthetic UTC `Date` values are used internally only to provide stable year/month/day arithmetic to the library.

Those values are not event instants.

Named-timezone conversion remains the responsibility of the existing Luxon-based event date/time boundary.

### Reason

RFC recurrence rules have enough calendar edge cases that using an established implementation is preferable to inventing weekly/monthly arithmetic.

At the same time, third-party recurrence libraries have their own date and timezone semantics.

Keeping a constrained adapter between the library and the application preserves the project's clearer domain model:

```text
recurrence
    -> local calendar dates

template
    -> timezone + local time

occurrence preparation
    -> absolute instant

generation
    -> ordinary event snapshot
```

This also keeps the stored representation standards-oriented without making every capability of one dependency an accidental permanent product feature.

---

## D122 - Recurrence should use a bounded rolling generation horizon

**Status: Superseded by D138**

This decision established the durable requirement that automatic recurrence use a bounded rolling horizon rather than materialising an effectively unlimited future series.

An early design candidate of approximately:

```text
21 days
```

was discussed before the recurrence-generation boundary and administrator-facing lead-time requirements were fully reconciled.

D138 supersedes that numeric candidate with the implemented P1 policy of exactly:

```text
10 local calendar dates
```

including:

```text
today
through
today + 9 days
```

The durable principle retained from this decision is:

```text
recurring generation
    -> bounded rolling horizon
    -> never unlimited future materialisation
```

The current horizon value, rationale, local-calendar semantics, and reconsideration conditions are defined by D138.

---

## D123 - Recurrence occurrence identity must be separate from mutable event start time

**Status: Planned**

A generated recurring occurrence needs an immutable occurrence key.

Do not use the event's current `startsAt` as its only series identity.

Example failure if start time is used as identity:

```text
Monday occurrence generated
        |
        v
administrator moves event to Tuesday
        |
        v
generator runs again
        |
        v
Monday appears absent
        |
        v
duplicate occurrence created
```

### Reason

An occurrence's scheduled-series identity and its current edited start time are different concepts.

---

# Integration and Public-Repository Decisions

## D124 - Prefer collaboration with an existing community portal over unnecessary duplication

**Status: Planned direction**

Another community bot already provides portal and reporting functionality.

If collaboration proceeds, extending an existing suitable portal may be preferable to creating a competing portal solely to duplicate functionality.

### Reason

The objective is useful community tooling, not ownership of redundant interfaces.

---

## D125 - A future web or external interface should consume domain boundaries rather than Discord command handlers

**Status: Planned direction**

A future portal or another bot should ideally call reusable services or mapped domain operations.

It should not simulate:

```text
/event create
```

or construct fake Discord interactions merely to reuse behaviour.

### Reason

Discord is an interface.

It is not the application domain.

---

## D126 - Public documentation must distinguish implementation from intent

**Status: Current**

Documentation suitable for the public repository must not describe planned features as already implemented.

Likewise, completed features should be moved out of future-only roadmap language.

Particularly important examples include:

```text
implemented
    -> persistent event lifecycle
    -> immediate/manual/scheduled publication
    -> organiser workflows and safety handling
    -> event-level role requests
    -> reusable role-request presets
    -> preset editing and lifecycle
    -> scheduled role-request groups
    -> reminders
    -> message recovery
    -> focused deleted-channel/deleted-role reliability handling
    -> one-off event-template administration and generation

planned
    -> recurring event generation
    -> confirmed-organiser unavailability workflow
    -> richer participation context
```

### Reason

Documentation is used by:

- future development sessions
- collaborators
- recruiters
- potential users

Ambiguous implementation status creates incorrect assumptions.

---

## D127 - Preset role-option logical keys remain stable after creation

**Status: Current**

A preset role option's logical key is stable identity after creation.

Editing the human-readable display name must not regenerate or otherwise change that key.

For example:

```text
display name
    Captain
        |
        v
    Ship Captain

logical key
    captain
        |
        v
    captain
```

The current `/role-preset option-edit` operation therefore exposes display-name editing but does not expose logical-key editing.

If changing logical identity is ever required, it should be designed as a separate explicit operation rather than being an accidental consequence of renaming presentation text.

### Reason

Logical keys participate in:

- preset role-option identity
- event-level snapshot conflict detection
- reusable graph reasoning
- administrator expectations about what a renamed option represents

A display-name change is presentation.

It should not turn an existing reusable role into a different logical role.

---

## D128 - Preset qualification editing replaces the complete role set atomically

**Status: Current**

Editing qualification roles for an existing preset option uses complete replacement semantics.

The requested qualification configuration is validated as a complete final set before existing rows are removed.

The replacement then occurs inside one PostgreSQL transaction.

Conceptually:

```text
validate complete requested set
        |
        v
delete existing qualification rows
        |
        v
insert replacement rows
        |
        v
commit
```

An empty replacement is valid for an `open` option.

An empty replacement is rejected for a `qualified_only` option.

The Discord command requires an explicit clear operation rather than interpreting omitted optional role arguments as destructive intent.

Qualification-role ordering is not meaningful.

Equivalent sets supplied in a different order are treated as an idempotent no-op.

### Reason

Qualification configuration is a small dependent set whose correctness is defined by its complete final state.

A single replacement operation provides simpler validation and stronger atomicity than exposing a sequence of independent add/remove mutations.

Explicit clearing also reduces the risk that omitted Discord options accidentally destroy existing reusable configuration.

---

## D129 - Request-group notification audiences are ordered child collections

**Status: Current**

Role-request groups may have zero or more notification roles.

The current administrator-facing limit is four roles per group.

Notification roles are represented as ordered child collections:

```text
role_request_preset_group_notification_roles
role_request_group_notification_roles
```

rather than as fixed numbered columns such as:

```text
notify_role_1_id
notify_role_2_id
notify_role_3_id
notify_role_4_id
```

The collection stores Discord role identity, a human-readable name snapshot, and explicit ordering.

Preset application snapshots the complete ordered collection into event-level state.

Runtime publication reads the event-level collection and resolves each role independently.

### Migration compatibility

The move from the historical singular notification-role columns uses an expand-and-contract migration.

The new child tables are authoritative for collection-aware code.

During the compatibility period:

```text
write
    -> persist complete child collection
    -> mirror first role into legacy singular columns

read
    -> use child collection when rows exist
    -> otherwise fall back to legacy singular columns
```

The old singular fields are temporary deployment compatibility shadows.

They should be removed only after the collection-aware application has been deployed safely and a later cleanup migration can no longer overlap with an older revision expecting those columns.

### Reason

A child collection avoids schema growth for each additional role, preserves ordering, provides clean preset snapshot semantics, and lets the application-level role limit change independently from database structure.

The expand-and-contract approach also avoids a deployment window where old and new application revisions require incompatible schemas.

---

## D130 - Preset request-group edits use explicit partial-field semantics and complete notification replacement

**Status: Current**

Editing an existing reusable preset request group is a partial definition mutation.

Omitted fields preserve their current values.

Conceptually:

```text
field omitted
    -> preserve

replacement value supplied
    -> replace

explicit clear supplied
    -> clear nullable value
```

For the ordered notification-role collection:

```text
notificationRoles = undefined
    -> preserve complete collection

notificationRoles = []
    -> clear complete collection

notificationRoles = [A, B, ...]
    -> replace complete ordered collection
```

Notification replacement is not incremental append/remove behaviour.

The complete requested collection is validated before existing rows are replaced inside the authoritative transaction.

Group-option mappings are not part of this mutation and remain unchanged.

Request-group editing participates in the preset graph locking contract:

```text
preset application
    -> role_request_presets FOR SHARE

request-group edit
    -> role_request_presets FOR UPDATE
```

Existing event-level snapshots remain independent.

A true no-op does not advance group or parent preset timestamps and does not produce a false successful mutation audit.

### Reason

Administrators need to edit one part of a reusable group without accidentally clearing unrelated configuration.

Destructive actions therefore require explicit intent.

Treating notification roles as one complete ordered collection also provides atomic validation and avoids partially-mutated notification state.

Keeping group-option mappings outside the request-group definition edit gives that ordered many-to-many relationship its own clear mutation boundary.

---

## D131 - Preset request-group option mappings use complete ordered replacement

**Status: Current**

Editing the option mappings of an existing reusable request group uses complete ordered replacement.

Conceptually:

```text
current mapping
    -> [A, B, C]

replacement request
    -> [C, A]

final mapping
    -> [C, A]
```

The operation does not model separate append, remove, or reorder commands.

The supplied order becomes authoritative.

At least one mapped option is required.

Duplicate option IDs are rejected.

Every mapped option must belong to the same preset as the target request group.

## Lifecycle independence

Mapping membership and preset option lifecycle are independent.

Inactive preset options may remain mapped or be included in a replacement.

The command warns when inactive options are present.

If an active group has no active mapped options, the configuration may remain stored temporarily, but preset application rejects that unusable active graph.

This matches existing lifecycle behaviour where deactivating an option preserves its structural mappings.

## Shared options

The same logical preset option may be mapped into more than one request group.

Replacing one group's mapping does not change mappings belonging to another group.

## Concurrency

Mapping replacement participates in the preset graph locking contract:

```text
preset application
    -> role_request_presets FOR SHARE

mapping replacement
    -> role_request_presets FOR UPDATE
```

The replacement is validated completely before existing mapping rows are deleted and recreated inside the transaction.

Application therefore snapshots either the complete mapping before replacement or the complete mapping after replacement.

Existing event-level snapshots remain independent.

## No-op semantics

Mapping equality is order-sensitive.

```text
[A, B] -> [A, B]
    unchanged

[A, B] -> [B, A]
    updated
```

A true no-op does not advance group or parent preset timestamps and does not generate a false mutation audit.

### Reason

A request-group mapping is an ordered relationship rather than an unordered set.

Complete replacement makes final-state validation, ordering, transactionality, and concurrency behaviour easier to reason about than a sequence of separate add/remove/reorder operations.

Allowing inactive mapped options also keeps structural configuration separate from lifecycle state and avoids destructive side effects when options are temporarily disabled.

---

## D132 - Preset administration remains ID-based after the UX review

**Status: Current**

The `/role-preset` administration surface remains intentionally ID-based after the final preset UX review.

The supported discovery path is:

```text
/role-preset list
        |
        v
preset ID
        |
        v
/role-preset show
        |
        v
option and group IDs
```

The UX review improved this workflow by making child-ID discovery explicit and by improving reusable-state presentation and repair guidance.

Autocomplete was considered but not introduced.

The current workflow is:

- deterministic
- guild-scoped
- based on existing query operations
- straightforward to test
- sufficient for the present administration volume

Adding autocomplete solely to avoid entering IDs would introduce another lookup path without a demonstrated operational need.

Autocomplete is not forbidden permanently.

It may be reconsidered if real administrator usage demonstrates meaningful friction and the implementation can remain cheap, deterministic, guild-scoped, and maintainable.

### Reason

Prefer a small coherent command surface over speculative UX machinery.

The existing `list -> show -> mutate` flow exposes the required identifiers while keeping authoritative mutation validation in the existing service layer.

---

## D133 - Organiser notification destination loss and audience loss are different failures

**Status: Current**

The organiser notification system distinguishes the Discord destination from the optional notification audience.

A deleted Event Administration channel means:

```text
destination unavailable
    -> claimable message cannot be posted there
```

A deleted Event Organiser role means:

```text
notification audience unavailable
    -> Event Administration channel may still be usable
    -> claimable message should still post
    -> delivery = posted_without_ping
```

Discord may report a missing organiser role through:

```text
role fetch -> null
```

or:

```text
10011 Unknown Role
```

Both represent definitive role absence.

By contrast, an unexpected role-resolution or Discord transport error remains an unexpected failure and must preserve the appropriate retry/observability path.

The guild's `@everyone` role must never become an automatic organiser-notification fallback.

This remains true even when the bot has `MentionEveryone`.

For scheduler-driven organiser messages:

```text
posted_without_ping
    -> successful delivery
    -> message linkage is persisted
    -> scheduled action completes
    -> audit records the actual delivery mode
```

A definitive deleted Event Administration channel is different:

```text
10003 Unknown Channel
    -> destination unavailable
    -> no guessed replacement channel
```

### Reason

Organiser state is authoritative in PostgreSQL.

The ability to mention a role is presentation.

Losing an optional notification audience should not discard a useful claimable administration message when its destination still exists.

Conversely, losing the destination itself must not cause the bot to choose an unrelated channel.

Treating confirmed Discord deletion separately from unexpected transport failures also preserves retry behaviour and operational observability.

---

## D134 - Template source state is separate from generated event-owned state

**Status: Current**

P1 templates are reusable source configuration.

The current source aggregate is:

```text
event_templates
    |
    +---- event_template_ping_roles
    +---- event_template_organiser_defaults
    +---- event_template_reminders
    +---- optional role_request_preset_id
```

Generation copies or resolves that reusable state into ordinary event-owned state inside one authoritative PostgreSQL transaction.

The generated event must not continuously consult the current template definition.

### Role-request relationship

P1 initially supports:

```text
zero or one role-request preset per template
```

The preset remains reusable source configuration.

Generation must use the existing preset snapshot architecture rather than creating template-specific role-request runtime state.

### Organiser defaults

Template organiser defaults are optional.

Supported reusable slots are:

```text
primary
backup
```

`cover` remains runtime recovery state.

If guild organiser functionality is disabled, template generation must remain available and must not fail merely because organiser defaults exist.

No organiser assignments should be created while the feature is disabled.

### Publication intent

Templates explicitly distinguish:

```text
manual
scheduled
immediate
```

source intent.

Scheduled publication requires a publication offset.

Manual and immediate source intent do not store one.

Generated events continue to use the existing runtime publication architecture rather than a template-specific publication state machine.

### Provenance

Generated events retain:

```text
events.template_id
```

as provenance.

The relationship uses deletion restriction.

Normal template lifecycle therefore favours active/inactive state rather than destructive deletion.

### Recurrence

Recurrence is not part of the one-off template source aggregate.

The one-off administrator workflow is now established.

Recurring generation remains a separate P1 layer which must reuse the existing template-generation boundary rather than turning the one-off template aggregate into a runtime series model.

### Reason

The template must provide reusable configuration without becoming a second runtime event model.

Snapshotting into existing event-owned state preserves:

- independent event editing
- stable historical behaviour
- established scheduler semantics
- existing organiser behaviour
- existing reminder behaviour
- existing role-request behaviour
- future portability across non-Discord interfaces

---

## D135 - Occurrence wall-clock resolution is external to generation and source-revision guarded

**Status: Current**

The reusable generation service accepts:

```text
startsAt: Date
```

as an already-resolved absolute instant.

It does not interpret:

```text
date
local_start_time
timezone
```

into an instant itself.

Administrator-driven one-off generation resolves local wall-clock input in the command/application adapter through the shared named-timezone parser.

Future recurrence should likewise resolve recurrence-local wall-clock occurrences before entering the generation persistence boundary.

### Source revision

One-off administrator generation must inspect template timing metadata before calling the generator.

A template may be edited between that inspection and the generator acquiring its source lock.

The adapter therefore passes the inspected parent revision as:

```text
expectedTemplateUpdatedAt
```

Generation validates it after acquiring:

```text
event_templates FOR SHARE
```

A mismatch returns:

```text
template_changed
```

and no event is generated.

Template parent and child mutation services update the parent revision.

### Reason

Keeping calendar interpretation outside the persistence service gives one-off administration and future recurrence a common event-generation boundary.

The revision guard prevents that separation from allowing:

```text
old timezone / local time
        +
new template source graph
```

to produce one incoherent occurrence.

This preserves the source-snapshot guarantee without teaching the core generator about Discord command input or recurrence-rule syntax.

---

## D136 - Recurrence is a separate series with immutable local-date occurrence identity

**Status: Current**

Recurring scheduling is modelled separately from reusable event-template defaults.

P1 uses:

```text
event template
        |
        | one recurrence series
        v
event_template_recurrences
        |
        | local calendar occurrence
        v
event_recurrence_occurrences
        |
        v
ordinary event
```

The initial implementation supports at most:

```text
one recurrence series per template
```

This is an intentional P1 product boundary rather than a requirement that the model can never support several series later.

The recurrence series stores:

```text
template identity
recurrence rule
local recurrence start date
active / inactive state
audit identity / timestamps
```

The template continues to own:

```text
timezone
normal local start time
event defaults
publication defaults
organiser defaults
reminders
role-request preset
ping roles
```

A recurring occurrence is identified by:

```text
recurrence_id
+
occurrence_date
```

where `occurrence_date` is the original local calendar date represented by that series slot.

This identity is stored separately from:

```text
events.starts_at
```

and must not change when an administrator edits the generated event's current start time.

The occurrence mapping also owns a unique event relationship:

```text
one event
    -> at most one recurrence occurrence
```

Generated recurring events remain ordinary events and continue to retain normal:

```text
events.template_id
```

template provenance.

### Calendar-date identity

P1 recurrence is date-based.

The recurrence rule determines which local calendar dates belong to the series.

The template's current timezone and normal local start time resolve each not-yet-generated date into an absolute occurrence instant.

This means a change from:

```text
20:00
```

to:

```text
21:00
```

does not change the identity of an already-generated Monday occurrence.

Likewise, moving that generated event to another date does not make the original recurrence slot appear absent.

### Duplicate prevention

PostgreSQL enforces:

```text
PRIMARY KEY (
    recurrence_id,
    occurrence_date
)
```

on generated occurrence provenance.

Repeated or concurrent generation must rely on this durable identity boundary rather than assuming an in-memory check is sufficient.

A cancelled event remains linked to its recurrence slot and therefore must not be recreated merely because it is cancelled.

### Lifecycle

Recurrence has its own active/inactive lifecycle.

Template lifecycle and recurrence lifecycle remain distinct.

Disabling recurrence stops future recurring generation.

It does not cancel or rewrite events already generated from the series.

An inactive template still prevents generation because recurrence continues to use the established template-generation boundary.

### Deletion

Recurrence and generated-occurrence provenance use restrictive deletion relationships.

Normal administration should use lifecycle state rather than deleting recurrence provenance which existing events may depend on.

### Reason

Separating recurrence from the reusable event-template aggregate keeps three concepts distinct:

```text
template
    -> what an event normally looks like

recurrence
    -> which local calendar slots should exist

event
    -> one authoritative runtime occurrence
```

Using immutable local-date occurrence provenance prevents event edits from causing duplicate recurring events while preserving the established event snapshot model.

---

## D137 - Recurring occurrence generation atomically couples event snapshot and immutable provenance

**Status: Current**

One recurring occurrence is generated through one authoritative PostgreSQL transaction.

The persistence boundary is:

```text
lock template source
        |
        v
lock recurrence series
        |
        v
validate requested local calendar slot
        |
        v
check existing occurrence provenance
        |
        v
resolve local date + template local time + timezone
        |
        v
generate ordinary event snapshot
        |
        v
insert event_recurrence_occurrences
        |
        v
commit
```

The ordinary event and its immutable recurrence provenance must never commit independently.

The authoritative occurrence identity remains:

```text
recurrence_id
+
occurrence_date
```

and is protected by the PostgreSQL primary key on:

```text
event_recurrence_occurrences
```

### Lock ordering

Recurring generation uses the same parent-first ordering as recurrence administration:

```text
event_templates
        |
        v
event_template_recurrences
```

Generation takes:

```text
event_templates
    -> FOR SHARE

event_template_recurrences
    -> FOR UPDATE
```

Recurrence mutation takes:

```text
event_templates
    -> FOR UPDATE

event_template_recurrences
    -> FOR UPDATE
```

This avoids lock-order inversion while allowing unrelated template readers where safe.

The recurrence-row exclusive lock also serialises competing generators for the same series.

After the lock is acquired, a repeated generator observes existing occurrence provenance and returns the already-generated event instead of creating another one.

The database uniqueness rule remains the final correctness boundary even though the service performs the idempotency read first.

### Slot validation

A caller cannot create recurrence provenance for an arbitrary date.

The requested `occurrence_date` is re-evaluated against the locked recurrence rule and recurrence start date before generation.

Only a calendar date belonging to the stored series may proceed.

### Wall-clock resolution

The immutable recurrence slot is a local calendar date.

Generation combines:

```text
occurrence_date
+
event_templates.local_start_time
+
event_templates.timezone
```

through the shared Luxon-based event date/time parser.

The resulting absolute instant is then supplied to the ordinary template-generation boundary.

Impossible or daylight-saving-ambiguous local times are not guessed.

They return an explicit recurrence-generation failure for that slot.

### Template snapshot reuse

Recurring generation does not implement a second event snapshot mechanism.

It calls the same template-generation domain boundary used by one-off generation.

The template generator therefore exposes a caller-owned transaction variant.

A nested PostgreSQL savepoint protects the generator's late-failure path.

This is necessary because role-request preset application may discover a normal domain failure after event/reminder state has already been inserted.

The savepoint ensures that such partial template-generation state is rolled back before the failure is returned to the surrounding recurrence transaction.

### Individual event independence

Once generation commits:

```text
recurrence
    -> immutable slot provenance

event
    -> independent runtime snapshot
```

Editing or cancelling the generated event does not alter its recurrence slot.

The slot therefore remains occupied even when:

```text
events.starts_at
```

is later moved.

A cancelled or rescheduled event must not be interpreted as a missing recurring occurrence.

### Discord side effects

Discord publication remains outside the recurrence-generation database transaction.

Automatic recurrence does not support templates whose publication mode is:

```text
immediate
```

Recurrence materialises future occurrences ahead of their public lifecycle.

Treating materialisation time as "publish immediately" would make the internal rolling-generation horizon visible to administrators and members, potentially publishing several future events at once.

The recurrence service therefore rejects Immediate-publication templates.

Manual administrator-driven `/template generate` remains different.

For a one-off generated occurrence:

```text
immediate
```

still means:

```text
generate now
+
publish now
```

through the existing post-commit publication path.

Scheduled recurring events continue to use ordinary durable `publish_event` actions at their configured publication offsets.

Manual recurring events remain unpublished until an administrator explicitly publishes them.

### Reason

A recurring generator may run repeatedly, concurrently, or after process restarts.

If ordinary event creation and recurrence provenance were separate commits, a crash between them could leave:

```text
event exists
+
occurrence provenance missing
```

A later generator would then treat the recurrence slot as absent and create a duplicate event.

Atomic generation removes that failure window.

---

## D138 - Recurring materialisation uses a bounded 10-day local-calendar horizon

**Status: Current**

Recurring events are materialised through a bounded rolling horizon.

The initial P1 horizon contains exactly:

```text
10 local calendar dates
```

including the template-local current date:

```text
today
through
today + 9 days
```

The horizon is calculated in:

```text
event_templates.timezone
```

rather than UTC or the application host timezone.

### Why 10 days

Current administrator-facing configuration limits publication, reminders, and role-request opening/closing to at most:

```text
10,080 minutes
=
7 days
```

before the relevant event reference point.

A 10-day materialisation horizon therefore gives the longest currently-supported lead time three days of generation headroom.

The shorter horizon also reduces the period during which future events have already become independent snapshots and therefore no longer inherit later template edits.

If supported lead-time limits are increased, or if the recurrence sweep cadence changes materially, the horizon must be reconsidered at the same time.

The horizon must not become shorter than work which needs to exist before a generated event.

### Per-occurrence transactions

A complete horizon is not generated inside one large PostgreSQL transaction.

Instead:

```text
enumerate bounded local dates
        |
        +--> generate occurrence A atomically
        |
        +--> generate occurrence B atomically
        |
        +--> generate occurrence C atomically
```

Each occurrence continues to use the atomic event-plus-provenance boundary established by D137.

This means failure of one occurrence does not roll back successful sibling occurrences.

Repeated horizon execution is safe because individual occurrence generation is idempotent.

### Consistent clock

One horizon run captures one current instant and passes it through every occurrence-generation call.

This prevents a long-running horizon pass from evaluating neighbouring slots against subtly different definitions of "now".

Normal production callers use the real current instant.

Tests and explicit recovery tooling may inject a deterministic current time.

### Same-day stale slots

The template-local current date is included in the horizon.

This permits a recurrence first enabled earlier on the same day to create an event which is still usable.

If that day's occurrence has already passed, or its signup deadline has already passed, it is classified as a non-retryable skipped slot for that horizon run.

It is not treated as a broken recurrence series.

Future valid slots continue processing.

### Source changes during a horizon run

The horizon first enumerates from one recurrence snapshot.

Each occurrence then revalidates its requested date against the authoritative locked recurrence source before generation.

A concurrent recurrence-rule edit may therefore make one enumerated slot no longer valid.

Such a slot is classified as skipped due to source change.

The next horizon run re-enumerates the new rule and creates any newly-introduced valid slots.

Already-generated occurrences remain independent snapshots.

### Automated creator provenance

Automatic recurrence materialisation has no human actively pressing a command.

`events.created_by_user_id` nevertheless remains non-null.

Generated recurring events therefore retain the recurrence creator's user ID as their source creator provenance.

System-triggered audit records may still use a null audit actor where appropriate.

This avoids inventing a fake Discord user identity while preserving the administrator whose reusable schedule caused the events to exist.

### Immediate publication

Immediate publication is intentionally unsupported for automatic recurrence.

The rolling horizon is an internal materialisation mechanism and must not determine when members first see an event.

Recurring templates must therefore use:

```text
manual
```

or:

```text
scheduled
```

publication.

For Scheduled publication, materialisation creates the normal durable publication action for the configured offset.

For Manual publication, the occurrence exists privately until an administrator explicitly publishes it.

Immediate publication remains available for one-off event creation and one-off template generation.

### Reason

A rolling horizon provides enough future materialisation for existing publication/reminder/role-request lead times without creating an unbounded number of events.

Using local calendar dates preserves recurrence semantics across timezone and daylight-saving changes.

Using independent idempotent occurrence transactions makes horizon execution safe to repeat after scheduler ticks, process restarts, or partial failures.

---

## D139 - Generated events retain exact template-revision provenance

**Status: Current**

Template-generated events retain both their reusable source identity and the exact source revision used for generation.

The authoritative provenance is:

```text
events.template_id
+
events.template_source_updated_at
```

For a newly-generated event:

```text
events.template_source_updated_at
    =
the locked event_templates.updated_at
used by generation
```

This timestamp is part of the generated-event provenance.

It is not live configuration.

### Existing events remain independent

Generation still follows:

```text
template source
    |
    | snapshot
    v
ordinary event-owned state
```

A later template edit changes:

```text
event_templates.updated_at
```

but does not rewrite:

```text
events.template_source_updated_at
```

or any other generated-event snapshot.

This allows administration to distinguish an event generated from the current reusable definition from one generated before a later template change.

### Historical unknown state

`template_source_updated_at` is nullable deliberately.

A null value may mean:

```text
non-template event
```

or:

```text
template-generated event predating exact revision provenance
```

For an event which still has a `template_id`, inspection reports a null source revision as:

```text
Revision unknown
```

The application must not fabricate historical provenance by comparing or backfilling unrelated creation timestamps.

### Administrator inspection

`/template show-generated` provides the template-to-event inspection boundary.

By default it lists generated events whose current:

```text
events.starts_at
```

has not yet passed.

An explicit `include-past:true` option includes historical generated events.

The command reads runtime information from ordinary event-owned state.

Relevant state includes:

```text
events
event_recurrence_occurrences
scheduled_actions[action_key = publish_event]
```

The current template is read only for:

```text
guild ownership
template identity/name
current revision comparison
```

It is not used to reconstruct the generated event's runtime configuration.

### Recurrence identity remains separate

For automatically-recurring events:

```text
event_recurrence_occurrences.occurrence_date
```

continues to represent the immutable original recurrence calendar slot.

The mutable:

```text
events.starts_at
```

represents the event's current scheduled start.

`/template show-generated` may therefore display both without treating them as interchangeable.

### Reason

Template snapshot independence is difficult for administrators to manage if they cannot identify which events already exist or whether those events came from an older source revision.

Exact provenance makes that distinction deterministic without weakening snapshot independence or making events continue following reusable source configuration.

---

## D140 - Public event reminders must respect event publication

**Status: Current**

Persistent event reminders are public-facing event messages.

A reminder becoming due is not permission to expose an event which remains unpublished.

The durable rule is:

```text
reminder due
+
event published
    -> normal reminder execution

reminder due
+
event unpublished
+
reference point still future
    -> defer until publication

reminder due
+
reference point reached or passed
    -> mark missed
```

### Durable deferral

Waiting for publication is expected domain state rather than a Discord delivery failure.

A due reminder for an unpublished event is therefore parked at its useful reference boundary.

The action is reset to:

```text
status = pending
attempt_count = 0
locked_at = NULL
completed_at = NULL
last_error = NULL
```

Waiting must not consume the scheduler's delivery-retry budget.

### Publication wake-up

Successful event publication is an authoritative release point for due reminders.

Inside the same PostgreSQL transaction which records:

```text
events.published_at
```

publication wakes reminder actions where:

```text
normal reminder due time <= publishedAt
<
useful reminder reference time
```

The action becomes freshly pending at the publication time.

Future reminders keep their original schedules.

Reminders whose useful reference point has already passed are not revived.

### Scheduler ownership

Publication may race a reminder worker which already observed the event as unpublished.

Publication may therefore replace both:

```text
pending
processing
```

reminder actions with fresh pending state.

The stale scheduler worker remains fenced by the existing combination of:

```text
scheduled action ID
+
status = processing
+
attempt_count
```

If publication already released the action, the stale worker cannot re-park or complete that newer state.

### Scope

This rule applies to ordinary persistent:

```text
event_reminders
```

including reminders snapshotted from event templates.

It does not turn persistent reminders into template-owned runtime state.

Immediate administrator announcements remain a separate explicit workflow.

### Reason

Administrators may deliberately create and configure an event well before members should see it.

Durable scheduled work must preserve that publication intent rather than leaking the event merely because a reminder timestamp arrived first.

At the same time, publication should release still-useful due reminders promptly rather than losing them or waiting until their final reference boundary.

---

## D141 - Recurrence sweeping is durable series-owned leased work

**Status: Current**

Automatic recurrence must survive:

```text
process restart
deployment
temporary database outage
multiple bot workers
partial horizon failure
```

without treating an in-memory JavaScript timer as authoritative state.

### Recurrence scheduling state belongs to the series

Ordinary:

```text
scheduled_actions
```

are event-owned and require:

```text
event_id
```

A recurrence sweep exists before the next event exists.

Automatic recurrence scheduling therefore belongs to:

```text
event_template_recurrences
```

through durable operational fields including:

```text
next_sweep_at
sweep_claim_token
last_sweep_started_at
last_sweep_completed_at
last_sweep_outcome
last_sweep_diagnostic
```

The in-process polling interval merely discovers due database state.

It is not itself durable scheduling state.

### Polling and durable cadence are separate

The process polls frequently enough to discover newly-due recurrence work promptly.

Each successful claim advances:

```text
next_sweep_at
```

independently of that polling interval.

The current implementation uses approximately:

```text
15-second local discovery polling
5-minute durable recurrence sweep cadence
```

These exact intervals are implementation policy rather than public API.

The invariant is:

```text
frequent disposable polling
+
durable database-owned eligibility
```

### Claim ownership

Discovery is not ownership.

Several workers may read the same due recurrence.

Ownership is established only by a conditional PostgreSQL update which:

```text
moves next_sweep_at forward
+
writes a unique sweep_claim_token
+
records last_sweep_started_at
```

A competing worker which loses that update performs no recurrence work for that candidate.

This avoids introducing a recurrence-first row-lock order which could conflict with the established:

```text
template
    -> recurrence
```

mutation/generation lock hierarchy.

### Stale recovery

A process may disappear after claiming recurrence work.

Claims therefore have a bounded stale lease.

A later worker may recover recurrence work whose claim has exceeded that lease.

Individual occurrence generation remains idempotent through:

```text
recurrence_id
+
occurrence_date
```

so stale recovery must not create duplicate events.

### Completion fencing

A worker may lose ownership while processing because:

- an administrator edits the recurrence
- an administrator changes recurrence lifecycle
- another worker legitimately recovers a stale claim

Sweep completion therefore requires the exact current:

```text
sweep_claim_token
```

A stale worker cannot overwrite newer recurrence operational state.

### Source edits and lifecycle changes

A recurrence source edit:

```text
makes the series immediately sweepable
clears old operational outcome/diagnostic state
supersedes an older claim
```

Deactivation supersedes any existing claim.

Reactivation makes the recurrence immediately eligible again.

Previously-generated events remain unchanged in every case.

### Failure isolation and observability

One recurrence failure must not abort unrelated due recurrence work.

The sweep runner processes claimed series independently.

The latest completed result is persisted as:

```text
success
partial_failure
failure
skipped
```

with an optional human-readable diagnostic.

Administrator inspection surfaces this persisted state through recurrence commands.

Console logging remains useful operational presentation, but it is not the sole source of failure history.

### Scheduler lifecycle

The recurrence scheduler:

```text
runs once immediately at startup
polls for later due work
does not overlap local ticks
stops new polling during shutdown
waits for an in-flight tick before PostgreSQL is closed
```

This preserves the same shutdown invariant as the ordinary event scheduler:

```text
stop new work
    ->
drain active work
    ->
close shared resources
```

### Reason

Recurring materialisation is important future work, but it is not attached to an event until generation succeeds.

Giving the recurrence series its own durable lease state preserves restart safety and multi-worker ownership without distorting the event-owned scheduled-action model.

---

# Summary of Highest-Risk Invariants

The following decisions are especially easy to break during an otherwise well-intentioned refactor.

## Database authority

```text
PostgreSQL wins over Discord presentation
```

## Publication

```text
unpublished event != nonexistent event
publication state != lifecycle state
```

## Final lifecycle

```text
cancellation remains final
```

## Scheduler

```text
due action != permission to ignore current state
stale worker != current owner
admin reschedule != retry failure
```

## Organisers

```text
creator != organiser

dormant nominee
    -> normal activation at publication
    -> except when event safety timing has already superseded nominee flow

primary -> backup -> cover

cover may still be useful after event start

normal organiser work
    -> shared feature lock

feature disable
    -> exclusive feature lock

admin channel missing
    -> destination failure
    -> no guessed fallback

organiser role missing
    -> audience degradation
    -> posted_without_ping when admin channel remains usable

@everyone
    -> never organiser notification fallback

unexpected Discord error
    -> not proof of deleted channel or role
```

## Role requests

```text
role option belongs to event

request group presents role option

request belongs to event + user + role option

same role in multiple groups
    -> one shared volunteer pool

request != assignment

repeat click != withdrawal

qualification != notification audience
```

## Presets

```text
preset = reusable source

application = snapshot

event = independent afterwards

application
    -> preset FOR SHARE

preset mutation
    -> preset FOR UPDATE

role-option display rename
    -> logical key remains stable

inactive child
    -> preserved configuration

option deactivation
    -> no hidden cascading group mutation

qualification replacement
    -> complete set validated and replaced atomically

notification-role collection
    -> snapshot complete ordered collection
    -> existing event snapshot remains independent

request-group edit
    -> omitted field preserves stored value
    -> explicit clear is destructive intent
    -> notification roles replace complete ordered collection
    -> group-option mappings remain separate
    -> existing event snapshot remains independent

group-option mapping edit
    -> complete ordered replacement
    -> at least one mapping remains
    -> inactive options may remain mapped
    -> option lifecycle remains independent
    -> same option may appear in several groups
    -> application sees complete old or complete new mapping
    -> existing event snapshot remains independent
```

## Message recovery

```text
known deleted message
+
known destination
    -> recovery may rebuild

unknown Discord failure
    -> not proof of deletion

concurrent recovery
    -> one authoritative linkage
```

## Templates and recurrence

```text
template
    -> generates ordinary event

generated occurrence
    -> independent snapshot

template edit
    -> future generated occurrences by default

occurrence identity
    != mutable startsAt
```

---

# Related Documentation

See:

- [`../README.md`](../README.md) for the public project overview
- [`ARCHITECTURE.md`](ARCHITECTURE.md) for current system structure
- [`ROADMAP.md`](ROADMAP.md) for unfinished future work
- [`CURRENT-WORK.md`](CURRENT-WORK.md) for the current development checkpoint
- [`TESTING-GUIDE.md`](TESTING-GUIDE.md) for regression and verification practices
- [`ADMIN-GUIDE.md`](ADMIN-GUIDE.md) for current administrator-facing behaviour

When a proposed implementation conflicts with one of these decisions, do not silently work around the conflict.

Determine whether:

1. the proposal is wrong
2. the decision has genuinely been superseded
3. the implementation currently contains a bug
4. a new explicit product decision is required

Then update code, tests, and this document consistently.
