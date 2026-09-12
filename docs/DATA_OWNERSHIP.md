# Data Ownership — UI vs. Edge Agents

Which tables and columns are written by the interactive **UI / REST API**
versus the on-prem **edge agent** (`@procela/connector`).

## The governing principle

The edge agent **never writes Procela's database directly.** It runs inside
the customer's network, scans their *own* source databases (Postgres, Oracle,
MySQL, SQL Server) for catalog metadata, and ships **metadata only** — table
names, row counts, freshness timestamps, column names/types — back over an
outbound HTTPS connection. No row data, no connection strings, no credentials
cross the wire. See [`../packages/connector/README.md`](../packages/connector/README.md).

The Procela **backend** performs every database write, on behalf of connector
traffic arriving at three endpoints:

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /connectors/pair/claim` | pairing code | Exchange a one-time code for a long-lived bearer token |
| `POST /connectors/heartbeat` | connector token | Liveness ping |
| `POST /connectors/report` | connector token | Ship a metadata snapshot (assets + columns) |

Every agent-driven write is deliberately **additive / audit-only**: the agent
path *creates* and *refreshes*, but it **never deletes** rows and **never
overwrites** the governance/ownership fields a human curates in the UI. A
report that omits `columns[]` (an older agent) skips the column block
entirely, so it can never wipe a hand-curated schema.

Of the ~60 models in the Prisma schema, the agent path touches exactly
**four tables**. Everything else is 100% UI / API.

---

## The four tables the edge-agent path writes

### `connectors` — co-managed
The UI creates and configures the connector row; the agent maintains its
token and liveness.

| Column | Written by |
|---|---|
| `id`, `orgId`, `name`, `systemIds` | **UI** (`pair/start`; `PATCH /:id` to rename / re-scope) |
| `pairingCode`, `pairingCodeExpiresAt` | **UI** sets at `pair/start`; **agent** clears at `pair/claim` |
| `tokenHash` | **agent** (minted on `pair/claim`; stored as a SHA-256 hash) |
| `agentVersion`, `lastHeartbeatAt` | **agent** (`claim` / `heartbeat` / `report`) |
| `status` | **agent** → `ONLINE` on claim; **server** offline-scan → `OFFLINE`; delete route → `REVOKED` |
| `createdAt`, `updatedAt` | system |

### `connector_events` — agent / system telemetry (read-only in UI)
Entirely written by the agent path: `PAIRED` and `ASSETS_REPORTED` rows, with
per-report counts in the `data` JSON. The UI only reads them
(`GET /connectors/:id/events`).

### `data_assets` — co-managed; the agent owns only a freshness slice
| Column | Written by |
|---|---|
| `name`, `description`, `systemId` | **UI** — but the agent will **create** a new asset (as `BRONZE`) with these if `/report` discovers a table not yet in the catalog |
| `healthScore`, `healthScoreAt`, `lastSyncedByConnectorId`, `lastSyncedAt` | **agent** (`/report` freshness refresh) |
| `ownerPersonId`, `stewardIds`, `dataDomainId`, `governanceTier`, `sensitivityTags`, `rejectedSensitivityTags`, `dataClassification`, `dataType`, `refreshFrequency`, `origin`, `retentionDuration`, `retentionReason` | **UI only** — the agent never touches any governance / ownership field |

### `data_asset_columns` — co-managed; the agent is the primary populator
| Column | Written by |
|---|---|
| `columnName`, `dataType`, `sourceAsset`, `sourceColumn` | **agent** (`/report` — creates new columns, refreshes a changed `dataType`) **and UI** — binding an asset to a named column set materializes a governed column row per bound column (with its source pointers), and column auto-discover pulls the bound set from the connection |
| `description`, `sourceConnectionId` | **UI** (manual curation) |
| `createdAt`, `updatedAt` | system |

Audit-only here too: columns that stop being reported are left in place, and a
manually-added (or binding-materialized) column is never overwritten except for
a `dataType` refresh. Materialization is idempotent — re-binding the same set
never duplicates a column.

---

## Two discovery paths, one catalog

Procela has two ways to populate the data catalog, and they write the **same
two tables** (`data_assets` + `data_asset_columns`) with the **same field
shapes**:

- **Option 1 — direct Connection.** Procela connects straight to the source
  (a SaaS deployment reaching a reachable warehouse, or an operator using the
  in-app Sync / Connection flow). It can Test the connection, Discover tables,
  introspect columns live, and run data-quality rules against live data.
- **Option 2 — edge connector.** The `@procela/connector` agent runs inside
  the customer's network and ships metadata outbound. Used when the source is
  not directly reachable from Procela.

**The connector writes the same columns a direct Connection does — and both run
_measured_ DQ for the five pushdown-safe rule types** (a direct database
Connection runs them as a pushdown query over the live DB; the connector runs
them on-prem). Everything the agent's `/report` writes, a direct Connection also
writes — into the same columns:

| What arrives | Table · columns | Option 1 (Connection) | Option 2 (connector) |
|---|---|---|---|
| Table exists (name, owning system) | `data_assets` · `name`, `description`, `systemId` | ✅ creates/updates | ✅ creates as `BRONZE` if new |
| Freshness (row count, last-synced, health) | `data_assets` · `healthScore`, `healthScoreAt`, `rowCount`, `lastSyncedByConnectorId`, `lastSyncedAt` | ✅ | ✅ |
| Schema-drift baseline (column-set fingerprint) | `data_assets` · `schemaFingerprint` | ✅ set on reconcile | ✅ set on report |
| Change-over-time signals (schema drift → `SCHEMA_DRIFT` issue; graded row-count shrink) → liveness health | derived each scan from `schemaFingerprint` + `rowCount` | ✅ direct-connect reconcile | ✅ connector report |
| Column names & types | `data_asset_columns` · `columnName`, `dataType`, `sourceAsset`, `sourceColumn` | ✅ live introspection | ✅ from the report |
| Live column introspection on demand (Test / Discover) | — | ✅ | ❌ metadata push only |
| Data-quality rule execution | `DataQualityRule` results | ✅ 5 pushdown types measured live (aggregate query); REGEX_MATCH/CUSTOM simulate | ✅ 5 pushdown types measured on-prem; REGEX_MATCH/CUSTOM simulate |

Option 1 adds interactive **Test / Discover** and live column introspection on
demand. Both options run **measured** DQ for the five pushdown-safe rule types
(NOT_NULL, UNIQUE, IN_SET, NUMERIC_RANGE, LENGTH_RANGE) — a direct database
Connection as an aggregate pushdown query over the live DB, the connector on-prem
on its scan cadence. For the connector, aggregate pass/fail counts cross the
wire; row values never do. (Data-warehouse Connections and REGEX_MATCH/CUSTOM
rules still simulate.)

> **Displayed health is measured-DQ only.** The `healthScore` a scan writes is
> the connector's freshness signal and is kept as stored state, but it is **not**
> what the UI shows as the asset's health. Displayed health is derived at read
> time from *measured* (non-simulated) DQ rules: an asset shows its rolled-up
> score only when a measured rule backs it, and **0%** otherwise. So a
> freshly-synced asset with no measured rule reads 0% health until a rule runs
> against it — freshness drives the "Synced N ago" chip, not the health number.

**Neither path copies raw rows into Procela.** Both persist *metadata about* the
data; the actual records stay in the source system.

Because both paths land in the same `data_assets` table, everything
downstream is **source-agnostic**: mapping to process steps, gap detection,
governance, lineage, and the dashboards all read `data_assets` and never ask
where a row came from. Connector-discovered tables simply arrive
**Bronze / unowned / unmapped** — they show up as orphan work items for a
steward to classify and map, exactly like any hand-added asset that hasn't been
governed yet.

---

## Everything else is UI / API-only

All other models are never written by the connector path, including:

- **Process hierarchy** — `ProcessNode` (and its `*Org` / `*Control` /
  `*Skill` / `*System` join tables), `FlowRelationship`
- **Registry & mapping** — `System`, `DataDomain`, `DataAsset*` stewards/bindings,
  `Mapping`, `DataLineageLink`, `AssetLineageEdge`, `DataQualityRule`
- **Governance** — `GovernanceTask`, `GovernanceIssue`, `GovernancePolicy`,
  `GovernanceControl`, `GovernanceGroup`, `GovernanceProgram`, `DecisionRight`
- **People & skills** — `Person`, `PersonOrg`, `Skill`, `PersonSkill`,
  `DamaRole`, `RaciOverride`
- **Docs & ops** — `Sop`, `GlossaryTerm`, `OperationsManual`, `CalendarEvent`,
  `Comment`, `Attachment`, `Tag`, `SavedView`, `Report`, `AnalysisReport`
- **Sync / dbt** — `SyncConnection`, `Connection`, `ConnectionSystemLink`,
  `DbtCloudConnection`, `DbtAssetMapping`, `DbtTestMapping`
- **Platform** — `Organization`, `AppSetting`, `AuditLog`, `Notification`,
  `RefreshToken`, `OidcProvider`, `ScimGroup`, snapshots, `SuggestionDismissal`

### Not an edge agent
The `Agent` / `AgentSchedule` / `AgentExecution` models describe the in-app
**AI** agent (`agentType = "AI"`, with `instructions` and `skillIds`), which
runs **server-side** and is fully UI-managed. Despite the name, it is not an
edge / on-prem agent and shares nothing with the connector path.

### Connector-triggered server automation
Two writes are triggered by connector traffic but are **server-side
automation**, not the UI and not the agent itself:

- the scheduled offline-scan flips `connectors.status` to `OFFLINE` and inserts
  a `notifications` row when a connector goes silent past its threshold;
- connector auth events append `PAIRED` / `BACK_ONLINE` rows to `audit_logs`.
