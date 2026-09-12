# Procela — Open Work, Deferrals & Recommendations

*One consolidated register of everything **not yet finished**: open, pending,
deferred, partially-complete, out-of-scope, plus suggestions/recommendations.
It aggregates the sources that previously tracked this separately —
[`ROADMAP.md`](./ROADMAP.md) (strategic tracks A–E), [`future-work.csv`](./future-work.csv)
(itemized backlog), [`capability-matrix.csv`](./capability-matrix.csv) (per-feature
coverage), [`non-relational-discovery.md`](./non-relational-discovery.md) (discovery
gaps), [`GO_LIVE_CHECKLIST.md`](./GO_LIVE_CHECKLIST.md), and the
[GA tightening audit](./GA_TIGHTENING_AUDIT.md). Each item cites its home so you
can drill in. **Last reconciled: 2026-09-12.***

> **How to read this.** Priorities: **P0** = required for a credible production
> v1 · **P1** = important, not blocking · **P2** = differentiator/nice-to-have ·
> **P3** = long-term parity, not being pursued now. "State" is the
> capability-matrix status (Built / Partial / Designed / Not Started) or a
> backlog status (Backlog). Track = the `ROADMAP.md` track it rolls up to.

---

## Snapshot

- **Functionally near-complete.** Of ~80 tracked capabilities, **64 are Built**;
  16 are not (6 Partial · 2 Designed · 8 Not Started). Phases 1 (Define) and 2
  (Connect) ship in full; Phase 3 (Discover) is built for direct-connect and
  needs a real-customer pilot.
- **Only two open items genuinely gate a production v1 (both P0):**
  1. **Stand up production / multi-tenant SaaS hosting** (Designed).
  2. **SQL / query-log lineage extraction** (Partial — the dbt half ships).
- Everything else is a deliberate P2/P3 defer, a GTM-gated bet, or polish-level
  backlog.

---

## 1. Open & partially-complete — by priority

