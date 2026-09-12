# GA Tightening Audit — Every Field Earns Its Place

Goal for the first commercially available version: **stable, "tight," and
easy to use, deploy, and manage — every field has a purpose and adds value.**

This document is a full field-level census of the data model (63 models,
~653 columns) plus the operational surface, with a verdict on every
questionable field and a staged, migration-safe execution plan.

## Method

For each model, a field's liveness was judged by the **repo-mapper
discriminator**: `packages/backend/src/db/<model>.repo.ts` declares the
Prisma row type and maps fields in `fromPrisma()` (DB→app) and
`toPrismaData()` (app→DB). A column present in the row *type* but in
**neither** mapper is never read or written by the application = dead.
Findings were cross-checked against route/service usage and frontend
`.tsx` surfacing.

Verdict legend: **REMOVE** (dead — no purpose) · **CONSOLIDATE**
(redundant with a sibling) · **LOW-VALUE** (wired but no user value for a
tight v1) · **KEEP** (load-bearing; the ~90% not listed here).

> Each REMOVE is re-confirmed in its own migration PR before the column is
> dropped — this list is the work queue, not a blind delete script.

---

## A. Fields to REMOVE — dead columns (8 columns, 3 relations, 1 index)

| # | Model.column | Evidence | Migration notes |
|---|---|---|---|
| 1 | `Organization.identityProviderConfig` | Not in the repo row type nor either mapper; frontend type declares it, nothing reads it. 0 repo / 0 route refs. | Drop column. |
| 2 | `System.stewardId` | Schema comment: "legacy single-steward slot." In row type only, never round-tripped; superseded by `custodianIds` M2M. | Drop column **+ the `SystemSteward` relation on `Person`**. |
| 3 | `DataAsset.rejectedSensitivityTags` | Shadow array of `sensitivityTags`; row type + test fixtures only, absent from both mappers. | Drop column; update 3 test fixtures. |
| 4 | `Connection.systemId` | `@deprecated` in route, stripped in `toPublic` (never emitted), only used by a one-time JSON backfill of `connection_system_links`. | Backfill link table, drop column, **retire the now-dead frontend `conn.systemId` fallbacks** (ConnectionsPage). |
| 5 | `Person.department` | In row type but not round-tripped; absent from `StoredPerson`; every "department" hit in code is org-hierarchy, not this field. | Drop column. |
| 6 | `Person.externalId` | In row type, not round-tripped; no Person route reads it (SCIM `externalId` lives on `ScimGroup`). | Drop column **+ the orphan `@@index([externalId])`**. |
| 7 | `PersonSkill.level` | Join `createMany` omits it; no `.level` read anywhere. | Drop column. |
| 8 | `Skill.damaRoleId` | Repo comment: "we ignore it on both read and write." No route reads `Skill.damaRole`. | Drop column, **the `damaRole` relation + FK, and the reverse `DamaRole.skills` relation** (see C: `DamaRole.skills` is the unpopulated other end). |

---

## B. Fields/entities to CONSOLIDATE — redundancy

| Pair | Recommendation |
|---|---|
| `Person.role` (legacy single-role) vs `Person.orgRoles` (per-org) | `role` is a documented "holdover from the single-role model." Keep only as a fallback, or drop once `orgRoles` fully covers login/authz. |
| `Person.title` vs `Person.jobRole` | Two overlapping job-descriptor fields; `personLabel.ts` treats `title` as primary and `jobRole` as a secondary fallback. Collapse to one. |
| `System.integrationPoints` (free-text) vs `System.integrations` (structured JSON) | The structured field supersedes the free-text twin; migrate any content and retire `integrationPoints`. |
| `AnalysisReport.ownerName` (denormalized) vs `Report` (ownerId + join) | Inconsistent owner patterns across sibling models. Standardize on `ownerId` + join; drop the denormalized name. |
| `Report` vs `AnalysisReport` (model-level) | Genuinely distinct today (report-engine `definition` vs pivot-cube `config`) — **keep both for v1**, but flag as the clearest long-term model consolidation. |

