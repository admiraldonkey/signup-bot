# Project Decisions and Domain Invariants

## Purpose

This document records important product and architectural decisions which may not be obvious from examining the source code alone.

Some behaviours may appear unnecessarily complicated when viewed without their original design context.

This document exists to prevent a future developer, collaborator, or AI assistant from "simplifying" deliberate behaviour into something incorrect.

When one of these decisions changes, update this document and record why.

---

# D001 - PostgreSQL is the authoritative source of event state

Discord messages are projections of database state.

The application must not rely on the current contents of a Discord message as the authoritative source of:

- Event status
- Publication status
- Attendance state
- Organiser state
- Role requests
- Scheduling state

Where practical, Discord messages should be rebuildable from database state.

### Reason

Discord messages may be:

- Deleted
- Manually edited
- Temporarily inaccessible
- Located in channels which are later removed

Durable application state must survive those failures.

---

# D002 - Publication and event lifecycle status are separate concepts

Do not add `draft` to the main event status enum merely to represent an unpublished event.

Current lifecycle statuses are:

```text
scheduled
open
closed
cancelled
completed
```

Publication is represented separately by:

```text
publishedAt
```

Therefore:

```text
publishedAt = null
```

means the event has not yet been publicly announced.

### Reason

An event can be internally scheduled and valid while still being privately prepared.

Publication and lifecycle state are independent dimensions.

---

# D003 - Unpublished events are real persistent events

An unpublished event is not merely a temporary command form.

It receives a normal event ID and may already be used for:

- Organiser assignment
- Event editing
- Role-option configuration
- Early/private role requests
- Scheduling
- Future template-generated preparation

### Reason

Administrators need stable event identity before public announcement.

---

# D004 - Templates should eventually generate unpublished occurrences

Recurring/template events should eventually use a flow similar to:

```text
Template
    |
    v
Generate occurrence internally
    |
    +---- assign organiser
    |
    +---- run early/private role planning
    |
    +---- allow admin edits
    |
    v
Scheduled public publication
```

### Reason

Event preparation frequently begins before members should receive the normal announcement.

---

# D005 - Scheduled publication must be durable

Automatic publication uses the persistent scheduler.

Current scheduler action key:

```text
publish_event
```

Do not implement important future publication behaviour with a simple in-memory `setTimeout()`.

### Reason

Publication must survive:

- Bot restarts
- Deployments
- Process crashes

---

# D006 - Manual publication overrides scheduled publication

An administrator may publish a scheduled event early using:

```text
/event publish
```

After successful manual publication, the outstanding scheduled publication action becomes obsolete and must not publish the event again.

---

# D007 - Signup events must be published before signup closure

A signup-enabled event must not be scheduled to publish:

- After signup closure
- At exactly the same instant as signup closure

### Reason

Members require a meaningful opportunity to respond.

Publishing and closing simultaneously also creates an unnecessary scheduler race.

---

# D008 - Publication destination is snapshotted onto the event

Events store their intended publication channel.

Do not rely solely on the guild's current default when publication eventually occurs.

### Reason

Changing a server default should not silently move an already-created or already-scheduled event announcement.

---

# D009 - Organiser countdown begins when the event is published

Assigning a primary organiser to an unpublished event does **not** immediately activate the organiser.

Activation occurs when the event becomes public.

Only then should the application:

- Set `activatedAt`
- Calculate a response deadline
- Schedule organiser warning/timeout actions
- Send the organiser confirmation request

### Reason

The organiser's operational responsibility should begin when the event becomes public, not at an arbitrary internal creation time.

---

# D010 - Event creator and event organiser are separate concepts

The administrator who creates an event is not automatically assumed to organise it.

The system should preserve separate concepts for:

```text
Event creator
Primary organiser
Backup organiser
Cover organiser
```

---

# D011 - Organiser escalation should use one coherent workflow

Current escalation is:

```text
Primary
    |
    +---- decline/timeout
            |
            v
         Backup
            |
            +---- decline/timeout
                    |
                    v
                Cover request
```

Future "confirmed organiser is no longer available" behaviour should feed back into the same escalation infrastructure.

Do not build an unrelated replacement mechanism.

---

# D012 - Organiser automation should eventually be server-disableable

Not every Discord server will necessarily want automatic organiser management.

Planned server-level settings should distinguish concepts such as:

```text
organisersEnabled
organiserEscalationEnabled
```

Possible behaviour:

```text
organisersEnabled = false
    -> organiser workflow disabled

organisersEnabled = true
organiserEscalationEnabled = false
    -> assignment and confirmation supported
    -> decline/unavailability requires manual admin handling

organisersEnabled = true
organiserEscalationEnabled = true
    -> full Primary -> Backup -> Cover automation
```

Even where organisers are enabled globally, assigning an organiser should remain optional per event.

---

# D013 - Logical role options belong to events, not request messages

A role such as:

```text
Captain
```

exists once as an event-level role option.

Discord request groups/messages reference that logical role.

Do not create separate role identities merely because the role appears in several messages.

---

# D014 - Role-request groups are presentation/audience containers

A role-request group controls where and how logical event roles are exposed.

It does **not** own the underlying role request.

This permits:

```text
Early private Captain request
+
Later public Captain request
```

to share one underlying Captain volunteer pool.

---

# D015 - Role requests are independent and multi-select

Members may express interest in several roles simultaneously.

Do not restore the previous ranked-preference model without an explicit product decision.

Current logical uniqueness:

```text
event + user + role option
```

Not:

```text
event + user + preference rank
```

---

# D016 - A role request is not an allocation

Requesting a role records willingness or interest.

It does not guarantee that the member will perform that role.

Actual assignment remains a human organiser decision.

Any future UI wording must preserve this distinction.

---

# D017 - Role buttons are not toggles

Clicking a role already requested should not withdraw the request.

Current intended behaviour:

```text
First click
    -> add request

Repeated click
    -> no database change
    -> tell member the request already exists
```

Withdrawal happens through:

```text
Manage My Requests
```

### Reason

Explicit withdrawal prevents accidental loss of queue/request position.

---

# D018 - Withdraw and re-request creates a new queue position

If a member withdraws a role request and later requests it again:

- The old request remains deleted
- A new request is created
- The new `createdAt` becomes its request time

The member therefore returns to the back of the request order.

---

# D019 - Qualification and notification audience are separate concepts

Do not use notification targeting as a substitute for eligibility.

Example:

```text
Who may request Captain?
    -> qualification rules

Who should receive the Captain-request announcement?
    -> notification/audience configuration
```

These must remain independently configurable.

---

# D020 - Qualification supports full and supervised states

Current qualification model includes:

```text
qualified
supervision_required
unqualified
```

Example:

```text
Flag Captain
    -> fully qualified

Midshipman
    -> supervision required
```

A supervision-required member may still be eligible to express interest in a `qualified_only` role.

The organiser must be shown that supervision is required.

---

# D021 - Discord roles indicate current qualification, not immutable history

Qualification is generally evaluated against a member's current Discord roles.

A Discord role can indicate current eligibility, but should not be treated as permanent historical truth.

Role-name snapshots exist so historical configuration remains understandable after a Discord role is renamed or deleted.

---

# D022 - Signup gating is configured per role-request group

A request group may require a member to currently be:

```text
Attending
or
Tentative
```

before submitting a new request.

Other groups may deliberately permit role requests without attendance signup.

### Reason

Early/private planning may take place before the public attendance message even exists.

---

# D023 - Do not enumerate the entire guild as fallback volunteers

Organiser role-request views may suggest other potentially suitable members.

Those fallback candidates should normally be limited to relevant signed-up members who:

- Are Attending or Tentative
- Meet the qualification rules
- Have not already requested that role

For early/no-signup request groups, do not enumerate thousands of members just because they happen to hold a qualification role.

