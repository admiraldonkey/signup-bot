# Holdfast Event Bot

A TypeScript/Discord event-management bot designed for organised gaming communities, originally built for a large **Holdfast: Nations at War** regiment.

The project began as a replacement for simple reaction-based event sign-ups and has grown into a more general event-management system supporting attendance, organisers, reminders, role volunteering, qualification rules, draft events and durable scheduling.

> **Project status:** Active development / community testing  
> The bot is currently being tested in a real Discord community while its architecture and workflows continue to evolve.

---

## Overview

Organising recurring community events through Discord can quickly become awkward when attendance, reminders, specialist roles and organiser availability are all managed through unrelated messages and manual processes.

This project aims to provide a structured system while keeping Discord as the primary interaction surface.

Current functionality includes:

- Configurable event types and regions
- Optional attendance sign-ups
- Attending / Tentative / Not Attending responses
- Event editing, cancellation and reopening
- Actual attendance recording
- Signup-versus-attendance reporting
- Primary and backup event organisers
- Automatic organiser escalation
- Role volunteering and qualification tracking
- Early/private role-request workflows
- Persistent reminders and scheduled actions
- Draft/unpublished events
- Manual or automatic scheduled publication
- Administrative audit logging

The system is designed around a PostgreSQL database as the authoritative source of state, allowing Discord messages to be rebuilt rather than treated as the application's database.

---

# Key Features

## Event Management

Administrators can create and manage one-off events with configurable:

- Event type
- Region/audience
- Date and time
- Timezone
- Duration
- Description
- Discord notification roles
- Attendance sign-ups
- Signup closing deadline
- Organisers
- Publication timing

Events can be edited after creation, with dependent scheduled actions updated where required.

---

## Optional Attendance Sign-Ups

Events can either use normal attendance responses:

- **Attending**
- **Tentative**
- **Not Attending**

or operate without sign-ups entirely.

This allows the same event system to support different workflows, such as:

- Naval events
- Linebattles
- Competitions
- Informational announcements
- Events where attendance is recorded but advance signup is unnecessary

No-signup events are excluded from signup reliability calculations so they cannot create false walk-in or no-show results.

---

## Draft and Scheduled Events

Creating an event does not have to immediately notify the entire server.

Events can exist internally before their normal public announcement, allowing administrators to:

1. Create the event and receive its ID
2. Configure organisers
3. Add role options
4. Run early/private role requests
5. Edit the event
6. Publish it later

Publication can be:

- Immediate
- Manual
- Automatically scheduled relative to event start

For example:

```text
Event starts:
Sunday 20:00

Publish:
1440 minutes before start

Announcement:
Saturday 20:00
```

Manual publication can still override an existing automatic schedule.

---

## Event Organiser Workflow

Events may have:

- **Primary Organiser**
- **Backup Organiser**
- **Cover Organiser**

When an event becomes public, the primary organiser receives a private confirmation request.

If direct messages cannot be delivered, the request falls back to a configured private Event Administration channel.

The organiser can:

```text
Confirm
Decline
```

Response deadlines and warning periods are configurable.

---

## Automatic Organiser Escalation

If an organiser declines or does not respond in time, the system can automatically escalate responsibility:

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
              Eligible organiser
                 can Claim Event
```

The workflow is database-backed and survives bot restarts.

---

## Role Requests

Members can volunteer for event-specific roles.

Examples for a naval event might include:

```text
Captain
Supervisor
2-Gun Gunner
Gunboat Gunner
Carpenter
```

Role requests represent **willingness**, not automatic assignment.

Final selection remains with the event organiser.

---

## Multi-Role Volunteering

Members may volunteer for several roles simultaneously.

For example, the same user may request:

```text
Captain
Carpenter
Gunboat Gunner
```

Requests are independent rather than ranked preferences.

Members manage withdrawals explicitly through a private **Manage My Requests** interface, preventing an accidental second click from silently removing an existing request.

---

## Shared Role Pools

The same logical role can appear in multiple Discord request messages.

For example:

```text
Early Command Interest
    Captain
    Supervisor

Main Role Requests
    Captain
    Supervisor
    Carpenter
    Gunboat Gunner
```

Both Captain entries refer to the same underlying event-level volunteer pool.

This allows early/private planning and later general volunteering without creating duplicate role systems.

---

## Qualification Tracking

Roles can optionally require qualification.

Qualification may be based on configurable Discord roles and currently supports concepts such as:

```text
Qualified
Supervision required
Unqualified
```

For example:

```text
Captain

