# Holdfast Event Bot

A PostgreSQL-backed Discord event management bot for organised gaming communities, originally built for regiment events in **Holdfast: Nations At War**.

The project replaces reaction based signups and manual event coordination with persistent event state, attendance tracking, organiser workflows, role requests, reusable configuration, reminders, audit logging, and durable scheduled work.

> **Project status:** actively developed and used for real community workflows.
> Current major development phase: **Event Templates (P1)**.

---

## At a glance

| Area                         | Current approach                          |
| ---------------------------- | ----------------------------------------- |
| Runtime                      | Node.js                                   |
| Language                     | TypeScript                                |
| Discord API                  | discord.js 14                             |
| Database                     | PostgreSQL                                |
| ORM/schema                   | Drizzle ORM                               |
| Migrations                   | drizzle-kit                               |
| Timezones                    | Luxon / IANA timezone IDs                 |
| Unit testing                 | Vitest                                    |
| Database integration testing | Vitest + Testcontainers + real PostgreSQL |
| Coverage                     | V8 coverage through Vitest                |
| Deployment                   | Docker / Northflank                       |
| State model                  | PostgreSQL authoritative                  |
| Scheduled work               | Durable PostgreSQL-backed scheduler       |

---

## Why this project exists

Discord is a useful interaction surface, but a Discord message is a poor database.

Messages can be deleted. Channels and roles can disappear. Administrators can race with scheduled jobs. Users can click stale buttons. An event can change after future work has already been scheduled.

The bot therefore treats PostgreSQL as the source of truth.

```text
Discord
    |
    | commands / buttons / messages
    v
application services
    |
    v
PostgreSQL
    |
    +---- event state
    +---- attendance
    +---- organiser assignments
    +---- role requests
    +---- reminders
    +---- audit history
    +---- durable scheduled work
```

Discord messages are projections of persistent state rather than the state itself.

That distinction drives much of the project's architecture.

---

# Engineering highlights

## Durable scheduler

Future work is persisted in PostgreSQL rather than existing only as process timers.

Scheduled workflows include:

- event publication
- signup closure
- event completion
- reminders
- organiser warnings/timeouts
- organiser cover escalation
- organiser safety deadlines
- missing-organiser-at-start checks
- role-request group opening
- role-request group closing

Scheduler reliability includes:

- action claiming
- processing ownership
- stale-lock recovery
- bounded retry/backoff
- stale-worker fencing
- cancellation ownership
- deterministic PostgreSQL-backed race tests

A process restart therefore does not erase future scheduled work.

---

## Snapshot semantics

Reusable configuration is generally copied into event-owned state when stability matters.

Examples include:

- publication destination
- ping roles
- organiser assignments
- applied role-request presets
- qualification-role snapshots
- request-group destinations
- request-group notification-role collections

This prevents later reusable-configuration changes from rewriting events that already exist.

The same principle is also used by event templates: reusable template state is snapshotted into ordinary event-owned state when an occurrence is generated.

---

## Concurrency as a domain concern

Several workflows can race legitimately:

```text
administrator action
scheduled action
Discord interaction
recovery process
```

The codebase uses PostgreSQL locks, uniqueness constraints, transactions, ownership checks, and post-side-effect revalidation where appropriate.

Concurrency tests favour deterministic locks and controlled interleavings rather than timing sleeps.

---

## Discord failure does not redefine domain state

Discord state is treated as external and fallible.

Examples:

```text
deleted event message
    -> rebuild where destination remains authoritative

deleted admin channel
    -> preserve organiser state
    -> record definitive delivery failure

deleted organiser ping role
    -> keep claimable admin message
    -> post without ping

unexpected Discord error
    -> preserve retry/error behaviour
```

The bot does not guess replacement destinations or broaden an intended audience to `@everyone`.

---

## Regression-first reliability

For concrete defects:

```text
reproduce
    |
    v
failing regression
    |
    v
narrow correction
    |
    v
targeted verification
    |
    v
full gate
```

Tests are treated as behavioural documentation for non-obvious race handling and lifecycle guarantees.

---

# Current capabilities

## Events

Administrators can create persistent events with:

- event type
- region
- timezone
- name and description
- start date/time
- configurable duration
- ping roles
- optional attendance signup
- signup closure
- optional detailed-response deadlines
- primary/backup organiser nominees
- immediate, manual, or scheduled publication
- automatic completion

Supported event lifecycle states include:

```text
scheduled
open
closed
cancelled
completed
```

Publication state is separate from event lifecycle state.