The early view should primarily show actual volunteers.

---

# D024 - Role willingness and attendance availability are separate

A role request records willingness.

Attendance determines whether that willingness is currently actionable.

Desired semantics:

```text
Attending
    -> available

Tentative
    -> available but uncertain

Not Attending
    -> request retained
    -> unavailable

No signup
    -> may remain usable where the relevant workflow permits it
```

Changing to Not Attending should not automatically destroy a request.

Returning to Attending should reactivate the original request without resetting its original timestamp.

---

# D025 - Role-request groups may remain open after event start

Some role-request workflows should remain open for several minutes after an event begins.

The internal signed-offset convention is:

```text
positive value = minutes before start
zero           = event start
negative value = minutes after start
```

User-facing commands should expose explicit before/after options rather than expecting administrators to enter negative numbers.

---

# D026 - Event subtypes are not currently a separate database model

Do not introduce an `event_subtypes` table merely to represent concepts such as:

```text
Regular naval
Internal naval
Competitive naval
```

until actual requirements justify it.

Templates can initially represent recurring/configuration variants.

---

# D027 - Actual attendance and signup intention are separate datasets

Do not overwrite signup responses based on actual attendance.

Do not infer actual attendance merely because somebody signed up.

Both pieces of information are useful:

```text
Signup
    -> intention

Actual attendance
    -> outcome
```

---

# D028 - Attendance discrepancies are informational

The bot should not automatically punish users based on:

- No-shows
- Walk-ins
- Not Attending discrepancies
- Reliability history

Reports exist to support human judgement.

---

# D029 - Non-playing attendance must eventually be distinguishable

Future actual-attendance records should support event-specific participation context.

Initial planned categories:

```text
participant
supervisor
organiser
server_admin
other
```

A supervisor/admin may count as present without being treated as a signup walk-in.

---

# D030 - Discord roles may suggest participation type but are not authoritative

A member having an officer/admin role does not prove that they were acting in that capacity during a particular event.

Participation context belongs to the event attendance record.

Discord roles may be used as hints or defaults, not unquestionable truth.

---

# D031 - No-signup events do not generate signup reliability issues

Actual attendance may still be recorded for a no-signup event.

However, that event must not produce:

- No-show discrepancies
- Walk-in discrepancies
- Signup reliability statistics

because no signup obligation existed.

---

# D032 - Durable work belongs in the scheduler

Important future operations should use persistent scheduled actions.

Do not implement important workflows using only:

```ts
setTimeout(...)
```

Short refresh/debounce timers remain acceptable where losing the timer on restart has no effect on authoritative state.

---

# D033 - Scheduler operations should be idempotent where practical

Scheduled execution must defensively handle cases where:

- An administrator already performed the action manually
- Another execution path won a race
- The event was cancelled
- The event was completed
- The event was deleted
- The target state was already reached

Scheduling helpers should generally update/reschedule existing actions rather than create duplicates.

---

# D034 - Database audit logs are authoritative

Discord audit-channel messages are convenience mirrors.

Disabling Discord mirroring must not disable the database audit trail.

---

# D035 - Runtime feature flags are preferred over dynamic slash-command registration

Future guild settings may include:

```text
organisersEnabled
organiserEscalationEnabled
roleRequestsEnabled
attendanceReportingEnabled
```

Commands may remain registered and respond with a clear "feature disabled" message.

This is preferred over constantly changing the registered command set for each guild configuration.

---

# D036 - Role requests may also be controlled by event type

The schema already supports event-type-level role-request configuration.

Desired layered behaviour is approximately:

```text
Guild role requests enabled
AND
Event type role requests enabled
AND
The event actually has role-request configuration
```

---

# D037 - Portability is an actual project requirement

Some functionality may be migrated into another community bot.

The code should increasingly separate:

```text
Discord command parsing
Domain/business logic
Database persistence
Discord rendering/notifications
Scheduling
```

