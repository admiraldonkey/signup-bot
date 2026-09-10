# Holdfast Event Bot

A database-backed Discord event-management bot built for organised gaming communities, originally designed around regiment events in **Holdfast: Nations At War**.

The project replaces fragile reaction-based event sign-ups and manual organiser coordination with persistent event state, attendance tracking, organiser escalation, role requests, reusable role-request presets, reminders, audit logging, and durable scheduled work.

The bot is under active development and community testing. It is not presented as a generic production-ready SaaS product, but the codebase is deliberately structured around reliable domain behaviour, PostgreSQL-backed state, automated regression testing, and reusable subsystem boundaries.

## Why this project exists

Discord is an excellent interaction surface, but a Discord message is a poor place to store authoritative event state.

Messages can be deleted. Channels can change. Administrators can race with scheduled jobs. Users can click old buttons. Events can be edited after work has already been scheduled. A bot that treats the visible message as the source of truth quickly becomes difficult to reason about.

This project instead treats PostgreSQL as authoritative.

Discord messages are projections of persistent event state. Scheduled work is stored durably. User interactions re-check current database state before making changes. External Discord side effects are ordered around authoritative database decisions so stale operations do not quietly overwrite newer ones.

That design has become increasingly important as the project has grown from simple attendance buttons into event publication, organiser escalation, role-request scheduling, message recovery, reusable configuration, and concurrency-sensitive workflows.

## Current capabilities

### Event creation and lifecycle

Administrators can create and manage one-off events with:

- event type
- region and timezone
- event name and description
- start date and time
- configurable duration
- one or more ping roles
- optional attendance sign-ups
- configurable sign-up closure
- optional detailed-response deadlines
- optional primary and backup organisers
- immediate, manual, or scheduled publication
- automatic completion
- event editing after creation

Events are persistent database records before they are published.

Publication state is intentionally separate from event lifecycle state. An event may therefore be a real scheduled event in PostgreSQL while still being unpublished in Discord.

Supported lifecycle states include:

- `scheduled`
- `open`
- `closed`
- `cancelled`
- `completed`

Cancellation is final. Later scheduled work must not revive a cancelled event or replace its final state.

### Publication and message recovery

An event can be:

- published immediately when created
- created unpublished and published manually later
- scheduled for automatic publication relative to its start time

The intended publication channel is snapshotted onto the event so later changes to guild defaults do not unexpectedly move an already-configured event.

Manual and scheduled publication use database-backed race protection. If two publication attempts overlap, only one can become authoritative.

Where the destination is still known unambiguously, deleted event attendance messages and role-request group messages can be recreated. Recovery avoids replaying role pings and uses conditional linkage so concurrent recovery attempts cannot leave multiple messages authoritative.

If the destination channel itself is unavailable, the bot fails safely rather than guessing another location.

### Attendance sign-ups

Events can optionally expose attendance buttons for:

- Attending
- Tentative
- Not attending

Sign-up state is persisted independently of the Discord message.

Administrators can:

- inspect event responses
- close sign-ups
- reopen sign-ups where lifecycle rules permit it
- refresh the public event message

Events can also be created with sign-ups disabled. This is useful for announcement-oriented events where attendance collection is unnecessary.

### Actual attendance and reliability reporting

Signup intention and actual participation are separate concepts.

The bot can record actual attendance after an event and compare it with the earlier sign-up state. Administrators can:

- replace an event's recorded attendance
- add or remove individual attendees
- compare sign-ups with actual attendance
- inspect a member's attendance history
- identify attendance/sign-up mismatches

These reports are informational. A future participation-context model may provide richer distinctions between event roles, reserves, excused absence, observation, technical problems, or other legitimate cases.

### Organiser workflow

Events can optionally have a primary and backup organiser.

Organiser assignment is deliberately separate from event creation. The person who creates an event is not implicitly treated as its organiser.

For unpublished events, nominated organisers remain dormant until the workflow should become active. Normal activation occurs around publication, while event-start safety deadlines prevent very late publication from starting an obsolete response window.

