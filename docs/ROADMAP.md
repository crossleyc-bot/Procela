# Procela post-cutover roadmap

The prototype scope in [`../CLAUDE.md`](../CLAUDE.md) is built and then
some. Phase 1 (**Define**) and Phase 2 (**Connect**) are complete —
process catalog, industry templates, data & system registry,
process-to-data mapping, gap detection, AI assistant, governance program
(DAMA roles, RACI, decision rights, policies, controls, calendar, tasks,
issues, maturity trends), lineage, quality, glossary, SCIM, MFA/WebAuthn,
exports, and org visualization all ship today. The Postgres cutover and
the GA tightening audit (§A–§G) are merged; the deploy path is wired and
verified (see [`PILOT_GO_LIVE_WORKSHEET.md`](./PILOT_GO_LIVE_WORKSHEET.md)).

So this roadmap is **not** about filling core gaps. It is the frontiers a
feature-complete platform hasn't crossed because it has never been run in
production against a real customer. Sequencing across Tracks A/B/C is a
**go-to-market decision** (Phase-3-differentiator vs.
run-real-customers-safely vs. self-serve-SaaS) and is intentionally left
open here — this doc captures scope, not order.

Cross-references: the go-live *tail* lives in
[`GO_LIVE_CHECKLIST.md`](./GO_LIVE_CHECKLIST.md) (item numbers cited
below); operator steps in
[`PILOT_GO_LIVE_WORKSHEET.md`](./PILOT_GO_LIVE_WORKSHEET.md); restore /
rollback in [`DR_RUNBOOK.md`](./DR_RUNBOOK.md).

---

## Track A — Phase 3: close the discovery loop

*The product frontier. The Discover loop is now **closed for direct-connect
databases**: a configured connection (Postgres · SQL Server · MySQL · Oracle)
runs real catalog discovery, measures data quality live, and reconciles the
results into the governed catalog. The on-prem connector agent covers
firewalled sources with the same five-engine + dbt coverage. The one
remaining item is proving it end to end against a real customer database.*
**Size: large. The core differentiator is built; only the pilot (A1) is open.**

- **A1 — Real-customer connector pilot.** Run the shipped agent against a
  live customer database (GO_LIVE_CHECKLIST **#25**'s sole remaining
  item). Everything upstream is done and green in CI; this is the first
  real-world scan and the thing that proves the whole Phase-3 thesis.

*(A2 discovered-asset reconciliation and A3 source-fed health — measured DQ,
schema-drift, graded row-count-delta, column-retype detection — are built and
merged; see the git history and the readiness record. Only A1 remains.)*

## Track B — production-scale hardening