High-value functionality should not require copying the entire `/event` command implementation.

---

# D038 - Database migrations must not be blindly copied between bots

If functionality moves to another bot:

1. Inspect the destination schema
2. Map event identity
3. Map guild identity
4. Map user identity
5. Map event lifecycle
6. Map scheduling
7. Map attendance/organiser state
8. Adapt the domain/service layer
9. Write destination-specific migrations

This project's migrations are implementation history, not a portable integration contract.

---

# D039 - Prefer collaboration with the existing community portal over unnecessary duplication

Another community bot already provides portal/reporting functionality.

If collaboration proceeds, extending the existing portal may be preferable to creating a competing portal.

The goal is complementary functionality rather than duplicating systems for the sake of owning another codebase.

---

# D040 - Public Discord UI may change without changing domain semantics

Current Discord event messages are functional and intentionally not considered the final visual design.

Future migration to newer Discord UI/components should not require rewriting:

- Event lifecycle
- Attendance records
- Organiser state
- Role requests
- Scheduler behaviour

Rendering should remain separate from underlying domain state.

---

# D041 - Historical snapshots are useful

Where Discord entities may later disappear or be renamed, retain useful human-readable snapshots where practical.

Examples:

```text
roleNameSnapshot
displayNameSnapshot
```

Discord IDs remain authoritative identity where available.

---

# D042 - Time input must be explicit and timezone-aware

Use IANA timezone identifiers.

Examples:

```text
Europe/London
America/New_York
```

Ambiguous daylight-saving local times should be rejected rather than guessed.

Persist absolute timestamps while retaining event timezone for later interpretation/editing.

---

# D043 - Avoid hidden destructive behaviour

Administrative operations should make destructive state changes explicit.

Examples:

- Cancellation is a deliberate final state
- Role-request withdrawal is explicit
- Publication is immediate, scheduled, or manual
- Supplying ping roles during event editing replaces the existing configured role set

The bot should favour understandable transitions over clever implicit behaviour.

---

# D044 - Event cancellation must make future scheduled work harmless

Cancelling an event should make outstanding scheduled work irrelevant.

Pending actions should be cancelled where appropriate.

Scheduler execution must also defensively check event state.

This protects against stale actions publishing or modifying a cancelled event.

---

# D045 - Event completion must not overwrite cancellation

Cancellation is a final administrative state.

An automatic completion action must not later convert:

```text
cancelled
```

into:

```text
completed
```

---

# D046 - Publication should activate dormant organiser state atomically with event publication where practical

A primary organiser may be configured before an event is public.

Publication should:

1. Claim the unpublished event
2. Persist the publication state
3. Link the Discord event message
4. Activate the dormant primary organiser
5. Create organiser warning/timeout work
6. Send organiser notification

The system should avoid a public event existing indefinitely while the organiser assignment remains unintentionally dormant.

---

# D047 - Early role requests require persistent event IDs before public publication

The early Captain/Supervisor workflow depends on the event existing internally first.

Therefore do not return to a model where `/event create` must always immediately post the public event message.

---

# D048 - Request order is meaningful but not an automatic selection rule

Role requests are displayed in creation order because timing can be useful to organisers.

However:

```text
first request
```

does **not** automatically mean:

```text
member must receive the role
```

Organisers retain discretion.

---

# D049 - Qualification rules should remain configurable rather than hardcoded around current regiment role names

Concepts such as:

```text
Flag Captain
Midshipman
```

are examples of current community usage.

The application should store Discord role IDs and qualification level rather than hardcoding those names into business logic.

This preserves portability to other servers.

---

# D050 - The codebase should favour incremental refactoring over speculative rewrites

The project is functional and actively tested.

Refactoring should focus on concrete benefits such as:

- Better testability
- Reduced duplication
- Portability
- Safer lifecycle behaviour
- Smaller command handlers
- Clearer domain boundaries

Avoid replacing working subsystems merely to adopt fashionable architecture patterns.