### Stage-3 outcome (on review)

Only `AnalysisReport.ownerName` was a true, mechanical redundancy and
was consolidated: the stored column is dropped and the display name is
derived from `ownerId` via a people join, matching the sibling `Report`.

The other pairs were **reviewed and kept** — on inspection they are not
dead redundancy but live product surfaces, so removing them is a product
decision, not cleanup:

- **`Person.title` vs `jobRole`** — *kept.* `jobRole` is a distinct,
  user-editable field with its own edit input, a RACI-matrix "group by
  Job Role" dimension, and a sync-wizard mapping. Title (formal title)
  and Job Role (functional descriptor) are legitimately separate in
  practice. Collapsing them removes a reporting dimension and user data.
- **`System.integrationPoints`** — *kept.* Free-text that the schema
  deliberately retains because it captures nuance the structured
  `integrations` cannot; there is no lossless free-text→structured
  migration. Removing it destroys user content.
- **`Person.role` vs `orgRoles`** — *deferred.* `role` still backs
  login / JWT / authz; dropping it is high-risk and belongs with a
  dedicated authz change, not a field-consolidation pass.

---

## C. LOW-VALUE fields — wired, but no user value for a tight v1

Each round-trips but has no UI surface and/or no functional effect. Decide
per field: **surface it** (give it real value) or **defer/remove it**.

