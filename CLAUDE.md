# Procela — Claude Code Handoff Document

## What We Are Building

Procela is a standalone SaaS platform that helps organizations connect their business processes to the data and systems that support them. It gives companies a single place to define how their business works, describe the data behind each step, and discover and govern that data over time.

Most data tools start with the data and ask the business to catch up. Procela starts with the business and lets the data follow.

---

## The Core Problem

Enterprises operate with two parallel worlds that rarely communicate:

- **The business side** — thinks in processes, workflows, and outcomes
- **The data side** — thinks in systems, pipelines, and schemas

When something breaks — a report is wrong, a regulation isn't met, a decision is made on bad data — nobody can quickly answer: *what process was affected, what data failed it, and who owns it?*

Procela is the answer to that question before it becomes a crisis.

---

## The Three Phases of Procela

### Phase 1 — Define
Organizations define their business processes in plain business language. No technical knowledge required. A process owner describes what their team does using a structured hierarchy:

```
Value Stream → Process → Sub-Process → Step
```

Procela accelerates this with AI-generated industry templates. The user selects their industry and receives a full process hierarchy as a starting point. They can accept, modify, or replace any part of it.

### Phase 2 — Connect
For each step in a process, users describe — in business terms — what data and systems are involved. Not schemas or database tables. Plain language like:

> "This step uses customer account data from Salesforce and billing records from SAP."

Procela AI suggests what data and systems typically support each step based on the industry and process type. Users can accept the suggestion, modify it, or replace it entirely. Every override is stored — it captures what makes this organization's version of the process unique.

### Phase 3 — Discover
Once business intent is defined, Procela uses that context to help find, validate, and connect to actual data assets — either by integrating with source systems or by guiding technical users to map business definitions to real data. This is where the business-layer definition meets the technical-layer reality.

> Phase 3 integration capabilities should be architected for from the start but are not required for the initial prototype.
>
> **Status (shipped):** the Discover loop is now built for direct-connect sources — real catalog discovery across relational databases (Postgres/MySQL/SQL Server/Oracle/Redshift), cloud warehouses (Snowflake/BigQuery/Databricks), MongoDB, and cloud object storage (S3/Azure Blob/GCS/SFTP, incl. Parquet/Avro), plus local-file uploads; measured data quality run live over direct database connections; and a suggest-and-confirm flow that reconciles discovered assets into the governed catalog. The on-prem edge connector covers firewalled relational sources. Only API/spreadsheet sources remain simulated. The remaining Phase-3 item is an operational pilot against a real customer database (see `docs/ROADMAP.md` Track A; the non-relational build-out is Track E, see `docs/non-relational-discovery.md`).

---

## Core Capabilities

### 1. Process Catalog
- Hierarchical structure: Value Stream → Process → Sub-Process → Step
- Full CRUD: create, edit, rename, delete, reorder at any level
- Rich text descriptions at each level
- Ownership assignment at each level (tied to identity provider)
- Status tracking (draft, active, under review, deprecated)

### 2. Industry Templates (AI-Generated)
- User selects industry from a predefined list
- Procela generates a full process hierarchy using AI (Claude API)
- Preview before applying
- User can accept all, accept partial, or start from scratch
- Supported industries for prototype:
  - Utilities (electric, gas, water)
  - Defense & Shipbuilding
  - Healthcare
  - Manufacturing
  - Oil & Gas
  - Financial Services
  - Transportation & Logistics
  - State & Local Government

### 3. Data & System Registry
- Users define data assets in business terms (not technical schemas)
- Users define the systems that hold that data (ERP, CRM, GIS, etc.)
- Each asset has: name, description, owning system, business owner, data steward, governance tier
- Governance tiers: Bronze (raw/minimal), Silver (managed), Gold (fully governed and certified)

### 4. Process-to-Data Mapping
- Link data assets and systems to specific process steps
- AI suggests relevant data and systems based on industry and process context
- User can override or extend any suggestion
- Visual map showing which processes depend on which data assets
- Reverse lookup: which processes does a given data asset support?

### 5. Gap Detection
- Automatically identifies process steps with no linked data assets
- Surfaces ungoverned or low-tier assets supporting critical processes
- Dashboard view of coverage across the full process catalog

### 6. Health & Governance Monitoring
- Health score per data asset (initially manually set; Phase 3 will pull from source systems)
- Governance tier badge (Bronze / Silver / Gold)
- Portfolio-level health dashboard