Experienced Captain role
    -> Qualified

Trainee / Midshipman role
    -> Supervision required
```

A member requiring supervision may still volunteer where permitted, while the organiser receives the additional context needed to make the final decision.

The implementation avoids hardcoding regiment-specific Discord role names into the business logic.

---

## Flexible Role-Request Groups

Different request groups can be configured for different audiences or phases of event preparation.

A group may specify:

- Which event roles are available
- Which Discord channel it appears in
- Whether positive attendance signup is required
- When requests close
- An optional notification role

Groups can close:

- Before event start
- At event start
- After event start

This supports workflows such as collecting command volunteers early while leaving general requests open until shortly after the event begins.

---

## Actual Attendance

Signup intention and actual attendance are stored separately.

This allows the system to distinguish:

```text
What somebody planned to do
```

from:

```text
What actually happened
```

Administrators can:

- Record an event's actual attendance
- Add individual attendees
- Remove individual attendees
- Compare attendance with signup responses

---

## Attendance Reporting

Signup-enabled events can identify situations such as:

- Attended as expected
- Signed up but did not attend
- Attended without signing up
- Attended despite selecting Not Attending

Tentative responses are retained as useful context without automatically being treated as no-shows.

Historical reports can also examine an individual member's attendance/sign-up history.

The reports are deliberately **informational rather than punitive**. The bot does not automatically discipline users or restrict future participation based on attendance statistics.

---

## Persistent Scheduling

Important future actions are stored in PostgreSQL rather than relying on long-lived JavaScript timers.

The scheduler currently handles workflows including:

```text
Event publication
Attendance closure
Event completion
Event reminders
Organiser warnings
Organiser timeouts
Organiser escalation
Role-request group closure
```

Scheduled actions support:

- Persistent database state
- Action claiming
- Processing locks
- Stale-lock recovery
- Retries
- Increasing retry delays
- Failure tracking

This allows scheduled work to survive:

- Bot restarts
- Deployments
- Temporary failures
- Process interruption

---

## Reminders and Announcements

Administrators can send immediate event announcements or create scheduled reminders.

Reminder timing can currently be relative to:

```text
Event start
Signup closure
```

If a reminder remains pending until its useful reference point has already passed, it is recorded as missed rather than sending a misleading late notification.

---

## Audit Logging

Administrative activity is written to PostgreSQL.

Audit records include information such as:

- Actor
- Guild
- Action
- Outcome
- Target
- Timestamp
- Structured context

Scheduler activity can also create audit entries.

A Discord audit channel may optionally mirror this activity, but the database remains the authoritative audit record.

---

# Architecture

The project follows several core architectural principles.

## PostgreSQL is authoritative

Discord messages are treated as views of database state.

Where practical, message state can therefore be rebuilt from PostgreSQL.

---

## Publication is separate from event status

An event can be valid and internally scheduled without yet being public.

For example:

```text
status = scheduled
publishedAt = null
```

represents an unpublished event being prepared by administrators.

---

## Important scheduled work is durable

Persistent scheduler records are used for important future operations rather than assuming the Node.js process will remain continuously alive.

---

## Business logic should remain portable

The project is gradually moving toward clearer separation between:

```text
Discord interaction handling
        |
        v
Domain / service logic
        |
        +---- PostgreSQL persistence
        |
        +---- Discord rendering
        |
        +---- notifications
        |
        +---- scheduling
```

This is particularly important because some functionality may eventually be integrated into another existing community bot.

---

# Technology Stack

| Area              | Technology   |
| ----------------- | ------------ |
| Language          | TypeScript   |
| Runtime           | Node.js      |
| Discord API       | discord.js   |
| Database          | PostgreSQL   |
| ORM               | Drizzle ORM  |
| Schema/migrations | drizzle-kit  |
| Date/time         | Luxon        |
| Containers        | Docker       |
| Current hosting   | Northflank   |
| Version control   | Git / GitHub |

---

# Project Structure

The exact structure will continue to evolve as the current refactoring phase progresses, but major areas include:

```text
src/
├── audit/
│   └── Administrative audit logging
│
├── auth/
│   └── Event-management authorisation
│
├── commands/
│   └── Discord slash-command adapters
│
├── db/
│   ├── Database client
│   └── Drizzle schema
│
├── events/
│   ├── Event publication
│   ├── Attendance message rendering
│   ├── Attendance refresh/recovery
│   └── Organiser presentation/notifications
│
├── interactions/
│   └── Discord button interaction handlers
│
├── organisers/
│   ├── Organiser lifecycle
│   ├── Scheduling
│   └── Escalation
│
├── reminders/
│   └── Reminder scheduling
│
├── role-requests/
│   ├── Role-request message rendering
│   └── Role-request scheduling
│
├── scheduler/
│   ├── Durable scheduler
│   └── Scheduled-action maintenance
│
└── time/
    └── Timezone handling
