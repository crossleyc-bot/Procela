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

## Track E — canonical data-model gaps

*From the **Canonical EDM Review** (a shipbuilder's enterprise data model,
14 capabilities · 52 domains · 195 sub-domains · 30 entities, cross-checked
against Procela's model). Most of that review is already built — sub-domains,
system-of-record, the master-data signal, CUI/ITAR/export classification,
structured hierarchical codes, and entity primary-keys/relationships all
shipped. These are the items it flagged as **still open**.*
**Size: one large bet (E2), the rest small–medium.**

- **E1 — Business Capability level above Data Domain.** The file's taxonomy
  is Capability → Domain → Sub-Domain → Entity; Procela's data hierarchy
  tops out at Domain (a Capability level exists only in the *process* tree).
  Add the top rung so the data model matches how enterprises group domains.
  *Fit: extends the domain hierarchy. Effort: medium.*
- **E2 — Shared / co-stewardship register.** The review's most sophisticated
  idea: data jointly governed by two capabilities, each shared boundary
  recording a primary + co-steward, the shared assets, decision authority,
  and an escalation path. Procela has multiple stewards but all within one
  org — a cross-org/-capability co-steward with explicit decision rules is a
  genuine differentiator (the ungoverned "seams" between teams are exactly
  the incidents Procela exists to prevent). *Fit: new cross-org governance
  concept. Effort: high.*
- **E3 — Data-model versioning for domains & assets.** Process nodes already
  have proposed-vs-approved snapshotting + a change log; bring domains and
  data assets up to the same, so a model change is reviewable rather than
  silent. *Currently partial (process nodes only). Effort: medium.*
- **E4 — Partition / business dimension (the "hull" concept).** Slice a
  domain's data by a business key — hull, region, program, product line —
  with per-partition stewardship. Powerful but specialized; generalize only
  if multiple customers ask. *Effort: medium–high, deliberately deferred.*
- **E5 — Source-scope → domain mapping.** The Phase-3 Discover loop (real
  scan → measured DQ → reconcile into the catalog) shipped; the remaining
  refinement is auto-mapping a connector's scan scope to the domains it
  feeds, so discovered assets land in the right domain without hand-sorting.
  *Fit: extends the Discover loop. Effort: small–medium.*

---

## Snapshot

| Track | Theme | Size | Gated on |
|---|---|---|---|
| **A** | Phase 3 discovery loop — built; only the real-customer pilot (A1) remains | Large | A real customer DB to pilot against |
| **B** | Production-scale hardening | Medium | A running deploy (task #3) |
| **C** | Commercial SaaS readiness | Large / Med / Small | Go-to-market = self-serve SaaS |
| **D** | Depth on existing features | Small–Med | Nothing; incremental anytime |
| **E** | Canonical data-model gaps (EDM review) | Large (E2) / Small–Med | Nothing; incremental anytime |

**Not yet decided:** which track leads. That is a go-to-market call, not a
technical one — capture the decision here when it's made and sequence the
items above accordingly.