| Field | Why it's low-value |
|---|---|
| `FlowRelationship.condition` | Accepted by the create API but never rendered in any view; seeds always null. `label` covers the visible annotation. |
| `Mapping.createdBy` | Hardcoded to the literal `'dev-user'` on create — no real attribution (ties to the audit-trail gap in G). |
| `GovernanceTask.resolution` | Written on completion, displayed on no screen. |
| `GovernanceTask.createdBy` | Not meaningfully set; duplicated by `AuditLog`. |
| `GovernancePolicy.lastReviewDate` | Captured by the API; UI shows only `nextReviewDate`. |
| `GovernanceControl.linkedDomainId` / `linkedSystemId` | Stored, never shown or filtered. |
| `DamaRole.skills` (relation) | Unpopulated back-end of the dead `Skill.damaRoleId` (A#8); UI uses static `requiredSkillIds`. |
| `RaciOverride.reason` | Always stores the constant `'Manual override'` — carries no distinct data. |
| `GlossaryTerm.relatedTerms` | Round-tripped but has no form field or display at all; always seeded `[]`. |
| `Sop.lastReviewedAt` | Accepted by the API but no form input or display. |
| `Agent.skillIds` | Editable in the form but **ignored** by `runAgentExecution` (runs use `node.requiredSkillIds`). Misleading — implies an effect it doesn't have. |
| `SavedView.isShared` | Defaults true, but no UI toggle and no list-filter enforcement — sharing is never actually exercised. |

### Stage-4 outcome

Removed the seven fields that are pure dead weight — round-tripped but
with no UI surface and no logic read — in one pure-subtraction migration
(`20260805060000_ga_low_value_field_sweep`): `FlowRelationship.condition`,
`GovernanceTask.resolution`, `GovernancePolicy.lastReviewDate`,
`GovernanceControl.linkedDomainId` + `linkedSystemId`,
`GlossaryTerm.relatedTerms`, `Sop.lastReviewedAt`, `SavedView.isShared`.
Each was dropped from the schema, repo mapper, route type/zod/handlers,
seeds, and fixtures; frontend type-only declarations were removed too.

Kept / deferred (not dead — the audit's "remove or surface" framing
resolved to keep):

- **`Agent.skillIds` — kept.** The "ignored" note was only true for
  `runAgentExecution`. It is in fact read by the DAMA skill-gap route,
  the skill-delete cascade cleanup, and is edited through a live
  `SkillPicker` form. Removing it would break real behaviour.
- **`Mapping.createdBy` / `GovernanceTask.createdBy` — deferred.** These
  are hardcoded to a literal today, but CLAUDE.md mandates `created_by`
  on every entity and treats audit trail as first-class. They are audit
  scaffolding pending real identity attribution (the §G auth gap), not
  dead fields; deleting them would contradict the documented data model.
- **`RaciOverride.reason` — deferred.** Removal is display-neutral (every
  reader already falls back to the same constant), but the field is wired
  into a live tooltip + the dashboard `reasons` map, so it's not a clean
  scalar drop. Either surface it as a real editable reason or retire it in
  its own pass.

---

## D. Consistency fixes (cheap, high polish-value)

- **Owner FK naming:** `ProcessNode.ownerId` and `DataDomain.ownerId` vs
  `System.ownerPersonId` / `DataAsset.ownerPersonId`. Standardize on
  `ownerPersonId` platform-wide.
- **Timestamp typing:** `ProcessVersion.changedAt` and
  `SuggestionDismissal.dismissedAt` are `String` ISO values while every
  other model uses `DateTime`. Normalize to `DateTime`.

### Stage-5 outcome

- **Timestamp typing** — *done.* Both columns retyped to `DateTime`
  (migration `20260805050000_normalize_timestamp_columns`). The repos
  round-trip ISO strings at the app layer (`Date → toISOString` on read,
  `new Date()` on write), so there is no app-visible type change — only
  the DB column type is normalized.
- **Owner-FK naming** — *deferred.* Renaming `ProcessNode.ownerId` /
  `DataDomain.ownerId` to `ownerPersonId` touches ~100+ references across
  the backend, the **frontend** (it's part of the create/update API
  contract and read on many pages), the repo mappers, and the RBAC
  layer-2 assignment anchor — a large, coordinated rename whose only
  benefit is naming symmetry. `ownerId` is also a generic name shared by
  ~8 other models, so it can't be blanket-renamed. The mixed naming is
  cosmetic and harmless today; the rename carries real owner-resolution
  regression risk for no functional gain, so it's best done (if at all)
  as its own dedicated, carefully-reviewed pass rather than bundled into
  a "cheap consistency" change.

---

## E. Correctness bugs surfaced during the audit (matter for "stable")

1. **Phantom field read** — `routes/analysis.ts:270` reads
   `deputyOwnerPersonId`, which does not exist (the column is
   `System.deputyOwnerId`). The system-deputy governance fact never
   fires. Fix the reader (or the field name).
2. **Agent-schedule persistence bypass** — the ticker's `runScheduleNow`
   persists via `saveStore('agentSchedules', …)` instead of
   `agentSchedulesRepo.update()`, so in Postgres mode
   `lastRunAt`/`runCount`/`nextRunAt` advances may not reach the DB — an
   agent could re-run or lose schedule state on restart.
3. **Stale doc** — `refresh-tokens.repo.ts` header says "No consumer is
   wired yet"; it is in fact wired into `routes/auth.ts`. Comment only.

### Stage-E outcome

On re-inspection, items 1 and 2 were **already resolved** on
`create-procela-main` ahead of this pass:

- **Phantom field read (1)** — `routes/analysis.ts:270` already reads the
  correct `s.deputyOwnerId`, and `analysis-routes.test.ts` carries a
  regression test asserting the system-deputy fact fires for a system with
  a distinct deputy. No change needed.
- **Agent-schedule persistence bypass (2)** — `runScheduleNow` already
  persists the advance (`lastRunAt` / `runCount` / `nextRunAt` / `status`)
  through `agentSchedulesRepo.update()`, with an inline comment explaining
  why a bare `saveStore` lost these under Postgres. No change needed.
- **Stale doc (3)** — *fixed.* The `refresh-tokens.repo.ts` header no
  longer claims "No consumer is wired yet"; it now records that the repo is
  wired into `routes/auth.ts` (login upserts, refresh rotates,
  logout/SLO/session revocation remove), which a grep of `auth.ts`
  confirms across ~14 call sites.

With this, every audit section (A–G) is closed.

---

## F. Real vs mocked — a "tight v1" should not ship simulated surfaces

The on-prem connector agent, dbt Cloud integration, and manual lineage are
**real**. These are **not**, and should be finished, hidden, or clearly
labelled before GA:

- **In-app direct-connect discovery** (`connector.service.ts`) — an
  explicit mock for DATABASE / API / WAREHOUSE types; only LOCAL file
  upload reads real bytes. (Real discovery today runs through the on-prem
  agent + dbt.)
- **`SyncConnection` DATABASE source** — `generateMockRows`; URL
  (CSV/JSON) sources are real.
- **`SyncConnection.schedule` auto-run** — no background runner consumes
  `enabled`/`nextRunAt`; only manual `/run`. Auto-scheduling is
  aspirational.
- **Secrets at rest** — `DbtCloudConnection.token` and
  `OidcProvider.clientSecret` are stored plaintext; route them through the
  existing KMS layer before GA.

### §F outcome (mock-surface labelling)

The three simulated surfaces are now **honestly labelled** in the product so
GA does not ship stubs that look like finished features. We labelled rather
than hid — the simulated paths are still genuinely useful for demos and
onboarding, and hiding them would remove the only way to exercise the flow
before the real drivers land.

- **Direct-connect discovery** — `ConnectorResult` carries a structured
  `simulated` flag (`true` for the API/WAREHOUSE/SPREADSHEET mock, `false`
  for real LOCAL file parsing). The Connections page Discover modal renders
  a warning banner when `simulated` is true, so sample metadata is never
  mistaken for a live read.
  - **Update — now real for databases (Phase 3 shipped).** A configured
    direct-connect **DATABASE** (Postgres/MySQL/SQL Server/Oracle) now runs
    real catalog discovery (`lib/db-source/introspect.ts`, `simulated:false`),
    measures data quality live over the connection for the five pushdown-safe
    rule types (`lib/db-source/dq-sql.ts` + `services/dq-db.ts`), and offers a
    suggest-and-confirm **reconciliation** flow that folds discovered assets
    into the governed catalog. Discovered-asset **health** now grades change
    over time on both scan paths (on-prem connector report + direct-connect
    reconcile): a persisted schema fingerprint flags a changed column set —
    raising an auto-resolving `SCHEMA_DRIFT` governance issue — and a graded
    row-count-delta penalizes a shrink (`lib/schema-drift.ts`). See
    `docs/ROADMAP.md` Track A.
  - **Update — now real for the non-relational sources too (Track E shipped).**
    Direct-connect discovery is now real beyond relational databases: cloud
    **warehouses** (Snowflake/BigQuery/Databricks/Redshift), **MongoDB**, and
    cloud **object storage** (S3/Azure Blob/GCS/SFTP, incl. Parquet/Avro schema)
    all set `simulated:false` and reconcile through the same path. Only **API**
    and **SPREADSHEET** connection types, and the REGEX_MATCH/CUSTOM DQ rule
    types, remain simulated-and-labelled. See `docs/non-relational-discovery.md`
    and `docs/ROADMAP.md` Track E.
- **`SyncConnection` DATABASE source** — _(interim; superseded — see the
  §F live-driver outcome below.)_ Was relabelled "Database Table (simulated)"
  while drivers were unwired; the source now connects for real (Postgres /
  MySQL / SQL Server) with simulation demoted to an explicit `sampleData` opt-in.
- **`SyncConnection.schedule` auto-run** — _(interim; superseded — see the
  §F auto-runner outcome below.)_ The scheduled-polling toggle used to note
  that no background runner was active; a leader-gated runner now consumes
  `enabled`/`nextRunAt`.
- **Secrets at rest** — done earlier in §F via the KMS/crypto layer (dbt
  Cloud token + OIDC client secret now encrypted; see the secrets PR).

Deferred (product work, not labelling): actually finishing live database
discovery drivers and building the background schedule runner. These are the
"finish it" half of §F and belong on the post-cutover roadmap, not this
mechanical labelling pass.

**§F sync-persistence outcome — done.** The sync engine now persists its
target entities through their repositories, so a run writes to Postgres (not
just the JSON file). This required real `syncConnectionId` / `syncStatus`
columns on the four target models (Organization, Person, System,
GlossaryTerm) — added via migration and mapped in each repo — so a run can
update its own prior rows and flag those dropped from the source. A
live-Postgres test covers create + idempotent re-run.

**§F auto-runner outcome — done.** The `schedule.enabled` / `nextRunAt`
fields are now consumed by a real background runner. The `/run` body was
extracted into a reusable `runSync(sc)`; a leader-gated `tickSyncScheduler`
(registered via `startBackgroundSweep(..., { leaderOnly: true })`, the same
leader-election path as the agent-schedule / DQ tickers) runs enabled syncs
whose `nextRunAt` is due, on exactly one replica with failover. An in-flight
guard stops a slow run overlapping the next tick. Live-Postgres tests cover a
due sync firing + advancing `nextRunAt`, and a disabled sync being skipped.

**§F live-driver outcome — done (direct-connect).** The DATABASE source is no
longer simulated by default. A driver layer (`lib/db-source/`) connects
directly to **PostgreSQL, MySQL, and SQL Server** (`pg` / `mysql2` / `mssql`),
builds an engine-appropriate `SELECT` (identifier-validated to close the
injection boundary; `LIMIT` vs SQL Server `TOP`), and returns real rows the
sync upserts. Credentials resolve from the referenced Connection profile, never
the sync row. Behaviour is **fail-loud**: a DATABASE sync that can't reach its
source records a failed run and flips to `ERROR` — no silent mock fallback.
Simulation is now an **explicit** opt-in (`config.sampleData = true`), surfaced
in the wizard as a "use sample data" toggle, so seeded demos still work. Pure
SQL/normalization unit tests plus a live-Postgres end-to-end (real table →
real rows) and a fail-loud test cover it.

**§F agent-push outcome — done.** The on-prem connector can now sync **row
data**, not just discovery metadata. A sync's `executionMode` is `DIRECT`
(cloud pulls) or `AGENT` (connector pushes); an `AGENT` sync binds to a
connector. The connector polls `GET /connectors/sync-jobs` (its due jobs,
scheduled server-side), runs each query against its LOCAL source
(`packages/connector/src/sync.ts`, reusing its `pg`/`mysql2`/`mssql`
drivers), and `POST`s the rows to `/connectors/sync-jobs/:id/push` over
outbound HTTPS — no inbound access to the customer network. The push reuses
the same `applySyncRows` (upsert + missing-from-source + schedule advance) as a
direct run, so an agent sync behaves identically once rows arrive. Auth is the
existing connector token (`requireConnectorToken`); a connector can only fetch
and push its own org's assigned syncs. The direct auto-runner skips `AGENT`
syncs. The wizard offers the direct-vs-connector choice with a connector
picker. Covered by connector unit tests and live-Postgres tests (job fetch,
push persistence, token auth, cross-connector isolation, auto-runner skip).

**§F Oracle-engine outcome — done.** `ORACLE` is now a first-class sync engine
on **both** paths. The backend gains an `oracledb` (thin-mode) direct-connect
driver (`lib/db-source/oracle.ts`) and the connector runs Oracle jobs with the
`oracledb` driver it already carries for discovery. The SELECT builder emits
Oracle's dialect — bare (validated) identifiers so upper-case folding matches
the stored object, and `FETCH FIRST n ROWS ONLY` instead of `LIMIT`. `ORACLE`
joins the supported-engine set, the `dbType` unions/enums, and the wizard
dropdowns. Unit tests cover the Oracle dialect + injection rejection; a
live-Postgres test proves an `ORACLE` sync reaches a real connection attempt
(rather than the unsupported-engine guard). With this, **every §F sync item is
closed** — direct-connect and agent-push both cover Postgres, MySQL, SQL
Server, and Oracle.

---

## G. Deploy / manage / stability (the operational half of "tight")

- **Scheduler multi-replica safety — highest-severity.** The backend has
  **15 in-process timer sites** (governance overdue-sweep, the
  agent-schedule ticker that makes real Claude calls, weekly digest, DQ
  rule runs, dbt polling, auth-token sweepers) with **no leader-election
  or single-instance guard**. The design mandates stateless, horizontally
  scalable services — but with >1 replica every replica fires all timers,
  causing duplicated AI spend, duplicate user notifications, and races on
  `nextRunAt`. Fix: a `SCHEDULER_ENABLED` role flag, a Postgres advisory
  lock, or an external scheduler.
  - **§G scheduler outcome — done.** A Postgres-backed leader election
    (`lib/scheduler-leadership.ts` + the `scheduler_leases` table) now elects
    exactly one owner across identical replicas via an atomic conditional
    lease upsert, renewed on a heartbeat and failing over on TTL expiry.
    The shared/costly timers (overdue sweep + weekly digest, the
    agent-schedule ticker, DQ runs, dbt polling, offline-connector scan) gate
    their tick on `isSchedulerLeader()`; per-instance in-memory cache sweeps
    (rate-limit, OIDC/SAML/WebAuthn/MFA caches) are intentionally left to run
    on every replica. Single-instance / JSON mode is always the owner (no
    election). Live-Postgres test covers one-owner + failover.
- **RBAC not enforced on domain writes.** ~~The `authorize(...roles)`
  middleware exists but is applied to only 9 endpoints…~~
  - **§G RBAC outcome — done.** A mount-level `requireResource('<bucket>')`
    guard (`lib/permissions.ts`, wired once per router in `index.ts`) now
    role-gates writes across every catalog / governance / org / connection /
    agent / collaboration router: reads stay open to any authenticated user,
    mutating verbs require the bucket's `:write` permission, so a **VIEWER**
    can no longer create/edit/delete catalog entities. The mount table in
    `index.ts` is the reviewable policy surface; the full bucket→role matrix
    is in `docs/RBAC_PERMISSION_MATRIX.md`. Two shared surfaces that had
    slipped into the any-authenticated bucket were closed: the **skills**
    catalog now has its own `skill` bucket (writes EDITOR+), and **reports**
    now owner-scope edit/delete (only the owner may change a report, matching
    analysis-reports). Covered by permission + route tests.
- **Config surface has undocumented knobs.** The backend reads **60
  distinct env vars** but `.env.example` documents **49** (~11
  undiscoverable without grepping source). Only 6 are `PROD-REQUIRED`
  (good — deploy stays simple). Close the doc gap.
  - **Done.** Every `process.env.*` the backend reads is now documented in
    `.env.example`, kept honest by a test guard
    (`__tests__/env-documented.test.ts`) that fails CI on any undocumented
    read — so the gap can't silently re-grow.

---

## Prioritized execution plan (staged, migration-safe)

Ordered by value-for-a-tight-v1 and independence. Each stage is its own
PR; removals re-confirm their evidence and ship the migration together.

1. **Stability first (no schema):** scheduler single-owner guard (G),
   the two correctness bugs (E1, E2), enforce RBAC on domain writes (G).
   These protect a real multi-replica deployment.
2. **Dead-column sweep (migration):** the 8 columns + 3 relations + 1
   index from A, as one reviewed migration with the type/fixture updates.
   Pure subtraction, no behavior change.
3. **Consolidation (migration):** the B pairs — collapse the duplicated
   owner/role/title/integration fields onto one representation each.
4. **Low-value decisions (C):** per field, surface-or-remove. Removals
   fold into a second small migration.
5. **Consistency (D):** owner-FK rename and timestamp retyping — one
   mechanical migration.
6. **Real-vs-mocked (F):** for each simulated surface, either finish it or
   hide/label it so GA ships only real features; move the two plaintext
   secrets to KMS.
7. **Config docs (G):** document the ~11 undocumented env vars.

**Net effect:** ~8 columns and 3 relations removed, ~5 redundant fields
consolidated, ~12 low-value fields resolved, the scheduler made
replica-safe, RBAC enforced, and no user-facing simulated features — a
tighter, stabler, more manageable v1 where every remaining field earns its
place.
