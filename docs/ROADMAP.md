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

So this roadmap is **not** about filling core gaps. It is the four
frontiers a feature-complete platform hasn't crossed because it has never
been run in production against a real customer. Sequencing across Tracks
A/B/C is a **go-to-market decision** (Phase-3-differentiator vs.
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
**Size: large. The core differentiator — now built.**

- **A1 — Real-customer connector pilot.** Run the shipped agent against a
  live customer database (GO_LIVE_CHECKLIST **#25**'s sole remaining
  item). Everything upstream is done and green in CI; this is the first
  real-world scan and the thing that proves the whole Phase-3 thesis.
- **A2 — Discovered-asset → business-definition reconciliation.**
  _Shipped._ A suggest-and-confirm reconciliation flow matches each
  discovered table to an existing business-defined asset (by name
  similarity) or creates a new Bronze `DataAsset`, materializing its
  columns so DQ rules can attach — the bridge between the technical and
  business layers that Procela's premise rests on. Connection-rooted from
  the Connections **Discover** view.
- **A3 — Source-fed health scores.** _Delivered._ Both the on-prem
  connector **and** a direct-connect database now feed **measured**
  `health_score` from real DQ results for the five pushdown-safe rule types
  (null-rate via NOT_NULL, uniqueness, set/range/length checks); the
  direct-Connection DQ-simulation gap is closed, so a cloud-reachable
  database measures too. Freshness/row-count already drove the connector's
  discovered-asset health, now joined by **schema-drift** (a persisted
  column-set fingerprint on `DataAsset` is compared each scan — a changed
  column set penalizes the health score and raises an auto-resolving
  `SCHEMA_DRIFT` governance issue) and a **graded row-count-delta** (a shrink
  scored by magnitude). Both signals now cover **both scan paths**: the
  connector report ingest, and the cloud-reachable **direct-connect
  discover/reconcile** flow — introspection reads approximate row counts from
  engine catalog statistics, and reconciling a source refreshes the asset's
  fingerprint + liveness health and raises the same `SCHEMA_DRIFT` issue on a
  changed column set. (Direct-connect fingerprints are column-name-based;
  introspection doesn't fetch column types, so a pure retype isn't flagged
  there.)

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

## Track D — depth on what's already built

*Lower-risk iteration on working foundations. Month-2+ material; no
architectural unknowns.*
**Size: small–medium, incremental.**

- AI-assistant deepening (the `chat` surface and catalog-context prompts
  are live).
- Notification / digest maturity (the `notifications` and `digest`
  surfaces exist).
- Reporting / export polish (Report Builder, executive/operational
  dashboards, PDF/CSV export all ship).

---

## Snapshot

| Track | Theme | Size | Gated on |
|---|---|---|---|
| **A** | Phase 3 discovery loop — built; only the real-customer pilot (A1) remains | Large | A real customer DB to pilot against |
| **B** | Production-scale hardening | Medium | A running deploy (task #3) |
| **C** | Commercial SaaS readiness | Large / Med / Small | Go-to-market = self-serve SaaS |
| **D** | Depth on existing features | Small–Med | Nothing; incremental anytime |

**Not yet decided:** which track leads. That is a go-to-market call, not a
technical one — capture the decision here when it's made and sequence the
items above accordingly.