```

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for a more detailed technical overview.

---

# Database Model

The schema includes areas such as:

```text
Discord guilds and configuration
Event types and audiences
Event templates
Events
Event publication/message links
Ping roles
Attendance responses
Actual attendance
Role options
Role qualifications
Role-request groups
Role requests
Organiser assignments
Scheduled actions
Reminders
Audit logs
```

The authoritative current schema is:

```text
src/db/schema.ts
```

Database migrations are managed using Drizzle.

---

# Timezone Handling

Event scheduling uses IANA timezone identifiers such as:

```text
Europe/London
America/New_York
America/Chicago
America/Los_Angeles
```

Absolute event timestamps remain authoritative in the database.

The event timezone is retained for organiser-facing editing and interpretation.

Discord timestamps are used for member-facing displays so users normally see event times in their own local timezone.

Ambiguous local times around daylight-saving clock transitions are rejected rather than guessed.

---

# Discord Commands

The exact command surface is still evolving.

Representative administrative commands currently include:

## Server configuration

```text
/setup initialise
/setup configure
/setup regions
/setup logging
/setup logging-disable
/setup status
```

## Event management

```text
/event create
/event list
/event edit
/event publish
/event close
/event reopen
/event cancel
/event refresh
/event responses
```

## Organisers

```text
/event organiser-set
/event organiser-clear
```

## Role requests

```text
/event role-option-add
/event role-option-list
/event role-group-post
/event role-group-list
/event role-group-close
/event role-requests
```

## Reminders / announcements

```text
/event reminder-add
/event reminder-edit
/event reminder-list
/event reminder-remove
/event announce
```

## Actual attendance

```text
/attendance record
/attendance add
/attendance remove
/attendance compare
/attendance user
/attendance issues
```

## Audit

```text
/audit recent
```

> The `/event` command is becoming large and is likely to be reorganised before additional major command groups are added.

---

# Documentation

More detailed project, administrator and testing documentation is available in [`docs/`](./docs/).

### [`ARCHITECTURE.md`](./docs/ARCHITECTURE.md)

Describes:

- Current system architecture
- Major subsystems
- Database/state model
- Scheduler
- Publication
- Attendance
- Organisers
- Role requests
- Portability goals
- Known structural pressure points

### [`DECISIONS.md`](./docs/DECISIONS.md)

Records important domain and architectural decisions which may not be obvious from the implementation.

Examples include:

- Role requests are event-level rather than message-level
- Role requests are multi-select
- Qualification and notification audience are separate
- Event creation and public publication are separate lifecycle concepts
- Organiser response timing begins at publication
- Attendance discrepancies are informational rather than punitive

### [`ROADMAP.md`](./docs/ROADMAP.md)

Contains:

- Refactoring priorities
- Reliability work
- Planned template support
- Participation-aware attendance
- Feature flags
- Role-request improvements
- Portal/integration ideas
- Future testing requirements

### [`CURRENT-WORK.md`](./docs/CURRENT-WORK.md)

Provides a development handoff describing:

- The current implementation checkpoint
- Recently completed features
- Known technical debt
- Immediate priorities
- Important behaviours which must survive refactoring

### [`ADMIN-GUIDE.md`](./docs/ADMIN-GUIDE.md)

Provides practical guidance for server administrators using the bot.

Covers:

- Initial server setup and configuration
- Event creation and publication options
- Event editing, cancellation and refresh workflows
- Attendance and signup management
- Organiser assignment and escalation controls
- Role-option and role-request group management
- Reminders and announcements
- Actual attendance recording and reporting
- Audit commands
- Typical command usage and workflow examples

### [`TESTING-GUIDE.md`](./docs/TESTING-GUIDE.md)

Provides a manual testing and public-test workflow for validating bot behaviour in Discord.

Covers:

- The expected event lifecycle from creation through completion
- Attendance signup and closure behaviour
- Recording and correcting actual attendance
- Signup-versus-attendance comparison
- Organiser and role-request workflows
- Scheduled actions and reminder behaviour
- Important regression scenarios
- What information to include when reporting bugs
- Use of event IDs and audit records when diagnosing problems

---

# Development Setup

The project uses separate development infrastructure so experimental code does not operate against the public/testing Discord environment.

A typical development environment requires:

- Node.js
- npm
- PostgreSQL
- A Discord application/bot
- A development Discord server
- Appropriate environment variables

---

## 1. Clone the repository

```bash
git clone <repository-url>
cd <repository-directory>
```

---

## 2. Install dependencies

```bash
npm install
```

---

## 3. Configure environment variables

Create a local environment file based on the supplied example configuration, where available.

Typical values include:

```text
Discord bot token
Discord application/client ID
Development guild ID
PostgreSQL connection string
Database TLS configuration
```

Never commit real secrets.

---

## 4. Start PostgreSQL

A local PostgreSQL instance is required.

Docker may be used for development if preferred.

The development database should remain separate from any public or production/testing database.

---

## 5. Apply database migrations

Apply the repository's Drizzle migrations before starting the bot.

Check the scripts in `package.json` for the current project commands, as development scripts may evolve.

---

## 6. Register Discord commands

Slash commands must be registered against the intended development application/guild.

Guild-specific registration is recommended while developing because changes propagate more quickly than global command registration.

---

## 7. Start the bot

Run the current development/start script defined in:

```text
package.json
```

The bot should connect to both Discord and PostgreSQL before event-management functionality is tested.

---

# Environment and Secrets

Secrets must be stored outside source control.

Do not commit:

```text
.env
Discord tokens
database passwords
API credentials
webhook secrets
hosting credentials
```

An `.env.example` containing placeholder configuration is safe and useful.

If a secret is accidentally committed, removing it from the latest file is **not sufficient** because it may remain in Git history.

Rotate the credential and remove it from repository history before making the repository public.

---

# Testing

Changes should be tested against the dedicated development environment before being deployed to community testers.

At minimum, substantial changes should include:

1. TypeScript/typechecking
2. Automated test suite
3. Database migration verification where applicable
4. Bot startup against the development database
5. Targeted Discord interaction tests
6. Scheduler/lifecycle testing where relevant

Particular care is required around asynchronous lifecycle transitions such as:

```text
Scheduled publication
Manual publication
Cancellation
Attendance closure
Event completion
Organiser timeout
Organiser escalation
Role-request closure
```

---

# Example Event Workflow

A more advanced event can follow a preparation workflow such as:

```text
Create unpublished event
        |
        v