An event can exist authoritatively in PostgreSQL before it is publicly posted to Discord.

---

## Attendance signups

Events can expose:

- Attending
- Tentative
- Not attending

Signup state is persisted independently from Discord presentation.

Administrators can inspect responses, close or reopen signups where lifecycle rules permit, and refresh public event presentation.

Events may also disable signup entirely for announcement-oriented use cases.

---

## Actual attendance

Actual participation is stored separately from signup intention.

Administrators can:

- replace an event's attendance record
- add/remove individual attendees
- compare signups with actual attendance
- inspect member attendance history
- identify no-shows and walk-ins

Future work may add richer participation context such as organiser, supervisor, participant, or support roles.

---

## Organiser workflow

Events can have optional primary and backup organisers.

The organiser subsystem supports:

- dormant unpublished-event nominees
- confirmation and decline
- configurable response windows
- pre-timeout warnings
- backup escalation
- general cover
- claimable cover messages
- safety deadline before event start
- urgent missing-organiser-at-start handling
- assignment history
- warning/message reconciliation
- DM-first assignment notification
- private Event Administration fallback
- guild-level organiser feature control
- guild-level organiser-DM control

The event creator is not implicitly the organiser.

Organiser state remains authoritative in PostgreSQL even when Discord notification presentation degrades.

---

## Event role requests

Events can define logical volunteer options such as:

- Captain
- Supervisor
- Gunner
- Carpenter

Options can support:

- open requests
- Discord-role qualification
- supervision-required qualification
- capacity metadata

Requests are independent and multi-select.

A repeat click does not implicitly erase an existing request. Withdrawal is explicit.

Qualification and notification audience are separate concepts.

---

## Role-request groups

Role options can be presented through reusable event-level groups controlling:

- displayed options
- destination channel
- up to four ordered notification roles
- attendance requirement
- opening time
- closing time

The same logical option can appear in multiple groups while sharing one event-level volunteer pool.

Groups can open and close automatically relative to event start through durable scheduler actions.

---

## Reusable role-request presets

Guild administrators can build reusable role-request definitions.

Presets support:

- reusable logical options
- display names/descriptions
- request restrictions
- capacities
- qualification roles
- supervision-required qualifications
- multiple request groups
- ordered option mappings
- fixed or apply-time-default channels
- ordered notification-role collections
- signup requirements
- event-relative opening/closing rules
- reversible preset/option/group lifecycle controls

Preset administration supports creation, inspection, editing, lifecycle changes, and application to existing events.

Applying a preset creates event-owned state.

```text
preset
    |
    | apply
    v
event-level role-request snapshot
```

Later preset changes do not rewrite events that already received the preset.

---

## Event templates

Administrators can build and maintain reusable event templates covering:

- core event defaults
- optional audience/region
- timezone and normal local start time
- duration and signup behaviour
- manual, scheduled, or immediate publication intent
- fixed or generation-time-default publication destination
- ordered ping roles
- optional primary/backup organiser defaults
- reusable reminder definitions
- an optional role-request preset

The `/template` command supports creation, inspection, editing, lifecycle management, reminder administration, and one-off event generation.

Generated occurrences become ordinary independent events. Later template changes affect future generation rather than rewriting events that already exist.

One-off generation resolves the occurrence in the template timezone, snapshots the complete reusable source graph transactionally, and uses the normal event publication path after commit where immediate publication is requested.

---

## Reminders and announcements

Administrators can send event announcements and schedule persistent reminders.

Reminder timing can currently reference:

- event start
- signup close

Multiple reminders can exist per event.

Relevant pending timing is recalculated when event timing changes.

Reminder definitions live in PostgreSQL and are executed through the durable scheduler.

---

## Audit trail

Administrative activity is recorded in PostgreSQL with structured information including:

- guild
- actor
- action
- outcome
- target
- details
- timestamp

An optional Discord audit-log channel can mirror useful activity.

The database audit trail remains authoritative.

`/audit recent` provides a lightweight Discord view of recent activity.

---

# Architecture overview

The broad runtime shape is:

```text
Discord command / component
        |
        v
command or interaction adapter
        |
        v
domain/application service
        |
        v
PostgreSQL transaction
        |
        +---- authoritative state
        |
        +---- durable future actions
        |
        v
Discord side effect
        |
        v
revalidation / persistence / reconciliation where required
```

Not every workflow uses every step, but authoritative database decisions are deliberately separated from Discord presentation.

For the complete current architecture, see:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/DECISIONS.md](docs/DECISIONS.md)

---

# Technology stack