### 7. AI Assistant
- Natural language interface available throughout the application
- Context-aware: knows the organization's process catalog, data assets, and mappings
- Can answer questions like:
  - "Where are our data gaps?"
  - "What data supports our regulatory reporting process?"
  - "Which assets are below 80% health and linked to critical processes?"
- Powered by Anthropic Claude API (claude-sonnet model)

### 8. Ownership & Accountability
- Every process, sub-process, data asset, and system has an assigned owner
- Owners are real users pulled from the organization's identity provider
- Role-based access control (see Identity section below)
- Full audit trail: who created, modified, or changed any item and when

### 9. Reporting & Dashboards
- Executive dashboard: portfolio health, gap summary, governance tier breakdown
- Operational dashboard: process coverage, ownership gaps, data health alerts
- Export capabilities (PDF, CSV) for compliance and audit use

---

## Identity & Access Management

Procela must integrate with enterprise identity providers. This is a foundational requirement, not an add-on.

### Supported Providers (Priority Order)
1. **Microsoft Active Directory / Azure AD (Entra ID)** — primary target
2. **Okta**
3. **Generic SAML 2.0 / OIDC** — for broad compatibility

### Authentication
- Single Sign-On (SSO) via SAML 2.0 or OIDC
- Users do not create separate Procela accounts
- Session management via JWT tokens

### Authorization — Role Model
```
Super Admin       — full platform access, manages org settings and integrations
Org Admin         — manages users, roles, and org-level configuration
Process Owner     — create/edit/delete processes in their assigned domain
Data Steward      — create/edit/delete data assets and system connections
Contributor       — can edit items they are assigned to
Viewer            — read-only access to the full catalog
```

### Org Hierarchy Support
- Procela should reflect the organization's department/team structure from the directory
- Ownership and access can be scoped to business unit or department
- A department head sees everything their team owns
- A CDO or executive sees the full enterprise view

### Audit Trail
- Every action in Procela is tied to an authenticated identity
- Audit log must be queryable and exportable for compliance purposes

---

## Technical Architecture

### Guiding Principles
- **Cloud-first, deployment-flexible**: Build for AWS initially. Architecture must support on-premise deployment later with minimal re-engineering. Use containerization and infrastructure abstraction from the start.
- **API-first**: All functionality exposed via REST API. The frontend is a consumer of the API, not tightly coupled to it.
- **Stateless services**: Horizontally scalable. No server-side session state.
- **12-factor app principles**: Configuration via environment variables, not hardcoded values.
- **Separation of concerns**: Auth, business logic, data access, and AI services are independently deployable.

---

### Frontend
- **Framework**: React (TypeScript)
- **State management**: Zustand or React Query
- **UI**: Custom component library (no heavy UI frameworks — Procela has its own design language)
- **Routing**: React Router
- **Auth**: MSAL (Microsoft) or generic OIDC client depending on provider
- **Deployment**: S3 + CloudFront (AWS) / Nginx container (on-premise)

### Backend
- **Runtime**: Node.js (TypeScript) or Python (FastAPI) — choose based on team preference; document the choice here before starting
- **API style**: REST with OpenAPI spec
- **Authentication middleware**: Validates JWT tokens from identity provider
- **ORM**: Prisma (Node) or SQLAlchemy (Python)
- **Deployment**: AWS ECS (Fargate) or containerized via Docker

### Database
- **Primary**: PostgreSQL
  - AWS: Amazon RDS (PostgreSQL)
  - On-premise: Self-hosted PostgreSQL or customer-managed RDS-compatible
- **Schema design**: Multi-tenant from the start. Every table includes `org_id`.
- **Migrations**: Managed via Flyway or Alembic — version-controlled, repeatable

### AI Services
- **Provider**: Anthropic Claude API
- **Model**: `claude-sonnet-5` (update model string as newer versions release)
- **Uses**:
  - Industry template generation (process hierarchy)
  - Data and system suggestions per process step
  - AI assistant (conversational, context-aware)
- **Pattern**: AI calls are made server-side only. The API key is never exposed to the frontend.
- **Prompt context**: Each AI call receives relevant org context (industry, process, existing catalog) as system prompt content.