Assign primary / backup organiser
        |
        v
Configure event role options
        |
        v
Open private early command requests
        |
        v
Edit/finalise event details
        |
        v
Automatically publish public event message
        |
        v
Members submit attendance responses
        |
        v
Open general role requests
        |
        v
Send reminders
        |
        v
Attendance closes
        |
        v
Run event
        |
        v
Record actual attendance
        |
        v
Compare signup intention with attendance
```

Simpler events can skip most of these stages.

---

# Current Development Priorities

The next phase of development is intentionally focused on **quality and modularity**, not merely adding more commands.

Priorities include:

- Repository-wide architecture review
- Refactoring large command handlers
- Extracting reusable service/domain logic
- Improving automated tests
- Reviewing scheduler race conditions
- Improving error recovery
- Strengthening comments/documentation
- Adding server-level feature flags
- Improving portability to another bot
- Participation-aware attendance records
- Confirmed-organiser unavailability handling
- Preparing for recurring event templates

See [`docs/ROADMAP.md`](./docs/ROADMAP.md) for the full roadmap.

---

# Planned Recurring Event Templates

Recurring event templates are a major planned feature.

Rather than publishing directly from a template, the intended architecture is:

```text
Recurring template
        |
        v
Generate unpublished event occurrence
        |
        +---- organiser preparation
        +---- early role requests
        +---- admin edits
        |
        v
Scheduled public publication
        |
        v