| Area                 | Technology                           |
| -------------------- | ------------------------------------ |
| Runtime              | Node.js                              |
| Language             | TypeScript                           |
| Discord API          | discord.js 14                        |
| Database             | PostgreSQL                           |
| ORM/schema           | Drizzle ORM                          |
| Migrations           | drizzle-kit + Drizzle migrator       |
| Date/time            | Luxon                                |
| Unit tests           | Vitest                               |
| Integration tests    | Vitest + Testcontainers              |
| Coverage             | V8                                   |
| Local DB             | PostgreSQL 17 through Docker Compose |
| Container deployment | Docker                               |

The production container currently uses Node 22.

Exact dependency versions are defined by `package.json` and the lockfile.

---

# Testing

The project uses both unit tests and PostgreSQL-backed integration tests.

Real PostgreSQL matters because key behaviour depends on:

- row locking
- transactions
- uniqueness constraints
- migration behaviour
- scheduler claims
- concurrency ordering
- race resolution

The normal full verification gate is:

```bash
npm run test:unit
npm run test:integration
npm run test:coverage
npm run typecheck
npm run typecheck:test
git diff --check
```

During development, focused tests run first.

Manual Discord smoke testing is reserved for behaviour that genuinely depends on Discord, such as:

- slash-command registration
- components
- channel/role selectors
- permissions
- mentions
- DMs
- deleted Discord objects
- end-to-end button flows

See [docs/TESTING-GUIDE.md](docs/TESTING-GUIDE.md).

---

# Running locally

## Prerequisites

You will need:

- Node.js and npm
- Docker with Docker Compose
- a Discord bot token
- a Discord server suitable for development/testing

The repository includes a PostgreSQL 17 Docker Compose service.

---

## 1. Clone

```bash
git clone https://github.com/admiraldonkey/signup-bot.git
cd signup-bot
```

---

## 2. Install dependencies

```bash
npm install
```

---

## 3. Configure the environment

Copy:

```bash
cp .env.example .env
```

The local shape is:

```dotenv
DISCORD_TOKEN=
DATABASE_URL=postgresql://holdfast_bot:local_development_only@127.0.0.1:5432/holdfast_events
DATABASE_TLS=false
```

Set `DISCORD_TOKEN` for the development bot.

Do not commit populated environment files or secrets.

---

## 4. Start PostgreSQL

```bash
docker compose up -d database
```

---

## 5. Start development

```bash
npm run dev
```

Startup:

1. applies versioned database migrations
2. logs into Discord
3. registers guild commands for connected guilds
4. starts the durable scheduler

---

## Production-style build

```bash
npm run build
npm start
```

---

# Initial Discord setup

A guild must be initialised/configured before event-management commands are used.

Start with:

```text
/setup initialise
```

then:

```text
/setup configure
```

Configuration covers the server's administrative role and default event/role-request destinations.

Optional organiser configuration includes:

- Event Organiser role
- private Event Administration channel
- organiser response timings
- warning timing
- cover safety timing

Additional setup commands manage regions, audit logging, features, and status.

See [docs/ADMIN-GUIDE.md](docs/ADMIN-GUIDE.md) for the full operational reference.

---

# Command overview

Current top-level commands include:

| Command        | Purpose                                                  |
| -------------- | -------------------------------------------------------- |
| `/ping`        | Basic bot response check                                 |
| `/dbcheck`     | Administrative PostgreSQL connectivity check             |
| `/setup`       | Initialise and configure guild event management          |
| `/event`       | Create, publish, edit, and administer events             |
| `/role-preset` | Manage reusable role-request presets                     |
| `/template`    | Manage reusable event templates and generate occurrences |
| `/attendance`  | Record and analyse actual attendance                     |
| `/audit`       | Inspect recent administrative audit activity             |

`/event` contains most event-specific administration, including organiser, reminder, attendance-response, publication, and event-level role-request workflows.

The detailed command reference belongs in [docs/ADMIN-GUIDE.md](docs/ADMIN-GUIDE.md).

---

# Database and migrations

Schema source:

```text
src/db/schema.ts
```

Versioned migrations:

```text
drizzle/
```

After an intentional schema change:

```bash
npm run db:generate
```

Review generated SQL before committing it.

Existing applied migrations should not be edited retroactively.

The migration chain is exercised through PostgreSQL-backed integration testing.

---

# Repository structure

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
│   ├── templates/
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

---

# Development principles

## Preserve domain behaviour over message behaviour

Discord presentation should not define whether an event, signup, organiser assignment, reminder, or role request exists.

---

## Prefer explicit persistent state

