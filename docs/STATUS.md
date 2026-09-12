# Procela — Status, Roadmap & Open Work

*The single source of truth for **where Procela stands and what's left**. It
consolidates what used to live across separate files — the post-cutover roadmap,
the itemized backlog, the competitor coverage matrix, the discovery survey, the
go-live checklist, the AWS hardening guide, and the GA tightening audit. The
in-app **/roadmap** page renders this file live. **Last reconciled: 2026-09-12.***

> **How to read this.** Priorities: **P0** = required for a credible production
> v1 · **P1** = important, not blocking · **P2** = differentiator/nice-to-have ·
> **P3** = long-term parity, not being pursued now. "State" is Built / Partial /
> Designed / Not Started / Backlog. Backlog IDs (`#N`) are stable ticket numbers.

## Contents
1. [Snapshot](#snapshot)
2. [Roadmap tracks (A–E)](#roadmap-tracks)
3. [Open & partially-complete — by priority](#open--partial-by-priority)
4. [Deferred / out-of-scope](#deferred--out-of-scope)
5. [Recommendations](#recommendations)
6. [Go-live checklist](#go-live-checklist)
7. [Production hardening reference (AWS)](#production-hardening)
8. [Feature coverage vs incumbents](#feature-coverage)
9. [Discovery coverage](#discovery-coverage)
10. [GA tightening audit](#ga-tightening-audit)

---

## Snapshot

- **Functionally near-complete.** Of ~80 tracked capabilities, **64 are Built**;
  16 are not (6 Partial · 2 Designed · 8 Not Started). Phases 1 (Define) and 2
  (Connect) ship in full; Phase 3 (Discover) is built for direct-connect and
  needs a real-customer pilot. The Postgres cutover and the GA tightening audit
  (§A–G) are complete; the AWS deploy path is wired and verified.
- **Only two open items genuinely gate a production v1 (both P0):**
  1. **Stand up production / multi-tenant SaaS hosting** (Designed).
  2. **SQL / query-log lineage extraction** (Partial — the dbt half ships).
- Everything else is a deliberate P2/P3 defer, a go-to-market-gated bet, or
  polish-level backlog. Sequencing Tracks A / B / C is a go-to-market call, not a
  technical one, and is intentionally left open.

---

## Roadmap tracks

The frontiers a feature-complete platform hasn't crossed because it has never run
in production against a real customer. This captures scope, not order.

### Track A — Phase 3: close the discovery loop
*The product frontier. The **discovery loop** is closed for direct-connect
sources: a configured connection runs real catalog discovery, measures data
quality live, and reconciles results into the governed catalog. The on-prem agent
covers firewalled sources.* **Only the pilot (A1) is open.**
- **A1 — Real-customer connector pilot.** Run the shipped agent against a live
  customer database (go-live checklist #25). The first real-world scan; proves the
  whole Phase-3 thesis. *(A2 reconciliation + A3 source-fed health are built.)*

### Track B — production-scale hardening
*The go-live tail that's bigger than config. Gated on a running deploy.*
- **B1 — Managed / HA Postgres** (replace the bundled single-replica StatefulSet; #26).
- **B2 — On-prem smoke deploy** (chart lints + templates in CI; never `helm install`-ed live; #26).
- **B3 — Load-test baseline** (harness exists; capture numbers + tighten budgets; #21).
- **B4 — External pen test** (SAST + dep-audit + in-house review done; third-party engagement outstanding; #22).
- **B5 — DR rehearsal** (runbook written; owe one restore against staging for real RTO/RPO; #23).

### Track C — commercial SaaS readiness
*Genuinely absent subsystems — needed only if go-to-market is self-serve SaaS.*
- **C1 — Billing.** No billing subsystem exists (#20). AI calls are already
  rate-limited per-org, a natural metering hook.
- **C2 — Self-serve org onboarding.** No unauthenticated signup / tenant
  provisioning; depends on the per-tenant IdP model.
- **C3 — Legal content.** ToS / privacy / DPA are placeholder (#18).

### Track D — canonical data-model gaps
*From the Canonical EDM Review; most already built. Still open:*
- **D1 — Business Capability level above Data Domain** (add the top rung; medium).
- **D2 — Shared / co-stewardship register.** *Customer-gated, isolation-sensitive —
  do not build on spec.* Cross-org shared governance cuts across per-`org_id`
  isolation; a security-sensitive design, not just a feature (high).
- **D3 — Data-model versioning for domains & assets** (process nodes have it; extend; medium, partial).
- **D4 — Source-scope → domain auto-mapping** (map a connector's scan scope to domains; small–medium).

### Track E — non-relational source discovery
*Broaden Discover beyond relational DBs. **E1–E4 all shipped:** object storage
(S3 · Azure Blob · GCS · SFTP), MongoDB, warehouses (Snowflake · BigQuery ·
Databricks · Redshift), and local files (CSV/TSV/JSON/JSONL/NDJSON + Parquet/Avro,
nested → dotted paths) all run real introspection (`simulated: false`). Only
**API** and **spreadsheet** sources remain simulated.* The remaining work is
live-account validation of the cloud/SDK adapters against real endpoints.

---

## Open & partial by priority

### P0 — gates a credible production v1
| Item | State | Track | Next step / gap |
|---|---|---|---|
| Multi-tenant SaaS hosting | Designed | C | Stand up a production environment (#20/#26). Architecture done; nothing deployed. |
| Real-customer connector pilot (A1) | Pending | A | Run the shipped edge agent against a live customer DB (#25). |
| Auto-extracted lineage — SQL/query-log half | Partial | Lineage | dbt path ships; build the SQL/query-log parser (sqlglot) for non-dbt warehouses. = **#1**. |

### P1 — important, not blocking
| Item | State | Track | Next step / gap |
|---|---|---|---|
| On-prem deployment validation | Designed | B2 | Chart lints/templates in CI; never `helm install`-ed live. |
| Managed / HA Postgres | Pending | B1 | Replace the bundled single-replica StatefulSet (#26). |
| Column-level lineage | Not Started | Lineage | Edges are table-to-table; needs a SQL parser. = **#2**. |
| Impact analysis from lineage | Partial | Lineage | WhereUsed shows direct relations; walk the graph N hops. = **#24**. |
| Audit export / compliance reports | Partial | — | Audit log queryable; build SOX/GDPR/HIPAA templates. |
| DQ profiling / column-level auto-stats | Partial | — | Row count + freshness only; add null%/distinct/min-max/histograms. |
| Business Capability level above Data Domain | Not Started | D1 | Add the top rung of the data hierarchy. |
| Data-model versioning for domains & assets | Partial | D3 | Extend the process-node snapshot pattern to domains + assets. |
| Source-scope → domain auto-mapping | Not Started | D4 | Auto-map a connector's scan scope to the domains it feeds. |
| Unified `roleAssignments` data model | Backlog | Roles | Role ownership is scattered across FKs; unify for cross-role queries + expiry. = **#26** (migration-heavy). |
| WhereUsed on Activity & Person detail | Backlog | — | Exists on System/Data-Asset; extend for full cross-layer coverage. = **#15**. |
| Saved views: column-visibility integration | Backlog | — | Column visibility persists separately; consolidate. = **#18**. |
| PDF export from the Export menu | Backlog | — | jspdf or server-side Puppeteer. = **#11**. |
| Comments: email notifications for @mentions | Backlog | — | In-app only; needs SMTP + unsubscribe. = **#13**. |

### P2 — differentiator / nice-to-have
| Item | State | Note |
|---|---|---|
| Governance approval workflows (BPMN-style) | Partial | Task lifecycle state machine ships; no multi-stage approver routing (Camunda/Temporal). |
| Anomaly detection on DQ (ML) | Not Started | Statistical drift/outlier detection. |
| Replace `setInterval` scheduler with a job queue | Backlog | BullMQ / EventBridge so restarts don't reset cadence. = **#4**. |
| Additional auto-lineage connectors (warehouse query logs) | Backlog | Snowflake/Databricks/BigQuery query-history after #1. = **#23**. |
| BI-tool integration | Not Started | Tableau/Power BI/Looker. |
| Data-product marketplace / catalog | Not Started | New data-product entity + access workflow. |
| OpenAPI spec coverage | Partial | Hand-authored spec at `/api/v1/docs`; covers core entities, not all routers. |
| Comments: deeper threading | Backlog | v1 is one level deep. = **#12**. |
| Terminology (Plain/DAMA) reactivity & granularity | Backlog | 4 helper-based pages don't react (**#14**); per-term overrides (**#20**). |
| Activity feed: cursor pagination / per-person feed | Backlog | = **#16**, **#17**. |
| Saved views: roll out to tree-based pages | Backlog | = **#19**. |
| A11y polish | Backlog | Heading hierarchy (**#21**), skip-to-content in modals (**#22**), manual high-contrast toggle (**#25**). |
| Roles: scope-aware "held by" + server-side enrichment | Backlog | = **#27**, **#28**. |
| dbt Cloud: one-click pause toggle | Backlog | = **#5**. |
| System integration graph visualization | Backlog | Directed edges exist as inbound/outbound lists; add force-directed graph. |

---

## Deferred / out-of-scope

Explicitly **not** being pursued now:

- **P3 parity items:** active row/column **policy enforcement** (query-time
  masking/redaction), **cost/spend tracking**, **data contracts**, behavioral /
  usage-based discovery ranking.
- **Track C — commercial SaaS** (build only if go-to-market is self-serve):
  billing (C1), self-serve onboarding (C2), legal content (C3).
- **D2 — shared / co-stewardship register.** *Customer-gated, isolation-sensitive
  — do not build on spec.*
- **Discovery gaps:** **API / spreadsheet** sources stay `simulated`;
  **Parquet/Avro measured DQ** (schema discovered, values not read yet);
  **unstructured content** (text/PDF/image) — not on the roadmap.
- **Live-account validation** of the cloud/SDK discovery adapters (built; needs
  real endpoints).
- **AWS hardening, out of scope** (see [§ Production hardening](#production-hardening)):
  fully private ALB via VPC origin/PrivateLink, private CloudFront with app-level
  auth, shipping app logs to OpenSearch/Datadog, a CI/CD pipeline, per-environment
  account layout.
- **GA-audit deferrals** (kept, not removed): `Person.role` vs `orgRoles`,
  `Mapping.createdBy` / `GovernanceTask.createdBy`, `RaciOverride.reason`,
  owner-FK naming.

---

## Recommendations

1. **Highest-leverage build: SQL query-history lineage (#1 / Track Lineage).**
   The only High-priority open backlog item and the main thing separating
   Procela's lineage from Alation/Atlan. One connector (Snowflake
   `ACCOUNT_USAGE.QUERY_HISTORY` + sqlglot) unlocks the pattern; column-level (#2)
   and other warehouses (#23) follow the same shape.
2. **The go-live path is short.** Only the two P0s — production/multi-tenant
   hosting and the A1 pilot — stand between "feature-complete" and a real
   customer. Sequencing A vs B vs C is a go-to-market call.
3. **Keep go-to-market-gated bets un-built until pulled.** Track C
   (billing/self-serve) and **D2** (co-stewardship) should not be built on spec.
4. **Small UX follow-ups** (optional, low value): a Linear-style "+ Add filter"
   popover if chip rows ever grow; a dismissible org-scope banner on list pages;
   an even-tighter header variant.

---

## Go-live checklist

*What remains between "demo-ready" (runs on the JSON path today) and running a
real customer in production. `[x]` done · `[ ]` open · `[~]` partial. The
**[fast path](#fast-path)** is the minimum for a single pilot. Provisioning
how-to for secrets is in [`DEPLOY_RUNBOOK.md`](./DEPLOY_RUNBOOK.md); restore /
rotate in [`DR_RUNBOOK.md`](./DR_RUNBOOK.md); the ordered operator worksheet is
[`PILOT_GO_LIVE_WORKSHEET.md`](./PILOT_GO_LIVE_WORKSHEET.md).*

**Infrastructure**
- [ ] **1. Postgres up.** Run `deploy/terraform/` or self-host Postgres 16+; set a real `DATABASE_URL`.
- [ ] **2. Apply migrations.** `npx prisma migrate deploy` (once per env; CI does it per-run).
- [x] **3. JSON → Postgres data migration.** Done — `scripts/migrate-json-to-postgres.ts` (`npm run db:migrate-json`, `--dry-run`).
- [x] **4. Cross-file consumers read repositories.** Done (cutover 9b.1–9b.37); arrays retired, boots with zero stale-read warnings.
- [x] **5. Auth cutover.** Done — SCIM, auth routes, lockout, refresh tokens, MFA/WebAuthn all repo-backed. IdP config via env (see #10).

**Environment / secrets (per environment — plumbing wired on AWS + on-prem; these are populate-the-value)**
- [ ] **6. `ANTHROPIC_API_KEY`.**
- [ ] **7. `JWT_PRIVATE_KEY` + `JWT_PUBLIC_KEY`** (RS256; code-complete, falls back to HS256 with a warning). Generate an RSA keypair → Secrets Manager.
- [ ] **8. `REDIS_URL`** (real Redis for rate-limiting/sessions; in-memory fallback is dev-only).
- [ ] **9. `SMTP_*`** (mail for notifications/reset; logs to audit as fallback).
- [ ] **10. Identity provider config.** `AUTH_PROVIDER` (`oidc`|`saml`|`local`) + OIDC/SAML config. Sub-domain white-labeling needs DNS + wildcard cert.
- [ ] **11. `KMS_PROVIDER` / `MFA_ENCRYPTION_KEY`.** Encryption-at-rest is code-complete (TOTP, dbt token, OIDC clientSecret, connection creds). AWS auto-generates + injects `MFA_ENCRYPTION_KEY`; on-prem set `secrets.mfaEncryptionKey` or a KMS provider.

**Runtime / operations**
- [ ] **12. HTTPS termination** at ALB/Nginx (ACM or Let's Encrypt).
- [ ] **13. Backups** (RDS automated + PITR, or `.procela-data` on JSON).
- [ ] **14. Log aggregation** (CloudWatch/Datadog; Pino outputs JSON).
- [ ] **15. Uptime monitoring** — poll `/api/v1/health`, alert on non-200.
- [ ] **16. Rate limits** — `AI_MAX_CALLS_PER_ORG_PER_HOUR`/`_DAY` to match your Anthropic tier.

**Product / content**
- [ ] **17. Real customer data seeded** (CSV import or the on-prem connector — see #25).
- [ ] **18. Legal:** ToS, privacy policy, DPA (hooks exist; text is placeholder).
- [x] **19. Support flow.** Wired — in-app "Report a problem" → `/api/v1/support`, audit-logged, emails support inbox when `SUPPORT_EMAIL`+SMTP set.
- [ ] **20. Billing** — no subsystem exists; integrate Stripe/etc. if SaaS.

**Testing / hardening beyond CI**
- [~] **21. Load test.** Harness built (`loadtest/`, `npm run loadtest`; manual `Load test` workflow). Remaining: capture a Postgres-backed baseline + tighten per-scenario budgets.
- [~] **22. Security review.** Dependency audit done (nodemailer 8, vitest 4, react-router 7.18; residual advisories accepted with rationale). SAST wired (CodeQL, security-extended, every PR + weekly, inline PR annotations). In-house app-sec review done — fixed a systemic tenant-isolation IDOR + six lower-severity issues (PRs #522–#524). **Remaining:** external third-party pen test.
- [x] **23. DR runbook.** Written ([`DR_RUNBOOK.md`](./DR_RUNBOOK.md)). Ops owes one staging restore rehearsal for real RTO/RPO (§7 prereqs).
- [x] **24. Real Postgres integration test in CI.** Done — `live-db.test.ts` business-flow suite (`test-backend-live-db`).

**Roadmap items still ahead of go-live**
- [~] **25. Phase 3 connectors.** On-prem agent shipped (Postgres/MySQL/SQL Server/Oracle/dbt, column-level discovery, retry/backoff, container liveness). Real catalog SQL exercised in CI against live Postgres/MySQL/SQL Server/Oracle. **Remaining:** a run against real *customer* DBs (the pilot = A1).
- [~] **26. On-prem deployment.** Helm chart added (`deploy/helm/procela/`), `helm lint --strict` + template-render in CI across install paths. **Remaining:** a smoke deploy on a real cluster + managed/HA Postgres.
- [x] **27. Rule-8 handlers follow-up.** Done (#137).

### Fast path
Minimum to run one pilot customer: **1, 2, 4, 6, 7, 9, 10, 12, 13, 15, 22, 23.**
Everything else can follow in month-2 iterations. Ordered worksheet:
[`PILOT_GO_LIVE_WORKSHEET.md`](./PILOT_GO_LIVE_WORKSHEET.md).

---

## Production hardening

*AWS reference. The Terraform reference stack is always-on; hardening ships as
opt-in toggles (default off) in `terraform.tfvars`. The authoritative toggle
table is in [`deploy/terraform/README.md`](../deploy/terraform/README.md#production-hardening-toggles);
recovery procedures are in [`DR_RUNBOOK.md`](./DR_RUNBOOK.md).*

| Area | Hardening (toggle) |
|---|---|
| Resilience | RDS Multi-AZ (`rds_multi_az`), deletion protection + final snapshot (`rds_deletion_protection`), longer backups + PITR (`db_backup_retention_days`), Performance Insights (`rds_performance_insights`) |
| Encryption | Customer-managed KMS keys on RDS/S3/Secrets/logs (`enable_kms_cmk`) |
| Network | CloudFront-only ALB (`restrict_alb_to_cloudfront`), VPC endpoints (`enable_vpc_endpoints`), NAT per AZ (`enable_nat_per_az`) |
| Edge | WAF on CloudFront (`enable_waf` + `waf_rate_limit`); Shield Advanced (separate subscription) |
| Secrets | Automated DB-password rotation (`enable_db_secret_rotation` + `db_rotation_lambda_arn`) |
| Observability | Access logs (`enable_access_logs`), CloudWatch alarms + SNS (`enable_monitoring_alarms`, `alarm_email`) |
| Threat detection | CloudTrail / GuardDuty / AWS Config / Security Hub (`enable_cloudtrail`/`_guardduty`/`_config`/`_security_hub`) |

**"Am I hardened?" gate:** Terraform state in S3 + DynamoDB lock · Multi-AZ +
deletion protection + backups ≥14d + PITR verified · KMS CMKs · WAF + ALB not
public · VPC endpoints + NAT per AZ · CloudTrail/GuardDuty/Config/Security Hub ·
access logs + alarms → pager · secrets rotation · `desired_count` ≥ 2 + Redis ·
separate prod account · a restore drill actually performed.

**Still out of scope** (process/app work, not a toggle): fully private ALB (VPC
origin/PrivateLink), private CloudFront with app-level auth, shipping app logs to
OpenSearch/Datadog, a CI/CD pipeline, per-environment/account stack layout.

---

## Feature coverage

*Procela vs the four primary benchmarks (Collibra · Alation · Atlan · Ataccama) —
for sales / RFP responses. "Status" is Procela's; the four columns are the
incumbents' comparable coverage.*

| Category · Feature | Procela | Pri | Collibra | Alation | Atlan | Ataccama |
|---|---|---|---|---|---|---|
| Catalog · Business value-stream / process model | Built | P0 | Partial | None | None | Partial |
| Catalog · Process step ownership | Built | P0 | Yes | No | No | No |
| Catalog · Process status lifecycle | Built | P1 | Yes | No | No | Partial |
| Catalog · Industry templates (AI) | Built | P0 | No | No | No | No |
| Catalog · Process→data-asset mapping | Built | P0 | Partial | No | No | No |
| Catalog · Process catalog versioning | Built | P2 | Yes | Partial | No | Partial |
| Data assets · Asset registry (business terms) | Built | P0 | Yes | Yes | Yes | Yes |
| Data assets · Asset bindings (M:N + column sets) | Built | P0 | Yes | Yes | Yes | Yes |
| Data assets · Origin tracking | Built | P1 | Limited | Limited | Limited | Limited |
| Data assets · Suggested-source flow | Built | P1 | No | No | Limited | No |
| Data assets · Tier-promotion suggestions | Built | P1 | No | No | No | Limited |
| Data assets · DQ / health score | Built | P1 | Add-on | Add-on | Partner | Best-in-class |
| Data assets · Classification / sensitivity | Built | P0 | Yes | Yes | Yes | Yes |
| Data assets · Retention policy | Built | P1 | Yes | Partial | Partial | Yes |
| Data assets · Column-level catalog | Built | P1 | Yes | Yes | Yes | Yes |
| Data assets · Column auto-discovery | Built | P1 | Yes | Yes | Yes | Yes |
| Data assets · Asset 360 view | Built | P1 | Yes | Yes | Yes | Yes |
| Data assets · DQ coverage filter | Built | P2 | Yes | Yes | Yes | Yes |
| Glossary · Business glossary terms | Built | P0 | Yes | Yes | Yes | Yes |
| Glossary · Import / AI generation | Built | P1 | Yes | Limited | Limited | Yes |
| Glossary · Term-to-asset linking | Built | P1 | Yes | Yes | Yes | Yes |
| Systems · Registry | Built | P0 | Yes | Limited | Limited | Yes |
| Systems · Ownership model (owner/deputy/custodians) | Built | P0 | Yes | No | No | Partial |
| Systems · Integration-mechanism taxonomy | Built | P1 | No | No | No | Limited |
| Systems · System-to-system integration graph | Built | P2 | Partial | Yes | Partial | Yes |
| Connections · Connection profiles | Built | P0 | Yes | Yes | Yes | Yes |
| Connections · M:N connection↔system | Built | P1 | Yes | Partial | Yes | Yes |
| Connections · Real database connectors | Built | P0 | 200+ | 200+ | 200+ | Many |
| Connections · Connection testing | Built | P1 | Yes | Yes | Yes | Yes |
| Connections · Discovery (browse contents) | Built | P0 | Yes | Yes | Yes | Yes |
| Lineage · Manual lineage links | Built | P1 | Yes | Yes | Yes | Yes |
| Lineage · Auto-extracted lineage (SQL/dbt) | **Partial** | P0 | Yes | Best-in-class | Best-in-class (dbt) | Yes |
| Lineage · Column-level lineage | **Not Started** | P1 | Yes | Yes | Yes | Yes |
| Lineage · Impact analysis from lineage | **Partial** | P1 | Yes | Yes | Yes | Yes |
| Data quality · Rules engine | Built | P1 | Add-on | Add-on | Partner | Best-in-class |
| Data quality · Quality dimensions | Built | P1 | Yes | Yes | Yes | Yes |
| Data quality · Profiling (auto-stats) | **Partial** | P1 | Yes | Yes | Yes | Yes |
| Data quality · Scorecards / dashboards | Built | P1 | Yes | Yes | Yes | Yes |
| Governance · Issues | Built | P1 | Strong | Functional | Functional | Yes |
| Governance · Tasks | Built | P1 | Yes | Yes | Yes | Yes |
| Governance · Policies + controls | Built | P1 | Yes | Limited | Limited | Yes |
| Governance · RACI / decision rights | Built | P1 | Add-on | No | No | No |
| Governance · SOPs / runbooks | Built | P1 | Add-on | No | No | Limited |
| Governance · Operations manuals | Built | P2 | Yes | No | No | No |
| Governance · Calendar / cadence | Built | P1 | Yes | No | Limited | Yes |
| Governance · Program / structure | Built | P1 | Yes | No | Limited | Yes |
| Governance · Maturity scoring | Built | P1 | Yes | Limited | Limited | Yes |
| Governance · Council scorecard (division rollup) | Built | P1 | Partial | No | No | Limited |
| Governance · Policy-exceptions register | Built | P1 | Yes | No | No | Limited |
| Governance · Approval workflows (BPMN) | **Partial** | P2 | Best-in-class | Limited | Limited | Yes |
| Domains · Domain entity | Built | P0 | Yes | Yes | Yes | Yes |
| Domains · Criticality tier | Built | P1 | Yes | No | Limited | Yes |
| Domains · Coverage gaps | Built | P1 | Yes | Yes | Yes | Yes |
| Discovery · Asset search | Built | P0 | Yes | Best-in-class | Yes | Yes |
| Discovery · Behavioral / usage ranking | **Not Started** | P2 | Partial | Yes | Partial | Partial |
| Discovery · Gap detection | Built | P1 | Yes | Limited | Limited | Yes |
| AI · Conversational assistant | Built | P0 | Add-on | Add-on | Built-in | Limited |
| AI · Suggested mappings | Built | P1 | Limited | Limited | Limited | Limited |
| AI · Industry templates | Built | P0 | No | No | No | No |
| AI · Suggested data-source matching | Built | P1 | Limited | Limited | Limited | No |
| AI · Anomaly detection on DQ | **Not Started** | P2 | Partner | Partner | Partner | Best-in-class |
| Auth · SSO (SAML/OIDC) | Built | P0 | Yes | Yes | Yes | Yes |
| Auth · RBAC | Built | P0 | Yes | Yes | Yes | Yes |
| Auth · Org hierarchy + scoped access | Built | P1 | Yes | Limited | Limited | Yes |
| Auth · Active policy enforcement (row/col) | **Not Started** | P3 | Yes | Yes | Yes | Yes |
| Audit · Audit log | Built | P0 | Yes | Yes | Yes | Yes |
| Audit · Export / compliance reports | **Partial** | P1 | Yes | Yes | Limited | Yes |
| Infra · Multi-tenant SaaS | **Designed** | P0 | Yes | Yes | Native | Yes |
| Infra · On-prem deployment | **Designed** | P1 | Yes | Yes | Partial | Yes |
| Infra · Real database backing | Built | P0 | Postgres | Postgres | Postgres | Postgres |
| Infra · Integration with BI tools | **Not Started** | P2 | Yes | Yes | Yes | Yes |
| Infra · API completeness | Built | P0 | Yes | Yes | Yes | Yes |
| Infra · OpenAPI spec | **Partial** | P1 | Yes | Yes | Yes | Yes |
| UX · Column picker | Built | P2 | Limited | Limited | Yes | Limited |
| UX · Org-context person pickers | Built | P2 | Yes | Limited | Yes | Limited |
| UX · Focus-refresh on tab return | Built | P2 | Yes | Yes | Yes | Yes |
| Misc · Data-product marketplace | **Not Started** | P2 | Partial | Yes | Yes | Limited |
| Misc · Data contracts | **Not Started** | P3 | Limited | Limited | Yes | Limited |
| Misc · Cost / spend tracking | **Not Started** | P3 | Limited | Limited | Yes | Limited |

---

## Discovery coverage

*What the Discover loop can introspect. Real paths set `simulated: false` and flow
through reconciliation; mock paths set `simulated: true` and are clearly labelled.*

| Source | Real? | Notes |
|---|---|---|
| PostgreSQL / MySQL / SQL Server / Oracle | ✅ real | Catalog SQL (`information_schema` / Oracle `all_*`) |
| Redshift | ✅ real | Postgres-wire via `pg`; `svv_table_info` row count |
| MongoDB | ✅ real | Collections + `$sample` field/type inference; polymorphic → `int\|string` |
| Snowflake / BigQuery / Databricks | ✅ real | `INFORMATION_SCHEMA` via each engine's SDK; own module each |
| Object storage — S3 / Azure Blob / GCS / SFTP | ✅ real | List bucket/prefix → download → infer each object; one provider-agnostic `ObjectStore` |
| Local file — CSV/TSV/JSON/JSONL/NDJSON | ✅ real | Parse header / union keys; nested JSON → dotted paths |
| Local file — Parquet / Avro | ✅ real | Footer / OCF header schema; leaf columns as dotted paths |
| dbt manifest | ✅ real | `manifest.json` models/sources/seeds — no live DB |
| API / Spreadsheet (SharePoint, Google Sheets) | ❌ simulated | Reachability probe + mock assets; out of scope |

**DQ**: measured for direct-connect databases (SQL pushdown, 5 rule types) and
text file formats; **Parquet/Avro DQ stays simulated** (schema discovered, values
not read yet); warehouse/object-store/API/spreadsheet DQ is simulated.
**Not on the roadmap:** unstructured content (free-text/PDF/document/image).

---

## GA tightening audit

The field-level census for the first commercial release (63 models / ~653
columns) is **closed — sections §A–§G are all done**: dead columns removed,
redundant fields consolidated, mocked surfaces either finished or honestly
labelled, and the Postgres persistence + secrets-at-rest work landed. A handful
of fields were **deliberately kept/deferred** rather than removed (listed under
[Deferred / out-of-scope](#deferred--out-of-scope)). The audit's outcomes are now
reflected directly in the codebase; this section is the surviving summary.

---

*Curated single source of truth. When an item moves, update it here.*