Normal event lifecycle
```

This allows recurring automation without removing administrator control.

---

# Potential Integration With Another Community Bot

Another bot already used by the community provides:

- Automatic actual attendance recording
- PostgreSQL-backed event data
- Statistics/reporting
- Web portal functionality

It also uses:

- TypeScript
- discord.js
- PostgreSQL

There is therefore potential for useful functionality from this project to eventually be integrated into that existing system.

This has influenced the architecture of the project.

Major subsystems should increasingly be portable rather than tightly coupled to one command tree or Discord message format.

Likely high-value reusable areas include:

```text
Organiser assignment and escalation
Durable scheduling
Event publication lifecycle
Role-request domain logic
Qualification handling
Attendance comparison
Audit behaviour
```

Database migrations should not simply be copied between projects. Domain concepts and identifiers must first be mapped to the destination system.

---

# Contributing

The project is currently primarily developed for a specific community, but code review, bug reports and technically grounded suggestions are welcome.

Before making substantial changes, please read:

1. [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
2. [`docs/DECISIONS.md`](./docs/DECISIONS.md)
3. [`docs/ROADMAP.md`](./docs/ROADMAP.md)
4. [`docs/CURRENT-WORK.md`](./docs/CURRENT-WORK.md)

Some apparently unusual behaviours are deliberate domain decisions.

For example:

- Role requests are multi-select
- The same role shown in multiple groups shares one request pool
- A role request is not an allocation
- Organiser countdown begins on publication
- Publication and event status are separate
- Attendance reports are informational rather than punitive

Please avoid changing these behaviours accidentally while refactoring adjacent code.

---

# Development Guidelines

When contributing:

- Use TypeScript types rather than unnecessary `any`
- Keep Discord handlers thin where practical
- Keep database state authoritative
- Use persistent scheduling for important future work
- Preserve auditability
- Validate guild ownership on administrative operations
- Avoid hidden/destructive behaviour
- Avoid hardcoding server-specific Discord role names
- Prefer incremental refactoring over unnecessary rewrites
- Add tests for lifecycle-sensitive behaviour
- Keep secrets out of source control

---

# Security Considerations

The bot is intended to operate in sizeable Discord communities, so administrative boundaries matter.

Current/future security principles include:

- Runtime Event Admin authorisation
- Guild ownership checks
- Restricted Discord mention handling
- Least-privilege bot permissions
- PostgreSQL constraints for important invariants
- Auditing of administrative actions
- Environment-based secrets
- Private administrative fallback channels
- Careful authentication and authorisation for any future portal

Security issues should not be posted publicly if doing so would expose exploitable details against an active deployment.

---

# Privacy

The bot stores information associated with Discord users, including attendance responses and role volunteering.

The application should only collect information useful to event administration.

Attendance analytics are intended to support human decision-making rather than automated punishment.

Future development should formalise:

- Data-retention policies
- Member data deletion
- Historical reporting visibility
- Portal permissions
- Export permissions
- Audit retention

---

# Deployment

The current public/testing deployment is containerised and hosted on **Northflank** with PostgreSQL.

The application is not architecturally tied to Northflank and should be deployable to other suitable Node.js/container hosting environments.

A persistent PostgreSQL database is required.

---

# Project Motivation

The original workflow relied heavily on Discord messages and manual coordination.

Typical problems included:

- People attending without signing up
- Signups not accurately reflecting actual turnout
- Organisers needing to manually chase volunteers
- Specialist event roles being coordinated separately
- Reminder messages requiring manual timing
- Difficulty preparing events privately before announcing them
- Historical information being scattered across Discord messages

Rather than trying to replace Discord, the project aims to make those workflows more structured while keeping Discord as the familiar interface members already use.

---

# What This Project Demonstrates

From a software engineering perspective, the project includes practical examples of:

- TypeScript application architecture
- Discord API integration
- PostgreSQL relational modelling
- Drizzle ORM
- Database migrations
- Persistent job scheduling
- Retry/recovery strategies
- Race-condition handling
- Role-based authorisation
- State-machine-like lifecycle management
- Timezone-aware scheduling
- Audit logging
- Domain modelling
- Incremental feature development
- Refactoring toward reusable service boundaries
- Designing software around real user/community requirements

The project is developed against genuine community workflows rather than as a purely hypothetical demonstration application.

---

# Disclaimer

This is a community developed project and is not an official **Holdfast: Nations at War** product or service.

Game and product names remain the property of their respective owners.

---

# Licence

The repository licence should be consulted before reusing or redistributing the project.

If no licence has yet been added, source availability should **not** be interpreted as automatically granting permission to reuse, modify or redistribute the code.