Important transitions should be represented directly rather than inferred from whether a Discord message happens to exist.

---

## Use narrow service boundaries

Command handlers should coordinate Discord input/output.

Reusable domain and persistence behaviour should live in services where that improves testability, concurrency reasoning, or portability.

---

## Avoid speculative abstraction

The project aims for professional, portable boundaries without introducing framework layers solely to make the architecture look elaborate.

Abstraction should solve a real problem.

---

## Treat regressions as documentation

Non-obvious concurrency and lifecycle behaviour should be protected by tests so future refactoring cannot casually reintroduce previously-understood failures.

---

# Current development phase

The core event-management, reusable role-request, and one-off event-template workflows are established.

The completed one-off template milestone includes:

- reusable template creation and inspection
- active/inactive lifecycle
- core template editing
- ordered ping-role replacement
- primary/backup organiser defaults
- reusable reminder administration
- optional role-request preset configuration
- manual, scheduled, and immediate publication intent
- administrator-facing one-off generation
- shared named-timezone local date/time parsing
- post-commit immediate publication
- source-template provenance
- generated-event snapshot independence
- deterministic source-lock concurrency coverage
- optimistic source-revision protection during occurrence preparation

The current major development area is now:

```text
Recurring Event Generation
```

Recurrence will reuse the established one-off generation boundary to create bounded ordinary event occurrences rather than introducing a separate mutable runtime event model.

See [`CURRENT-WORK.md`](docs/CURRENT-WORK.md) and [`ROADMAP.md`](docs/ROADMAP.md).

---

# Implemented template generation model

The current high-level shape is:

```text
template
    |
    | atomic generation
    v
ordinary persistent event
```

Generation snapshots reusable source configuration into ordinary event-owned state.

After commit:

```text
template
    -> reusable source / provenance

generated event
    -> authoritative runtime state
```

Generated events do not continuously consult their source template.

Later changes to:

```text
template defaults
template ping roles
template organiser defaults
template reminders
referenced role-request presets
guild default channels
```

do not rewrite state already snapshotted into an existing generated event.

Generation uses the established event, organiser, reminder, role-request, publication, and durable scheduler architectures rather than creating template-specific runtime equivalents.

Recurrence remains a later concern and should generate bounded ordinary occurrences rather than maintaining one mutable special event row.

---

# Portability

Although the project began around a Holdfast community, several boundaries are deliberately reusable:

- event lifecycle
- attendance state
- organiser escalation
- role-request modelling
- reusable presets
- reminders
- durable scheduled work
- audit concepts

Portability does not mean copying the existing schema into another application.

A future host should deliberately map identity, permissions, lifecycle, and destination concepts into its own model.

---

# Deployment

The application runs as a persistent containerised Node.js service backed by PostgreSQL.

The current deployment uses Northflank.

Scheduled work survives process restarts because future actions are persisted in PostgreSQL rather than depending on uninterrupted in-memory timers.

Deployment credentials and secrets do not belong in the repository.

---

# Security and privacy

The bot stores operational Discord identifiers and event-management data required for its workflows.

Administrative operations use configured Discord permissions and guild administration roles.

Audit information is intended for administration and debugging rather than public exposure.

Secrets including:

- Discord tokens
- database credentials
- hosting credentials

must be supplied through environment configuration.

Future wider deployment should include explicit retention/deletion policy work for attendance, signup, organiser, role-request, and audit data.

---

# Documentation

Start with the [documentation index](docs/README.md).

Key references:

| Document                                   | Purpose                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| [Architecture](docs/ARCHITECTURE.md)       | Current subsystem design, persistence, scheduling, concurrency, and domain boundaries |
| [Decisions](docs/DECISIONS.md)             | Durable design rationale and non-obvious invariants                                   |
| [Roadmap](docs/ROADMAP.md)                 | Future development                                                                    |
| [Current Work](docs/CURRENT-WORK.md)       | Exact active checkpoint and next task                                                 |
| [Testing Guide](docs/TESTING-GUIDE.md)     | Automated/manual testing workflow                                                     |
| [Administrator Guide](docs/ADMIN-GUIDE.md) | Current Discord setup and operational command behaviour                               |

When documentation and implementation appear to disagree, inspect the current code/tests and relevant decision records before simplifying behaviour.

Several unusual-looking paths exist specifically to preserve concurrency, recovery, or snapshot guarantees established by earlier regressions.

---

# Licence

Public repository visibility does not grant permission to copy, modify, or redistribute the software.

A formal open-source licence can be added later if the project owner chooses to grant those permissions.