### Identity Integration
- **AWS**: Use Amazon Cognito as the identity broker (federates with AD, Azure AD, Okta via SAML/OIDC)
- **On-premise**: Direct SAML 2.0 / OIDC integration without Cognito dependency
- Abstract the auth provider behind an internal `AuthService` interface so the underlying provider can be swapped without touching business logic

### Infrastructure (AWS — Prototype)
```
Route 53 (DNS)
  └── CloudFront (CDN + HTTPS)
        ├── S3 (React frontend)
        └── ALB (Application Load Balancer)
              └── ECS Fargate (API containers)
                    ├── RDS PostgreSQL (database)
                    ├── ElastiCache Redis (caching, sessions)
                    └── Secrets Manager (API keys, DB credentials)

Cognito (Identity broker — federates with AD/Azure AD/Okta)
CloudWatch (Logging, monitoring, alerting)
```

### Infrastructure as Code
- **Tool**: AWS CDK (TypeScript) or Terraform
- All infrastructure defined as code from day one
- Separate stacks for: networking, data, application, auth
- Environment parity: dev, staging, production use the same IaC templates with different parameter sets

### Containerization
- Every service runs in Docker containers from day one
- Docker Compose for local development
- ECS task definitions for AWS
- Helm charts or Kubernetes manifests prepared for on-premise deployment (future)

---

## Deployment Flexibility

The prototype runs on AWS. On-premise deployment must be achievable later without re-architecting.

### What This Means in Practice
- **No AWS-only dependencies in business logic.** If a service requires RDS, abstract the DB layer so PostgreSQL running anywhere works.
- **Cognito is replaceable.** The auth layer must work with any SAML/OIDC provider. Cognito is used as a convenience in AWS, not as a hard dependency.
- **All config via environment variables.** No hardcoded AWS ARNs, regions, or resource names in application code.
- **Container-first.** Every service runs in Docker. On-premise customers run the same containers, pointed at their own infrastructure.
- **Storage abstraction.** If file storage is needed (exports, attachments), abstract behind a storage interface. AWS S3 is the default implementation; on-premise can use MinIO or a network share.

### On-Premise Deployment Target (Future)
```
Nginx (reverse proxy + static frontend)
  └── Docker / Kubernetes
        ├── API containers
        ├── PostgreSQL
        ├── Redis
        └── Active Directory (customer-managed, direct SAML/OIDC)
```

---

## Data Model — Key Entities (Starter)

```
Organization
  id, name, industry, identity_provider_config, created_at

User
  id, org_id, external_id (from IdP), name, email, role, department

ValueStream
  id, org_id, name, description, owner_id, status, created_at, updated_at

Process
  id, org_id, value_stream_id, name, description, owner_id, status, order_index

SubProcess
  id, org_id, process_id, name, description, owner_id, status, order_index

ProcessStep
  id, org_id, sub_process_id, name, description, owner_id, status, order_index

System
  id, org_id, name, description, system_type, owner_id, steward_id

DataAsset
  id, org_id, name, description, system_id, owner_id, steward_id,
  governance_tier (bronze|silver|gold), health_score, created_at, updated_at

ProcessDataLink
  id, org_id, process_step_id, data_asset_id, link_type, notes,
  ai_suggested (boolean), user_overridden (boolean), created_by, created_at

AuditLog
  id, org_id, user_id, entity_type, entity_id, action, before, after, timestamp
```

---

## AI Behavior Guidelines

### Industry Template Generation
- Prompt must specify: industry name, expected output structure (JSON), depth (value streams, processes, sub-processes)
- Output must be validated before presenting to user
- Always show a preview — never auto-apply AI output without user confirmation

### Data & System Suggestions
- Prompt context must include: industry, value stream name, process name, sub-process name, step name
- Response should include: suggested data assets (business terms), suggested systems, rationale
- UI must make it easy to accept, modify, or dismiss each suggestion independently
- Store whether each link was AI-suggested or user-defined (`ai_suggested` flag)

### AI Assistant
- System prompt must include: org industry, full process catalog summary, data asset summary, known gaps
- Responses should be concise and actionable
- Assistant should never fabricate data assets or processes that don't exist in the catalog
- If asked about something outside the catalog, acknowledge the gap and offer to help define it

---

## Development Priorities — Prototype Scope

Build in this order:

1. **Auth** — SSO login via Azure AD / Cognito. Role-based access. User session.
2. **Organization setup** — org creation, industry selection, basic settings.
3. **Process catalog** — full CRUD for value streams, processes, sub-processes, steps. Tree UI.
4. **Industry template generation** — AI-powered hierarchy generation with preview and apply.
5. **Data & system registry** — define systems and data assets in business terms.
6. **Process-to-data mapping** — link data assets to process steps. AI suggestions with override.
7. **Gap detection** — surface unmapped steps and ungoverned assets.
8. **AI assistant** — conversational interface with catalog context.
9. **Dashboards** — executive and operational views.
10. **Audit log** — queryable record of all changes.

---

## Environment Variables (Starter Set)

```env
# App
NODE_ENV=development|staging|production
PORT=3000
API_BASE_URL=https://api.procela.io

# Database
DATABASE_URL=postgresql://user:pass@host:5432/procela

# Auth
AUTH_PROVIDER=cognito|azuread|okta|saml
COGNITO_USER_POOL_ID=
COGNITO_CLIENT_ID=
COGNITO_REGION=
SAML_ENTRY_POINT=
SAML_ISSUER=
JWT_SECRET=

# AI
ANTHROPIC_API_KEY=
# Master switch for every AI integration feature (template generation, data/
# asset suggestions, sensitivity classifier, the assistant, AI agents).
# Defaults on; set to false to turn them all off — the backend refuses the AI
# endpoints and the frontend hides their UI. The single knob for on-prem /
# FedRAMP deployments that must not call an external model.
AI_FEATURES_ENABLED=true

# Storage
STORAGE_PROVIDER=s3|local|minio
S3_BUCKET=
S3_REGION=
STORAGE_LOCAL_PATH=

# Redis
REDIS_URL=redis://localhost:6379

# Logging
LOG_LEVEL=info
```

---

## What Success Looks Like for the Prototype

A user can:
1. Log in with their enterprise credentials (Azure AD)
2. Select their industry and generate a process hierarchy in under 2 minutes
3. Navigate the hierarchy and edit any process, sub-process, or step
4. Define data assets and systems in plain business language
5. Link data assets to process steps, accepting or overriding AI suggestions
6. See which process steps have no data coverage (gaps)
7. Ask the AI assistant a plain-English question about their process-data landscape and get a useful answer
8. See who owns each process and data asset

---

## Notes for Claude Code

- Keep all AI calls server-side. Never expose the Anthropic API key to the frontend.
- Multi-tenancy is non-negotiable. `org_id` must be present and enforced on every query.
- Write OpenAPI specs alongside the API routes, not after.
- Use environment variables for everything that differs between environments.
- Docker Compose must work for local development with a single `docker compose up`.
- Abstract AWS-specific services (Cognito, S3) behind interfaces so they can be swapped for on-premise equivalents later.
- Every entity needs `created_at`, `updated_at`, `created_by`, `updated_by`.
- Audit logging is a first-class concern, not a nice-to-have.

## Frontend Design Conventions — REQUIRED for new pages

The frontend has a small set of shared primitives that MUST be
composed rather than reinvented. A design-consistency sweep (six PRs
in the design-consistency series) migrated ~50 pages to these; new
pages must adopt them from day one. Do NOT hand-roll equivalents.

**Layout primitives:**

- `<Page>` — every routed page renders inside this. Width comes from
  the `width` prop (`default`, `narrow`, `wizard`), never inline
  `maxWidth`.
- `<PageHeader>` — the standard title + subtitle + actions row.
  Title renders at `1.375rem` (22px) on a compact band (10px bottom
  padding, 1rem bottom margin). Do NOT hand-roll an `<h1>` at the top
  of a page, and do NOT re-inflate the title size or band spacing per
  page — the density is intentional and set here for every page.
- `<FieldStack>` — the vertical-rhythm primitive: a flex column that
  owns the spacing between stacked fields/panels from the `--space-*`
  tokens (`tight` 4px / `field` 8px / `section` 16px). Compose it
  instead of hand-rolling per-field `marginTop`/`marginBottom`, which
  drift apart and make inter-field gaps jump around depending on which
  fields render. Children must NOT add their own vertical margin — the
  stack owns that axis.

**Content primitives:**

- `<Card>` — the standard content container (surface bg + border +
  `var(--radius-md)` + `var(--shadow-sm)` + padding). Never repeat
  those five properties inline. Props: `padding`, `marginBottom`,
  `radius`, `shadow`, `borderColor`, `onClick`.