### P0 — gates a credible production v1
| Item | State | Track | Next step / gap |
|---|---|---|---|
| Multi-tenant SaaS hosting | Designed | C | Stand up a production environment (GO_LIVE #20/#26). Architecture is done; nothing is deployed. |
| Real-customer connector pilot (**A1**) | Pending | A | Run the shipped edge agent against a live customer DB (GO_LIVE #25). Proves the Phase-3 thesis end-to-end. |
| Auto-extracted lineage — SQL/query-log half | Partial | Lineage | dbt-manifest path ships; build the SQL/query-log parser (sqlglot) for non-dbt warehouses. = backlog **#1**. |

### P1 — important, not blocking
| Item | State | Track | Next step / gap |
|---|---|---|---|
| On-prem deployment validation | Designed | B2 | Chart lints + templates in CI; never `helm install`-ed against a live cluster. |
| Managed / HA Postgres | Pending | B1 | Replace the bundled single-replica StatefulSet (GO_LIVE #26). |
| Column-level lineage | Not Started | Lineage | Today's edges are table-to-table. Needs a SQL parser. = backlog **#2**. |
| Impact analysis from lineage | Partial | Lineage | WhereUsed shows direct relations; walk the graph N hops. = backlog **#24**. |
| Audit export / compliance reports | Partial | — | Audit log is queryable; build SOX/GDPR/HIPAA report templates. |
| DQ profiling / column-level auto-stats | Partial | — | Row count + freshness only; add null%/distinct/min-max/histograms. |
| Business Capability level above Data Domain | Not Started | D1 | Add the top rung so the data hierarchy matches Capability→Domain→Sub-Domain→Entity. |
| Data-model versioning for domains & assets | Partial | D3 | Process nodes have proposed/approved snapshots; extend to domains + assets. |
| Source-scope → domain auto-mapping | Not Started | D4 | Auto-map a connector's scan scope to the domains it feeds. |
| Unified `roleAssignments` data model | Backlog | Roles | Role ownership is scattered across FKs; a unified store enables cross-role queries + expiry. = backlog **#26** (migration-heavy). |
| WhereUsed on Activity & Person detail | Backlog | — | Exists on System/Data-Asset detail; extend for full cross-layer coverage. = **#15**. |
| Saved views: column-visibility integration | Backlog | — | Column visibility persists separately; consolidate into saved views. = **#18**. |
| PDF export from the Export menu | Backlog | — | Deferred from the original export work (jspdf or server-side Puppeteer). = **#11**. |
| Comments: email notifications for @mentions | Backlog | — | In-app only today; needs SMTP + unsubscribe. = **#13**. |

### P2 — differentiator / nice-to-have
| Item | State | Track | Note |
|---|---|---|---|
| Governance approval workflows (BPMN-style) | Partial | — | Multi-stage approver routing (Camunda/Temporal or build). |
| Anomaly detection on DQ (ML) | Not Started | — | ML-based DQ. |
| Replace `setInterval` scheduler with a job queue | Backlog | B | BullMQ / EventBridge so restarts don't reset cadence. = **#4**. |
| Additional auto-lineage connectors (warehouse query logs) | Backlog | Lineage | Snowflake/Databricks/BigQuery query-history fetchers after #1. = **#23**. |
| BI-tool integration | Not Started | — | Deferred. |
| Data-product marketplace / catalog | Not Started | — | New data-product entity + access workflow. |
| OpenAPI spec coverage | Partial | Infra | Not all routers are covered. |
| Comments: deeper threading | Backlog | — | v1 is one level deep. = **#12**. |
| Terminology (Plain/DAMA) reactivity & granularity | Backlog | — | 4 helper-based pages don't react to the toggle (**#14**); per-term overrides (**#20**). |
| Activity feed: cursor pagination / per-person feed | Backlog | — | = **#16**, **#17**. |
| Saved views: roll out to tree-based pages | Backlog | — | = **#19**. |
| A11y polish | Backlog | — | Heading hierarchy (**#21**), skip-to-content in modals (**#22**), manual high-contrast toggle (**#25**). |
| Roles: scope-aware "held by" + server-side enrichment | Backlog | Roles | = **#27**, **#28**. |
| dbt Cloud: one-click pause toggle | Backlog | Lineage | = **#5**. |

---

## 2. Deferred / out-of-scope (explicitly not being pursued now)

- **P3 parity items** (capability matrix, "not pursuing"): active row/column
  **policy enforcement**, **cost/spend tracking**, **data contracts**,
  behavioral/usage-based discovery ranking.
- **Track C — commercial SaaS** (build only if go-to-market is self-serve, not
  white-glove): **C1 billing** (no subsystem exists), **C2 self-serve org
  onboarding** (no unauthenticated signup/tenant provisioning), **C3 legal
  content** (ToS/privacy/DPA are placeholders).
- **D2 — shared / co-stewardship register.** *Customer-gated,
  isolation-sensitive — do not build on spec.* Cross-org shared governance
  boundaries cut across the per-`org_id` isolation the security work hardened;
  treat as a security-sensitive design, build only for a customer that needs it.
- **Discovery gaps** (`non-relational-discovery.md`): **API / spreadsheet**
  sources stay `simulated`; **Parquet/Avro measured DQ** (schema is discovered,
  values aren't read yet); **unstructured content** (text/PDF/image) — not on the
  roadmap.
- **Live-account validation** of the cloud/SDK discovery adapters (S3/Azure/GCS/
  SFTP, Snowflake/BigQuery/Databricks) — code ships, but proving it needs real
  endpoints.
- **AWS hardening, out of scope** (`AWS_PRODUCTION_GUIDE.md`): fully private ALB
  (VPC origin/PrivateLink), private CloudFront (signed URLs/cookies), external
  monitoring integration (Datadog/Grafana beyond CloudWatch).
- **GA-audit deferrals** (kept, not removed; see `GA_TIGHTENING_AUDIT.md`):
  `Person.role` vs `orgRoles`, `Mapping.createdBy` / `GovernanceTask.createdBy`,
  `RaciOverride.reason`, owner-FK naming (`ProcessNode.ownerId` etc.).

---

## 3. Production-hardening tail (Track B — gated on a running deploy)

Verification/ops items, not code: **B3** load-test baseline (harness exists;
capture numbers + tighten budgets, GO_LIVE #21) · **B4** external penetration
test (SAST + dep-audit done; #22) · **B5** DR rehearsal (runbook written; owe one
restore against staging to record RTO/RPO, #23).

---

## 4. Recommendations & suggestions

1. **Highest-leverage build: SQL query-history lineage (#1 / Track Lineage).**
   It's the only High-priority open backlog item and the main thing separating
   Procela's lineage from Alation/Atlan. One connector (Snowflake
   `ACCOUNT_USAGE.QUERY_HISTORY` + sqlglot) unlocks the pattern; column-level
   (#2) and other warehouses (#23) follow the same shape.
2. **The go-live path is short.** Only the two P0s — **production/multi-tenant
   hosting** and the **A1 pilot** — stand between "feature-complete" and a real
   customer. Everything else can trail. Sequencing A vs B vs C is a
   go-to-market call, not a technical one.
3. **Keep GTM-gated bets un-built until pulled.** Track C (billing/self-serve)
   and **D2** (co-stewardship) should not be built on spec — C is only needed
   for self-serve SaaS, and D2 is a security-sensitive isolation design.
4. **Integrate these registers so they stop drifting.** They currently only
   relate via the `docs/README.md` index — no cross-references, no shared IDs.
   Cheapest fix: add a `RoadmapTrack` column to `future-work.csv` and have this
   file be the single curated overview the granular sources back. Re-reconcile
   periodically (this file is that reconciliation as of the date above).
5. **Small UX follow-ups from the recent consistency work** (optional): a
   Linear-style **"+ Add filter" popover** as a future filter model if the chip
   rows ever grow; a **dismissible** org-scope banner on list pages; an
   even-tighter header variant. All low-value polish — noted for completeness.

---

## Source map

| This file's section | Backed by |
|---|---|
| Open & partial (P0–P2) | `capability-matrix.csv` (non-Built rows) + `ROADMAP.md` tracks + `future-work.csv` |
| Deferred / out-of-scope | `capability-matrix.csv` (P3), `ROADMAP.md` (C, D2), `non-relational-discovery.md`, `AWS_PRODUCTION_GUIDE.md`, `GA_TIGHTENING_AUDIT.md` |
| Production tail (B) | `ROADMAP.md` Track B + `GO_LIVE_CHECKLIST.md` |
| Backlog IDs (#N) | `future-work.csv` |

*This is a curated overview. The granular files remain the working artifacts
(`future-work.csv` for sortable tickets, `capability-matrix.csv` for RFP
coverage). When an item moves, update its home file and re-reconcile here.*
