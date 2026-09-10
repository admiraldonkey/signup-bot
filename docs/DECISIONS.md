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

Mutable guild defaults should not silently alter already-configured events.

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

Changing the guild default should not silently move an event that has already been prepared or scheduled.

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

Who should be informed that Captain requests are open?
    -> notification role
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

## D049 - Role-request notification failures should degrade safely

**Status: Current**

When a request group has an optional notification role:

- a missing role may be skipped
- an unmentionable role may be skipped if permissions do not allow it
- `@everyone` is not treated as a normal role-notification choice
- the request group may still publish without the ping

### Reason

Notification delivery and existence of the request surface are separate concerns.

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

They must not silently become historical truth.

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

Recovery should restore lost presentation, not silently redesign configuration.

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
- notification-role snapshots
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

If an administrator deactivates the last active option mapped into an active group, the lifecycle operation does not silently deactivate that group.

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

**Status: Planned, immediate next work**

Upcoming preset-edit functionality must alter the reusable source only.

Already-applied events must not be rewritten automatically.

Preset mutations must use the parent-row mutation lock described in D076.

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

## D113 - Templates should generate ordinary persistent events

**Status: Planned**

Future event templates should produce normal event rows.

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

A generated occurrence should then participate in the same event services as a manually-created event.

### Reason

Templates should reuse the event domain rather than create a second class of runtime event.

---

## D114 - Template-generated events should normally exist before public publication

**Status: Planned**

Future occurrence generation should support a preparation period:

```text
generate occurrence internally
        |
        +---- assign dormant organisers
        |
        +---- create reminders
        |
        +---- snapshot role-request configuration
        |
        +---- allow administrator edits
        |
        v
scheduled public publication
```

### Reason

Recurring event administration often begins before members should receive the event announcement.

---

## D115 - Generated occurrences become independent after generation

**Status: Planned**

Once an event is generated from a template, it should behave as an ordinary event.

Administrators should be able to edit that occurrence independently without changing:

- the template
- earlier occurrences
- later already-generated occurrences

### Reason

One week's event may need a different:

- start time
- organiser
- description
- reminder
- role-request configuration

without redefining the recurring series.

---

## D116 - Template edits should affect newly-generated occurrences by default

**Status: Planned**

Changing a template should normally affect occurrences generated afterwards.

It should not silently rewrite already-generated events.

A future explicit propagation feature could be designed separately.

### Reason

Existing occurrences may already have manual customisations or published state.

Implicit propagation would be destructive and difficult to reason about.

---

## D117 - Template organiser defaults should snapshot into dormant event assignments

**Status: Planned**

A template may eventually provide primary and backup organiser defaults.

When an occurrence is generated, those defaults should become ordinary dormant event organiser assignments.

The template itself should not become runtime organiser ownership.

---

## D118 - Template reminder definitions should snapshot into ordinary event reminders

**Status: Planned**

A template may define reminders such as:

```text
10 minutes before signup close
10 minutes before event start
```

Generated occurrences should receive normal event-level reminder rows and normal durable scheduler actions.

Later template changes should not rewrite those reminder instances automatically.

---

## D119 - Template role-request configuration should reuse the established snapshot model

**Status: Planned**

Future templates should not create an incompatible second reusable role-request architecture.

The preferred direction is to reuse:

- role-request presets
- event-level role options
- event-level request groups
- existing application/snapshot services

### Reason

The preset subsystem already solves qualification, groups, channels, scheduling, mappings, and independent event ownership.

---

## D120 - Existing template schema is scaffolding, not a finished contract

**Status: Current clarification**

The repository currently contains template-related schema including:

```text
event_templates
template_role_options
events.template_id
```

Some of this predates the completed reusable role-request preset design.

Future template implementation may revise or supersede parts of this scaffolding.

### Reason

Schema presence must not force future implementation to preserve an older incomplete model when later architecture provides a better boundary.

---

## D121 - Recurrence should use a standards-based representation where practical

**Status: Planned**

The current intended direction is an RFC 5545 compatible recurrence rule representation.

### Reason

Recurrence has many edge cases.

Using a well-established rule model is preferable to inventing an ad hoc collection of weekly/monthly flags.

---

## D122 - Recurring events should use a rolling generation horizon

**Status: Planned**

Do not generate an effectively unlimited future series.

A working design target has been approximately several weeks, with around 21 days discussed as a reasonable initial horizon.

The exact horizon may remain configurable.

### Reason

A rolling horizon:

- avoids excessive speculative rows
- makes template edits easier to reason about
- supports future cancellation cleanly
- limits unnecessary scheduled actions
- naturally separates generated from not-yet-generated occurrences

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
    -> reusable role-request presets
    -> preset application
    -> preset lifecycle
    -> scheduled role-request opening
    -> organiser safety deadlines
    -> core message recovery

planned
    -> preset field editing
    -> full event templates
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

inactive child
    -> preserved configuration

option deactivation
    -> no hidden cascading group mutation
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