- `<SectionLabel>` — the uppercase section header used inside cards
  ("Governance & Ownership", "Advanced fields"). Style is fixed
  (`fontSize: 10, fontWeight: 600, uppercase, letterSpacing: 0.05em,
  color: var(--color-text-muted)`) and intentionally not
  customisable — if a label needs to look different, it's probably
  an h2/h3.
- `<TruncatedText>` — list-row cells that could carry long content
  (descriptions, definitions, long names). Renders single-line
  ellipsis + hover tooltip. Combined with the global
  `table th, table td { white-space: nowrap; }` rule, this keeps
  every list uniform-height.

**List primitives:**

- `<DataTable>` — the shared list table. Every flat or expandable
  entity-list page composes it instead of hand-rolling a `<table>`
  shell: it owns the header, the leading checkbox column, per-row
  hover + selected-row tint, the "no matches" row, and — via the
  `expansion` prop — caret / row-click expandable detail rows with an
  internally-computed colSpan. Pass a declarative `columns` array;
  sorting (`useSortedList`), column visibility (`useColumnPicker`), and
  the `renderExpandedRow` body (lazy fetch, nested sub-tables, forms,
  quick-add) stay page-owned. Do NOT re-roll the table shell for a new
  list. Exceptions that stay hand-rolled: **People** (its pinned
  `<tbody>` quick-add input row has no DataTable slot; its conditional
  column is *not* a blocker — that's just a `.filter(Boolean)` column
  entry), and non-entity-list tables
  (reports, the RACI matrix, the audit log, static reference tables,
  nested detail sub-tables).
- `useRowSelection` — the row-selection hook wired into `DataTable`'s
  `selection` prop. Build it over the *filtered* rows so select-all
  matches what's visible. Do NOT hand-roll a `selectedIds` Set +
  `toggleSelectAll` (a recurring source of select-all/filter bugs).
- `<BulkActionBar>` — the selected-rows action bar (`count` + `onClear`,
  with `<BulkActionButton>` children). Do NOT hand-roll the off-brand
  blue selected-count bar.
- `<OrgSidebarTree>` — the collapsible organization-hierarchy left rail
  used to filter an entity list by org (People, Agents). Pass `nodes`
  (the org `tree`), `selectedId`, `onSelect`, and a `counts` map for the
  per-node badges. Compose it inside the standard sidebar `<Card>` with
  an "ORGANIZATIONS" label and an "All (N)" row above it. Do NOT
  hand-roll a per-page org tree or fall back to a plain org `<select>`
  dropdown on a page that filters by org.

**Interactive primitives:**

- `<SecondaryButton>` — the neutral Cancel / Close affordance. Do NOT
  hand-roll the `transparent bg + grey border + grey text` button
  style; wire the same 8 properties through this component.
- `<WizardProgress>` — the step-bar at the top of any multi-step
  flow (Process Wizard, Sync Connection Wizard).

**Colours — CSS variables only for semantic use:**

- `var(--color-primary)` / `--color-primary-hover` / `--color-primary-light`
- `var(--color-text)` / `--color-text-secondary` / `--color-text-muted`
- `var(--color-bg)` / `--color-surface` / `--color-border`
- `var(--color-success)` = #16a34a (green)
- `var(--color-warning)` = #d97706 (amber)
- `var(--color-error)` = #dc2626 (red)

Never inline `color: '#dc2626'` — use `var(--color-error)`. Same for
success and warning. Palette-object entries (`{ bg: '#fee2e2', color:
'#dc2626' }`) — where the hex is paired with a companion `bg` to
define a semantic-badge palette — should stay as hex so the
palette entry doesn't drift when the semantic variable is retuned.

**Icons — always match the sidebar:**

Card headers, empty-state heroes, dashboards — anywhere a menu item
is visually referenced — use `renderNavIcon(route, {size})` from
`components/navIcons.tsx`. Do NOT hand-pick Unicode glyphs (⚙, ⛁,
☰, ☻, etc.) for entities that have a sidebar entry.

**Never wrap:**

Global CSS rule (`table th, table td { white-space: nowrap; }`)
means table cells clip by default. When a cell has genuinely long
content, wrap it in `<TruncatedText>` for the ellipsis + tooltip
affordance. Never re-enable wrapping on lists.

**Full reference:** `packages/frontend/src/components/README.md`
lists every shared primitive with usage examples and the "before /
after" pattern from the audit.