The organiser workflow supports:

- primary organiser nomination
- backup organiser nomination
- confirmation and decline buttons
- configurable primary and backup response periods
- warning messages shortly before timeout
- escalation from primary to backup
- general cover requests when nominations fail
- claimable organiser cover
- a configurable safety deadline before event start
- urgent missing-organiser notification at event start
- cover claims after the event begins when the event still genuinely lacks an organiser
- reconciliation of previously-posted warning messages after the organiser state changes
- assignment history rather than destructive overwriting

Organiser assignment notifications can try Discord DM first and fall back to the configured private Event Administration channel.

The server can independently disable:

- the organiser subsystem
- organiser DM-first delivery

Disabling organiser functionality participates in the same database locking contract as organiser operations, preventing an in-flight organiser action from succeeding against stale feature configuration.

### Event role requests

Role requests are modelled as event-level domain data rather than message-level reactions.

An event can define logical role options such as:

- Captain
- Supervisor
- Gunner
- Carpenter

A role option may be:

- open to requests
- restricted to members with qualifying Discord roles
- capacity-limited

Qualification rules can distinguish between:

- fully qualified members
- members who may perform the role with supervision

Qualification and notification audience are separate concepts. A Discord role used to identify qualified members does not automatically become the role pinged when a request group opens.

Members may request multiple independent roles for the same event.

A request is an expression of willingness, not an assignment or guarantee of selection.

### Role-request groups

Role options can be presented through one or more request groups.

A group controls presentation and workflow concerns such as:

- which event role options it displays
- destination channel
- optional notification role
- whether a positive attendance signup is required
- opening time relative to event start
- closing time relative to event start

The same logical role option may appear in multiple groups.

Those groups share the same underlying volunteer pool. A member requesting Captain through one group has requested the event-level Captain option, not a separate group-specific copy.

Role requests are independent and multi-select rather than toggle-based. Explicit withdrawal is handled separately so an accidental repeat click cannot silently erase an existing request.

Attendance availability and role-request willingness are also distinct. For example, a retained role request can become unavailable while the member is marked Not Attending and become available again if their attendance state returns to an eligible value.

### Scheduled role-request groups

Preset-derived role-request groups can open and close automatically relative to event start.

The durable scheduler stores separate opening and closing actions.

Administrative lifecycle output distinguishes between:

- Planned
- Pending publication
- Open
- Closed

Changing an event's start time recalculates applicable future role-request windows.

Important distinctions are preserved:

- a planned group with an event-relative opening rule is rescheduled
- an already-published group is not artificially reopened
- a manually-created immediate group does not acquire a synthetic opening schedule
- closed groups remain closed
- authoritative rescheduling resets stale retry state

Discord publication performs its own current-state and permission checks. Persistent database configuration is not discarded merely because Discord publication temporarily fails.

### Reusable role-request presets

Guild administrators can create reusable role-request presets for event formats that repeatedly use the same role-request structure.

A preset can contain:

- reusable logical role options
- request restrictions
- capacities
- qualification-role snapshots
- supervision-required qualification rules
- multiple request groups
- ordered option mappings
- optional fixed channels
- apply-time default-channel resolution
- optional notification roles
- signup requirements
- event-relative opening and closing rules

Current preset commands support:

- creating a preset
- listing presets
- inspecting a complete preset definition
- adding role options
- adding request groups
- applying a preset to an existing event
- activating or deactivating a preset
- activating or deactivating individual preset role options
- activating or deactivating individual preset request groups

Applying a preset creates an **event-level snapshot**.

After application, runtime behaviour does not depend on the source preset. Later preset changes therefore do not modify events that already received that preset.

This allows each event to remain independently configurable and prevents reusable source configuration from becoming a live dependency for historical or already-scheduled events.

Preset application also creates the required durable role-request opening and closing actions in the same database transaction as the event-level snapshot.

Lifecycle controls are non-destructive:

- deactivating a preset prevents future application but preserves its children
- deactivating an option preserves qualification rows and group mappings
- deactivating a group preserves its option mappings and configuration
- reactivation restores the stored configuration
- existing event snapshots are unaffected

Deactivating an option can intentionally leave an active group with no active mapped options. The bot warns the administrator rather than silently changing neighbouring configuration. Preset application remains the final authoritative validator and rejects an unusable active configuration.

Editing existing preset fields and mappings is the next planned preset-management phase and is not yet exposed as a complete administrator workflow.

### Announcements and reminders

Administrators can send immediate event announcements and configure persistent reminders.

Reminders can be scheduled relative to:

- event start
- signup close

Multiple reminders can exist for the same event.

Pending reminder timing is recalculated when relevant event timing changes. Reminders that have become too late to be useful can be marked missed rather than delivered out of context.

Reminder definitions are stored independently from Discord messages and are executed by the durable scheduler.

### Audit trail

Administrative activity is recorded in PostgreSQL.

The audit system records structured information such as:

- guild
- actor
- action
- outcome
- target
- details
- timestamp

An optional Discord log channel can mirror useful administrative activity, but the database audit trail remains authoritative.

The `/audit recent` command provides a lightweight administrative view of recent actions.

## Reliability and architecture highlights

### PostgreSQL is authoritative

Discord state is treated as external and fallible.

When database state and Discord presentation disagree, the bot resolves behaviour from the database rather than assuming the visible message represents the current domain state.

### Durable scheduled work

Scheduled work is stored in PostgreSQL rather than only in process memory.

The scheduler currently coordinates work including:

- scheduled event publication
- attendance closure
- automatic event completion
- event reminders
- organiser warnings
- organiser timeouts
- organiser cover escalation
- organiser safety deadlines
- missing-organiser-at-start checks
- role-request group opening
- role-request group closing

Scheduler processing includes:

- persistent action state
- action claiming
- processing locks
- stale-lock recovery
- bounded retry with backoff
- terminal failure handling
- cancellation
- idempotent rescheduling
- stale-worker completion fencing

A worker that loses ownership of an action cannot later overwrite a newer retry or authoritative reschedule with stale completion state.

### Database-first concurrency control

Race-sensitive workflows use PostgreSQL locking and conditional updates rather than relying on Discord timing.

Examples include:

- manual publication racing scheduled publication
- organiser confirmation racing timeout
- organiser cover claims
- event cancellation racing scheduled work
- deleted-message recovery
- role-request publication
- preset application racing preset mutation

The project favours deterministic database ownership boundaries and authoritative re-checks over timing assumptions.

### Discord side effects are deliberately ordered

External calls cannot participate in PostgreSQL transactions.

The code therefore separates authoritative state transitions from Discord side effects and, where necessary, re-checks state after returning from Discord.

This is particularly important for publication, organiser notifications, recovery, and role-request messages.

### Snapshot semantics

Configuration that must remain stable for an existing event is generally copied into event-level state.

Examples include:

- publication destination
- ping-role snapshots
- organiser assignments
- applied role-request presets
- role qualification snapshots
- role-request group destinations and notification metadata

This keeps historical and already-configured events independent from later changes to reusable configuration.

### Timezones are explicit

Event input uses named IANA timezones.

Ambiguous or invalid local times around daylight-saving transitions are rejected rather than silently interpreted.

The authoritative event start is stored as an absolute timestamp while retaining the event timezone needed for display and editing.

## Technology stack

| Area                         | Technology                       |
| ---------------------------- | -------------------------------- |
| Runtime                      | Node.js                          |
| Language                     | TypeScript                       |
| Discord                      | discord.js 14                    |
| Database                     | PostgreSQL                       |
| ORM and schema               | Drizzle ORM                      |
| Migrations                   | drizzle-kit and Drizzle migrator |
| Date and timezone handling   | Luxon                            |
| Unit and integration testing | Vitest                           |
| Database integration testing | Testcontainers                   |
| Coverage                     | V8 coverage through Vitest       |
| Local database               | PostgreSQL 17 in Docker Compose  |
| Container deployment         | Docker                           |