*The go-live tail that is bigger than config. Gated on a running deploy
(the ops actions in the pilot worksheet / task #3).*
**Size: medium, ops-adjacent.**

- **B1 — Managed / HA Postgres.** Replace the Helm chart's bundled
  single-replica PostgreSQL StatefulSet with managed or HA Postgres
  (GO_LIVE_CHECKLIST **#26**).
- **B2 — On-prem smoke deploy.** The Helm chart lints `--strict` and
  `helm template`-renders across all install paths in CI, but has never
  been `helm install`ed against a live API server (**#26**). Do one real
  cluster install.
- **B3 — Load-test baseline.** The `loadtest/` harness exists and runs via
  `workflow_dispatch`; capture a baseline against a representative
  Postgres-backed deploy and tighten the per-scenario budgets from the
  generous JSON-path defaults (**#21**).
- **B4 — External pen test.** SAST (CodeQL, every PR) and the dependency
  audit are done; an external penetration test is the outstanding
  security item (**#22**).
- **B5 — DR rehearsal.** The DR runbook is written; ops owes one restore
  rehearsal against staging to record real RTO/RPO and confirm the §7
  prod-hardening prerequisites (**#23**).

## Track C — commercial SaaS readiness

*Genuinely absent subsystems. Needed only if go-to-market is self-serve
SaaS rather than white-glove enterprise onboarding.*
**Size: large (C1), medium (C2), small (C3).**

- **C1 — Billing.** No billing subsystem exists at all
  (GO_LIVE_CHECKLIST **#20**). Plans, metering, and a payment integration
  (e.g. Stripe). AI calls are already rate-limited per-org
  (`AI_MAX_CALLS_PER_ORG_PER_HOUR`/`_DAY`), which is a natural metering
  hook.
- **C2 — Self-serve org onboarding.** Org creation + industry-template
  generation exist, but there is no unauthenticated signup / tenant
  provisioning flow — a new customer can't stand themselves up without an
  operator. Depends on the IdP model (self-serve tenants need
  per-tenant IdP config, which today is env/tfvar-level).
- **C3 — Legal content.** ToS, privacy policy, and DPA are placeholder
  text; the doc hooks exist (**#18**).

## Track D — canonical data-model gaps

*From the **Canonical EDM Review** (a shipbuilder's enterprise data model,
14 capabilities · 52 domains · 195 sub-domains · 30 entities, cross-checked
against Procela's model). Most of that review is already built — sub-domains,
system-of-record, the master-data signal, CUI/ITAR/export classification,
structured hierarchical codes, and entity primary-keys/relationships all
shipped. These are the items it flagged as **still open**.*
**Size: one large bet (D2), the rest small–medium.**

- **D1 — Business Capability level above Data Domain.** The file's taxonomy
  is Capability → Domain → Sub-Domain → Entity; Procela's data hierarchy
  tops out at Domain (a Capability level exists only in the *process* tree).
  Add the top rung so the data model matches how enterprises group domains.
  *Fit: extends the domain hierarchy. Effort: medium.*
- **D2 — Shared / co-stewardship register.** *(Customer-gated,
  isolation-sensitive — do not build on spec.)* The review's most
  sophisticated idea: data jointly governed by two capabilities, each shared
  boundary recording a primary + co-steward, the shared assets, decision
  authority, and an escalation path — a genuine differentiator (the
  ungoverned "seams" between teams are exactly the incidents Procela exists
  to prevent). But it deliberately cuts across the strict per-`org_id`
  multi-tenant isolation the B4 security work just hardened: a cross-org
  shared boundary is new access-control surface where a scoping bug leaks
  data. Build only against a real customer that needs it, and treat it as a
  security-sensitive isolation design, not just a feature. *Fit: new
  cross-org governance concept. Effort: high.*
- **D3 — Data-model versioning for domains & assets.** Process nodes already
  have proposed-vs-approved snapshotting + a change log; bring domains and
  data assets up to the same, so a model change is reviewable rather than
  silent. Reuses an existing, proven pattern — the low-risk item on this
  track. *Currently partial (process nodes only). Effort: medium.*
- **D4 — Source-scope → domain mapping.** The Phase-3 Discover loop (real
  scan → measured DQ → reconcile into the catalog) shipped; the remaining
  refinement is auto-mapping a connector's scan scope to the domains it
  feeds, so discovered assets land in the right domain without hand-sorting.
  A bounded automation layer on a loop that already exists. *Fit: extends
  the Discover loop. Effort: small–medium.*

*(Dropped: a partition / business-dimension "hull" concept — slicing a domain
by a business key with per-partition stewardship. Reviewed and cut as too
specialized for the complexity it adds; revisit only if multiple customers
ask for it.)*

## Track E — non-relational source discovery

*Broaden Discover beyond relational databases. Track A closed the loop
(real scan → measured DQ → reconcile into the catalog) for the four SQL
engines. Everything **non**-relational is only partly there: the connection
catalog already exposes object storage (S3 · Azure Blob · GCS · SFTP),
NoSQL (MongoDB), cloud warehouses (Snowflake · BigQuery · Redshift ·
Databricks), APIs, and spreadsheets as first-class categories — with
reachability probes — but their discovery returns **hardcoded sample assets
flagged `simulated: true`**, not real introspection. The one real
non-relational path today is a **manual local-file upload** (CSV/TSV/JSON/
JSONL/NDJSON), which is genuinely parsed. This track turns the mocked
categories into real discovery, reusing the same discovery → DQ → reconcile
plumbing rather than a parallel pipeline. Each item is independent and
customer-gated — build the source a real pilot actually has.*
**Size: large. E2 (MongoDB) shipped; sequence E1/E3 by customer need.**

- **E1 — Object storage + file schema inference. ✅ Shipped.** Both halves are
  done. *Columnar formats:* the local-file connector reads **Parquet** (footer
  metadata) and **Avro** (OCF header) schemas, surfacing leaf columns as dotted
  paths (structs → `addr.city`) and the row count, reachable by uploading a
  `.parquet` / `.avro` through the LOCAL file path (`simulated: false`); DQ on
  those stays simulated (their values aren't read synchronously yet).
  *Remote object-listing:* an **S3**, **Azure Blob**, **GCS**, or **SFTP**
  file-storage connection lists a bucket/prefix (or remote directory),
  downloads each parseable object, and infers its schema with the same analyzer
  (`simulated: false`). All four sit behind one provider-agnostic `ObjectStore`
  interface with a shared, testable orchestrator (`lib/object-storage/`); auth
  is per provider (S3 IAM-role/keys, Azure account-key/SAS, GCS ADC/key, SFTP
  password/private-key), and SFTP runs the same host SSRF guard as the DB
  drivers. *(The live cloud/SFTP adapters are thin SDK wrappers, validated only
  against a real endpoint; the orchestration they feed is unit-tested against a
  fake store.)*
- **E2 — MongoDB / document-store discovery. ✅ Shipped.** Real discovery for a
  configured `MONGODB` connection: list collections, sample documents per
  collection, and infer a field/type schema — union of keys, per-field BSON
  type, polymorphic fields collapsed to a joined descriptor (e.g. `int|string`),
  approximate `estimatedDocumentCount` as the row count. Surfaces the same
  `DiscoveredAsset` shape as the SQL path (`simulated: false`), so it reconciles
  through the identical downstream flow. Row *sync* stays out of scope — Mongo
  is discovery-only for now. *(see `lib/db-source/mongo-introspect.ts`.)*
- **E3 — Cloud warehouse discovery. Redshift · Snowflake ✅ shipped; BigQuery /
  Databricks open.** A `DATA_WAREHOUSE` connection runs real discovery for two
  engines now. **Redshift** speaks the PostgreSQL wire protocol and exposes
  `information_schema`, so it reuses the `pg` driver and the Postgres dialect
  with no new dependency (only its row-count differs — `svv_table_info`).
  **Snowflake** has a distinct connection model (account + warehouse + database,
  not host:port), so — like MongoDB — it gets its own module
  (`lib/db-source/snowflake-introspect.ts`): `snowflake-sdk`, parameterised
  `INFORMATION_SCHEMA` catalog SQL, and the shared `groupAssets` / `applyRowCounts`
  grouping. Reachable through the warehouse form (account, warehouse, database,
  schema). **BigQuery** and **Databricks** remain simulated — each needs its own
  driver (`@google-cloud/bigquery`, a Databricks SQL client) and a live account
  to validate. *Fit: new drivers on a proven interface. Effort: medium per
  remaining engine.*
- **E4 — Deep semi-structured parsing (cross-cutting). ✅ Shipped.** A shared
  pure flattener (`lib/flatten-paths.ts`) walks a JSON row or a Mongo document
  into dotted leaf paths — `{ address: { city } }` is catalogued as
  `address.city`, not one opaque `address` blob. Wired into both the local-file
  JSON reader (discovery *and* the DQ column reader, which now resolves a dotted
  path) and the Mongo inference (E2). Depth-bounded; BSON wrappers (ObjectId,
  Decimal128) and `Date` are leaves. *Arrays stay a single leaf* — descending
  into array elements would yield many values per (row, column) and break the
  one-value-per-row contract the DQ reader relies on, so array-element
  flattening is a deliberate future step, not part of this.

*Acceptance bar for E1–E3: discovered assets are real (`simulated: false`),
flow through reconciliation, and either get a real measured-DQ path or are
explicitly marked N/A — no mock rows reaching the governed catalog.*

---

## Snapshot

| Track | Theme | Size | Gated on |
|---|---|---|---|
| **A** | Phase 3 discovery loop — built; only the real-customer pilot (A1) remains | Large | A real customer DB to pilot against |
| **B** | Production-scale hardening | Medium | A running deploy (task #3) |
| **C** | Commercial SaaS readiness | Large / Med / Small | Go-to-market = self-serve SaaS |
| **D** | Canonical data-model gaps (EDM review) | Large (D2) / Small–Med | Nothing; incremental anytime |
| **E** | Non-relational source discovery — object storage, NoSQL, warehouses | Large | A pilot customer with that source type |

**Not yet decided:** which track leads. That is a go-to-market call, not a
technical one — capture the decision here when it's made and sequence the
items above accordingly.