The production container currently uses Node 22.

The exact dependency versions are defined in `package.json` and the lockfile.

## Testing

The project has an automated unit and PostgreSQL-backed integration test suite.

Integration tests use disposable real PostgreSQL instances through Testcontainers rather than replacing database behaviour with an in-memory approximation.

This matters because several important correctness properties depend on PostgreSQL itself, including:

- row locking
- transactions
- uniqueness constraints
- migration behaviour
- concurrency ordering
- scheduler claims
- race resolution

The normal full verification gate is:

```bash
npm run test:unit
npm run test:integration
npm run test:coverage
npm run typecheck
npm run typecheck:test
```

During development, focused tests are run first for faster feedback.

The project follows a regression-first approach for bugs and concurrency failures:

1. reproduce the problem
2. add a regression test that fails for the intended reason
3. implement the narrow production correction
4. add positive or companion coverage where useful
5. run the affected subsystem tests
6. run the complete verification gate before the work is considered ready

Failing regression code is normally demonstrated locally rather than committed as a permanent red revision.

Concurrency tests prefer deterministic database locks and controlled barriers over arbitrary sleeps.

Manual Discord smoke testing is still used when behaviour genuinely depends on Discord itself, particularly:

- slash-command registration
- Discord channel and role selectors
- permissions
- mentions
- DMs and fallback delivery
- deleted-message behaviour
- end-to-end button workflows

See [docs/TESTING-GUIDE.md](docs/TESTING-GUIDE.md) for the complete testing workflow.

## Running locally

### Prerequisites

You will need:

- Node.js and npm
- Docker with Docker Compose support
- a Discord bot token
- a Discord server where the bot can be installed and tested

The repository includes a local PostgreSQL 17 Compose service.

### 1. Clone the repository

```bash
git clone https://github.com/admiraldonkey/signup-bot.git
cd signup-bot
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create the environment file

Copy the example:

```bash
cp .env.example .env
```

The current configuration is:

```dotenv
DISCORD_TOKEN=
DATABASE_URL=postgresql://holdfast_bot:local_development_only@127.0.0.1:5432/holdfast_events
DATABASE_TLS=false
```

Set `DISCORD_TOKEN` to the token for your development bot.

The included database URL matches the local Docker Compose configuration.

`DATABASE_TLS=false` is appropriate for the included local database. Hosted PostgreSQL environments can enable TLS where required.

Do not commit a populated `.env` file.

### 4. Start PostgreSQL

```bash
docker compose up -d database
```

The database is exposed only on local loopback by the supplied Compose configuration.

### 5. Start the bot

```bash
npm run dev
```

On startup the application:

1. checks and applies versioned database migrations
2. logs into Discord
3. registers the current guild command definitions in connected guilds
4. starts the durable event scheduler

There is no separate application-ID or development-guild environment variable required by the current startup implementation.

### Production-style build

Compile TypeScript:

```bash
npm run build
```

Run the compiled application:

```bash
npm start
```

## Initial Discord setup

The bot must be initialised and configured for each Discord guild before event-management commands can be used.

The administrator-facing workflow begins with:

```text
/setup initialise
```

and then:

```text
/setup configure
```

Configuration includes the server's event administration role and default attendance and role-request channels.

Optional organiser configuration includes:

- organiser role
- private Event Administration channel
- organiser response timings
- warning timing
- general-cover safety timing

Additional setup commands configure regions, audit logging, feature controls, and status inspection.

See [docs/ADMIN-GUIDE.md](docs/ADMIN-GUIDE.md) for current command-level guidance.

## Command overview

The bot currently registers these top-level slash commands:

| Command        | Purpose                                                          |
| -------------- | ---------------------------------------------------------------- |
| `/ping`        | Check whether the bot is responding                              |
| `/dbcheck`     | Administrative PostgreSQL connectivity check                     |
| `/setup`       | Initialise and configure guild event management                  |
| `/event`       | Create, publish, edit, inspect, and administer events            |
| `/role-preset` | Create, inspect, apply, and manage reusable role-request presets |
| `/attendance`  | Record and analyse actual attendance                             |
| `/audit`       | Inspect recent administrative audit activity                     |

`/event` contains the majority of event-specific administration, including attendance response management, organisers, event-level role requests, reminders, announcements, publication, and lifecycle changes.

`/role-preset` manages reusable source configuration. Applying a preset copies its relevant configuration into an ordinary event.

The complete current command reference belongs in [docs/ADMIN-GUIDE.md](docs/ADMIN-GUIDE.md), not in this README.

## Database and migrations

The schema is defined in:

```text
src/db/schema.ts
```

Versioned migrations live in:

```text
drizzle/
```

After an intentional schema change, generate a migration with:

```bash
npm run db:generate
```

Generated SQL should be reviewed before it is applied.

The full migration chain is exercised by PostgreSQL-backed integration testing, and migrations are applied automatically during normal application startup.

Applied migrations should be treated as immutable history. A new correction should normally be represented by a new migration rather than rewriting a migration that may already exist in another environment.

PostgreSQL identifier length also matters when introducing long generated constraint names. Explicit constraint names should be used where generated names risk colliding after PostgreSQL's identifier truncation.

## Repository structure

```text
.
├── docs/
├── drizzle/
├── src/
│   ├── attendance/
│   ├── audit/
│   ├── auth/
│   ├── commands/
│   ├── db/
│   ├── discord/
│   ├── events/
│   ├── interactions/
│   ├── organisers/
│   ├── reminders/
│   ├── role-requests/
│   ├── scheduler/
│   ├── time/
│   └── index.ts
├── tests/
│   ├── integration/
│   ├── support/
│   └── unit/
├── compose.yaml
├── Dockerfile
├── package.json
└── README.md
```

The directory structure reflects domain and infrastructure boundaries rather than putting all Discord interaction logic into one command file.

Not every subsystem has reached its final shape. Some older command modules remain larger than ideal, and reducing unnecessary coupling remains an ongoing goal.

## Development principles

The project currently follows several recurring engineering principles.

### Preserve domain behaviour over message behaviour

A Discord message should not define whether an event, signup, organiser assignment, or role request exists.

### Prefer explicit state

Important transitions should be represented directly in persistent data rather than inferred from the presence or absence of a message.

### Re-check after races

An operation that was valid before waiting on a lock or external API call may no longer be valid afterwards.

### Keep scheduled work durable

A process restart should not erase future publication, reminder, escalation, closure, or completion work.

### Keep cancellation final

Old scheduled work must become harmless once an event is cancelled.

### Use narrow service boundaries

Command handlers should coordinate Discord input and output.

Reusable domain and persistence behaviour should increasingly live in services that can be exercised directly by integration tests and potentially reused from another interface.

### Avoid speculative abstraction

Portability matters, but abstractions are introduced when they improve real boundaries and clarity rather than merely making the code look more framework-like.

### Treat tests as behavioural documentation

Regression tests are used to preserve non-obvious race handling and domain invariants, particularly where a superficially simpler refactor could reintroduce an earlier bug.

## Current development status

The following substantial areas are implemented:

- persistent event lifecycle
- immediate and scheduled publication
- optional attendance sign-ups
- actual attendance tracking and comparison
- organiser nomination and escalation
- organiser feature controls
- organiser safety deadlines and cover workflow
- event reminders and announcements
- event-level role requests
- qualification and supervision rules
- durable role-request opening and closing
- core Discord message recovery
- reusable role-request presets
- preset application with snapshot semantics
- reversible preset, option, and group lifecycle controls
- PostgreSQL-backed audit logging
- durable scheduled actions
- automated unit and integration testing

### Immediate development direction

The next planned area is **editing existing reusable role-request presets**.

The current preset subsystem can create and deactivate or reactivate configuration, but a complete administrator workflow for editing existing preset metadata, option definitions, qualification rules, group settings, and group-option mappings is not yet implemented.

### Event templates

Event templates are planned after preset administration is complete.

There is early template-related schema scaffolding in the repository, but this should not be mistaken for a complete template feature.

The intended direction is for a template to provide reusable defaults such as:

- event type
- region
- timezone
- duration
- publication timing
- signup behaviour
- ping roles
- organiser defaults
- role-request configuration
- reminder defaults

Generated occurrences should become ordinary independent events.

Template-derived configuration should be snapshotted so an administrator can customise an individual occurrence without changing the template or neighbouring events.

Later template edits should affect newly generated occurrences rather than silently rewriting events that already exist, unless a separate explicit propagation feature is designed in the future.

### Recurring events

Recurring event generation is also planned rather than currently available.

The current design direction includes:

- standards-based recurrence representation, likely RFC 5545 compatible rules
- a rolling future-generation horizon rather than unbounded event creation
- immutable occurrence identity separate from mutable event start time
- ordinary event rows for generated occurrences
- independent editing and cancellation of individual occurrences

These decisions are architectural direction, not claims of implemented functionality.

## Portability

Although the project originated around one Holdfast community, the architecture is deliberately moving towards reusable event-management boundaries.

Potentially portable areas include:

- event lifecycle services
- attendance state
- organiser escalation
- role-request modelling
- reusable role-request presets
- reminder scheduling
- durable scheduled actions
- audit concepts

Portability does **not** mean copying this repository's migrations or database schema blindly into another bot.

A future integration should map:

- guild identity
- user identity
- event identity
- event lifecycle
- permissions
- destination channels
- existing community data

into the host application's model and create migrations for that destination deliberately.

Discord remains the primary interaction surface for this project. A future web or community portal could consume the same underlying domain services where collaboration makes that worthwhile.

## Deployment

The application is containerised and designed to run as a persistent Node.js service with PostgreSQL.

The current project deployment uses Northflank with PostgreSQL-backed persistent state.

The durable scheduler does not depend on one uninterrupted process lifetime for its future work. Scheduled actions remain in PostgreSQL and can be recovered after process restart according to their stored state and locking rules.

Deployment credentials and environment-specific secrets do not belong in the repository.

## Security and privacy considerations

The bot stores operational Discord identifiers and event-management data required for its workflows.

The design avoids treating transient Discord message content as the sole source of truth.

Administrative operations use configured Discord permissions and event-administration roles.

Audit information is intended for administrative accountability and debugging rather than public exposure.

Secrets such as:

- Discord bot tokens
- database credentials
- hosted service credentials

must be supplied through environment configuration and must not be committed.

## Documentation

More detailed project documentation is available in:

- [Architecture](docs/ARCHITECTURE.md)  
  Current subsystem design, data flow, persistence, scheduling, concurrency, and structural boundaries.

- [Decisions](docs/DECISIONS.md)  
  Durable product and engineering decisions, including the reasons behind non-obvious invariants.

- [Roadmap](docs/ROADMAP.md)  
  Planned work separated from functionality that already exists.

- [Current Work](docs/CURRENT-WORK.md)  
  The current development checkpoint and handoff context.

- [Testing Guide](docs/TESTING-GUIDE.md)  
  Automated and manual testing workflow, regression practices, PostgreSQL integration tests, and verification gates.

- [Administrator Guide](docs/ADMIN-GUIDE.md)  
  Current Discord setup, commands, workflows, and administrator-facing behaviour.

When documentation and implementation appear to disagree, `docs/DECISIONS.md` should be checked before simplifying behaviour. Some apparently unusual implementation choices exist specifically to preserve concurrency, recovery, or domain guarantees established by earlier regressions.

## Licence

The package is currently marked:

```text
UNLICENSED
```

Public repository visibility does not itself grant a licence to copy, modify, or redistribute the software.

A formal open-source licence can be added later if the project owner chooses to make those permissions explicit.
