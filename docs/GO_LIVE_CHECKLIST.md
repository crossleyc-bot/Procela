# Procela go-live checklist

Everything below is beyond what's shipped today — the platform runs on
the JSON persistence path and is demo-ready. This document tracks what
remains between "demo-ready" and "running a real customer in
production."

Items are grouped by concern. The **[Fast path](#fast-path)** section
at the bottom lists the minimum subset needed to run a single pilot
customer.

---

## Infrastructure — must-do for any production deploy

- [ ] **1. Postgres up.** Run `deploy/terraform/` against your AWS
  account, or self-host Postgres 16+. Set `DATABASE_URL` in the
  backend's environment (a real value, not the local `.env`).
- [ ] **2. Apply migrations.** `npx prisma migrate deploy` from
  `packages/backend/` — one time per environment. CI does this per-run.
- [x] ~~**3. JSON → Postgres data migration.**~~ **Done** (cutover PR 8).
  `scripts/migrate-json-to-postgres.ts` reads `.procela-data/*.json` and
  inserts through each repo in FK-tier order, idempotently; run via
  `npm run db:migrate-json` (supports `--dry-run`).
- [x] ~~**4. Cross-file consumers still read arrays.**~~ **Done** (cutover
  **PR 9b**, increments 9b.1–9b.37). Every reader — the aggregators
  (control-tower, enterprise-view, exports, analysis, chat), the store-owning
  routes and their foreign reads (systems, process-catalog, data-quality,
  data-lineage/dbt-import), the deferred governance sync helpers
  (`syncDataQualityIssueForRule`, `sweepOverdueTasks`,
  `openAgentOwnershipIssue`), and the audit hash-chain — now goes through its
  repository. The arrays are retired: `loadStore` returns `[]` in Postgres
  mode (the last four boot-time reads — audit cursor seed, process-catalog
  counter reseed, connections legacy link-migration, governance-policies
  documentType backfill — are `hasDatabase()`-guarded, so the app boots with
  **zero** stale-read warnings). Verified by booting the backend against a
  live Postgres (clean boot, 0 warnings) and the `live-db` suite (21/21).
- [x] ~~**5. Auth cutover.**~~ **Done** (cutover PRs 3a–3e). `services/scim`,
  `routes/auth*`, account-lockout, refresh tokens, MFA/WebAuthn, and the
  auth-providers config are all repo-backed and async. Cognito / Azure AD
  OIDC/SAML provider config is still wired via env vars (see #10).

## Environment / secrets — per environment

> Provisioning guide for the items below: [`DEPLOY_RUNBOOK.md`](./DEPLOY_RUNBOOK.md)
> — how to generate each secret and where it lives (AWS Secrets Manager /
> Helm). Rotation of a live secret is in [`DR_RUNBOOK.md`](./DR_RUNBOOK.md) §3.
>
> **The plumbing is wired on both targets** (AWS: PR #218; on-prem: the Helm
> chart). `deploy/terraform/` provisions a Secrets Manager entry for every
> secret below and injects it into the ECS task — `MFA_ENCRYPTION_KEY` and
> `SCIM_BEARER_TOKEN` are Terraform-generated (secure by default; the MFA
> key is injected unconditionally), while `REDIS_URL` / `SMTP_PASS` /
> `OIDC_CLIENT_SECRET` / `SAML_IDP_CERT` are populated out-of-band and
> injected via `enable_*` toggles. So the items below are now
> **populate-the-value**, not wire-the-plumbing. (PR #218 also fixed the ECS
> container health-check path, `/health` → `/api/v1/health`, so tasks
> actually reach a healthy state.)

- [ ] **6. `ANTHROPIC_API_KEY`** — the working key set locally.
- [ ] **7. `JWT_PRIVATE_KEY` + `JWT_PUBLIC_KEY`** — RS256 signing.
  **Code-complete** (`services/jwt-signer.ts`): the backend signs with
  RS256 when the keypair is present and only falls back to HS256 (with a
  boot warning) when it isn't. Config-only: generate an RSA keypair and
  store the private key in Secrets Manager.
- [ ] **8. `REDIS_URL`** — real Redis for rate-limiting & sessions. The
  backend falls back to in-memory if unset (fine for dev, not for HA).
- [ ] **9. `SMTP_*`** — mail delivery for notifications / password
  reset. Currently logs to the audit trail as a fallback.
- [ ] **10. Identity provider config.** `AUTH_PROVIDER` (`oidc` | `saml` |
  `local` — Cognito federates via OIDC; `dev`/unrecognized values make prod
  refuse to boot) plus the OIDC issuer / client id or `SAML_*` config. On AWS
  these are the `auth_provider` / `oidc_*` / `saml_*` tfvars. Sub-domain-based
  tenant white-labeling needs proper DNS + a wildcard cert.
- [ ] **11. `KMS_PROVIDER` / `MFA_ENCRYPTION_KEY`** — encryption at
  rest is **code-complete** (`services/crypto.service.ts` +
  `services/kms-providers.ts`, with tests). It now covers TOTP secrets,
  the **dbt Cloud API token**, the **OIDC `clientSecret`**, and
  **direct-connect connection credentials** (`password` / `apiKey` /
  `token`, via `services/connection-secrets.ts`) — each enveloped on
  write and decrypted only at the point of use. It encrypts
  when a key / KMS provider is configured and falls back to plaintext
  **only in dev** (with a boot warning) when neither is set. **On AWS,
  Terraform now generates + injects `MFA_ENCRYPTION_KEY` automatically
  (PR #218)** — no action needed there. On-prem: set
  `secrets.mfaEncryptionKey` in the Helm values, or point at a
  `KMS_PROVIDER`.

## Runtime / operations

- [ ] **12. HTTPS termination** at ALB or Nginx. Cert via ACM (AWS) or
  Let's Encrypt.
- [ ] **13. Backups.** `.procela-data` backup on JSON, or RDS automated
  backups + point-in-time recovery on Postgres.
- [ ] **14. Log aggregation** (CloudWatch / Datadog). Pino outputs
  JSON — pipe it to your log platform.
- [ ] **15. Uptime monitoring** — hit `/api/v1/health` on a schedule,
  alert on non-200.
- [ ] **16. Rate limits.** `AI_MAX_CALLS_PER_ORG_PER_HOUR` / `_DAY` —
  pick values that match your Anthropic tier.

## Product / content

- [ ] **17. Real customer data seeded.** Either import via CSV (the
  People, Systems, and Data Assets pages have Import buttons) or turn
  on the real on-prem connector (shipped — see item 25): a Node 20 edge
  agent with Postgres / MySQL / SQL Server / Oracle adapters that pairs,
  discovers, and syncs rows into the catalog.
- [ ] **18. Legal:** ToS, privacy policy, DPA. Content hooks exist
  (`docs/`) but the actual text is placeholder.
- [x] ~~**19. Support flow:**~~ **Wired** — an in-app "Report a problem"
  button in the app shell opens a form (category + message; auto-captures
  the current route, app version, and browser). It POSTs to
  `/api/v1/support`, which records every submission to the tamper-evident
  audit trail (`SUPPORT_REPORT`) and emails the support inbox when
  configured — audit-only fallback otherwise, the same graceful degrade as
  password reset. Config-only remaining: set `SUPPORT_EMAIL` (+ SMTP) to
  turn on email delivery; without it, reports are queryable in the audit
  log.
- [ ] **20. Billing** — no billing subsystem exists. If SaaS, integrate
  Stripe / whatever fits.

## Testing / hardening beyond CI

- [~] **21. Load test.** **Harness built** —
  [`loadtest/`](../loadtest/) (`npm run loadtest`): an autocannon-driven
  backstop that authenticates once, then drives the most-clicked list
  reads and the heavy aggregations (dashboard / control-tower /
  gap-detection / enterprise-view) against a running backend, gating each
  on p99 latency, throughput, and zero non-2xx (non-zero exit on breach).
  Runnable locally or via the manual `Load test` workflow
  (`.github/workflows/loadtest.yml`, `workflow_dispatch`), which uploads a
  results JSON artifact. AI / chat endpoints are excluded by design (paid
  per call; the latency is the model's). **Remaining:** capture a baseline
  against a representative (Postgres-backed) deploy and tighten the
  per-scenario budgets from the generous JSON-path defaults.
- [ ] **22. Security review.** SAST / dependency audit / pen test.
  Dependency audit **done**: the non-breaking pass cleared the easy
  advisories, and the major-version work is now landed too — **nodemailer
  8 → 9** (fixes the `raw`-option file-read/SSRF), **vitest 2 → 4** (clears
  the whole vitest/vite/vite-node/@vitest/mocker chain incl. the critical
  UI-server RCE and the vite path-traversal), and **react-router 6 → 7.18**
  (fixes the open-redirect / XSS and SSR-hydration injection that applied
  to our client-side routing). Every upgrade verified: tsc clean, backend
  896/896, frontend 184/184, production build OK. The residual advisories
  are **accepted with rationale** — none reachable in Procela's usage, and
  each has no sane forward fix today:
  - **`react-router` (RSC-mode CSRF, GHSA-qwww-vcr4-c8h2)** — affects
    react-router's experimental React Server Components framework mode;
    Procela is a plain client-side SPA (no data router, no server
    actions), so the path isn't used. Fix is a future 8.3.0; downgrading
    re-introduces the real open-redirect bug.
  - **`xlsx` (SheetJS)** — prototype-pollution + ReDoS are in the *parse*
    path; the only use is the frontend export, which exclusively **writes**
    (`aoa_to_sheet`/`book_new`). No npm fix (SheetJS left the registry).
  - **`autocannon` → `hyperid` → `uuid`** — dev-only load-test tooling;
    npm's only "fix" is an autocannon 2.0.1 downgrade that would break the
    harness. Not shipped to any runtime.
  - **`esbuild`** (low) — build-time dev-server, **Windows-only**; our
    dev/CI is Linux, and no in-range fix exists without disturbing vite.
  **SAST is now wired** — a CodeQL workflow
  (`.github/workflows/codeql.yml`) runs GitHub's `security-extended`
  suite over all three packages on push + weekly + **on every PR**,
  surfacing findings as code-scanning alerts and, on PRs, as **inline
  annotations on the changed lines** (the repo is public, so code
  scanning is free — no GitHub Advanced Security needed).

  An **in-house application security review** has also been completed: a
  full pass over the backend's multi-tenant isolation, RBAC, injection/
  SSRF, secret handling and AI-endpoint abuse. It found and fixed a
  systemic tenant-isolation gap — cross-tenant read/write/**delete**
  (IDOR) reachable by omitting `orgId` — by enforcing the caller's
  visible-org set server-side across every catalog and read/aggregation
  route, plus six lower-severity fixes (AI-budget enforcement on the
  off-mount AI endpoints, an SSRF host denylist for direct-connect,
  MySQL literal-escaping, a mis-scoped audit `orgId`, and connection-
  credential encryption at rest). Landed across PRs #522–#524 with
  regression tests. An **external, third-party pen test** is still
  outstanding — that engagement is the remaining part of this item.
- [x] ~~**23. DR runbook.**~~ **Written** — [`docs/DR_RUNBOOK.md`](./DR_RUNBOOK.md)
  covers restore-from-backup (PITR / snapshot / JSON fallback), migration
  roll-back, and secret / API-key rotation, grounded in `deploy/terraform/`
  and the Prisma migration flow. Ops still owes one **rehearsal against a
  staging restore** to record real RTO/RPO and confirm the prod-hardening
  prerequisites in the runbook's §7 (PITR retention, deletion protection,
  final snapshot, `MFA_ENCRYPTION_KEY` in Secrets Manager).
- [x] ~~**24. Real Postgres integration test in CI.**~~ **Done** (cutover
  PR 10). `live-db.test.ts` now carries a `live-db business flows` suite that
  drives the converted services (report-engine join, org-scope cascade,
  settings round-trip) against real Postgres, on top of the per-repository
  round-trips. Runs in CI's `test-backend-live-db` job.

## Roadmap items still ahead of go-live

- [~] **25. Phase 3 connectors** — the on-prem agent
  ([`packages/connector/`](../packages/connector/)) is **built and
  shipped**: a Node 20 agent with Postgres / MySQL / SQL Server / Oracle adapters,
  a pairing → token → heartbeat → scan loop, a Docker image, and a GHCR
  release workflow (`.github/workflows/release-connector.yml`). The
  backend side (`pair/start` · `pair/claim` · `heartbeat` · `report`)
  upserts discovered tables as Bronze `DataAsset`s, audit-only. This
  session added the agent's **first test suite** (discovery mapping,
  config normalisation, the backend HTTP contract) + a CI `Connector
  tests` job, and **column-level discovery** — the three adapters now
  also read `information_schema.columns` and `/report` upserts
  `DataAssetColumn`s (name + type, audit-only; no values cross the wire),
  a **dbt-manifest source type** (reads a local `manifest.json`, ships
  models / sources / seeds / snapshots + columns via `/report`, same
  asset identity as the in-app dbt import), and an **Oracle source type**
  (oracledb thin mode — no Instant Client — reading `all_tables` /
  `all_views` / `all_tab_columns`). Sources supported: Postgres · SQL
  Server · MySQL · Oracle · dbt manifest, all with column-level
  discovery, and **report retry/backoff** (a transient network failure
  now retries with capped exponential backoff instead of dropping the
  scan), and a **container liveness signal** — the loop touches a
  liveness file each iteration and a `--healthcheck` invocation of the
  same binary exits non-zero once it goes stale, wired as a Docker
  `HEALTHCHECK` (and documented as a k8s `exec` liveness probe) so a
  wedged agent is restarted. The Postgres and MySQL adapters' **real
  catalog + information_schema SQL is now exercised in CI** against
  ephemeral Postgres + MySQL service containers (`Connector integration
  (live DBs)` job → `adapters.int.test.ts`), proving column types,
  nullability, ordinals, view detection and schema scoping against live
  engines — not just the pure helpers. The **SQL Server and Oracle
  adapters now have the same live-DB coverage**: two dedicated CI jobs
  (`Connector integration (SQL Server)` against
  `mcr.microsoft.com/mssql/server`, and `Connector integration (Oracle)`
  against `gvenzl/oracle-free`) run the same `adapters.int.test.ts` blocks
  — column types, nullability, ordinals, view detection and schema/owner
  scoping — against live engines. (That live SQL Server run also surfaced
  and fixed a real bug: the documented `mssql://…` URL connection form was
  never parsed by node-mssql; `buildMssqlConfig` now converts it.)
  **Remaining:** a run against real *customer* databases (the pilot).
- [~] **26. On-prem deployment** (per the CLAUDE.md guarantee). **Helm
  chart added** — [`deploy/helm/procela/`](../deploy/helm/procela/):
  backend, Nginx-served frontend, optionally-bundled PostgreSQL + Redis,
  a `prisma migrate deploy` pre-upgrade hook, Ingress, and split
  ConfigMap/Secret. Mirrors the compose topology. The backend image now
  bundles the prisma CLI (`prisma` moved to a runtime dependency), so the
  migrate Job works with the default image. **`helm lint` is now wired**
  — a `Helm lint` CI job (`azure/setup-helm`) lints `--strict` and
  `helm template`-renders the chart on every push/PR, across both install
  paths: the default (bundled Postgres + Redis) and a "bring-your-own-infra"
  overlay (`ci/external-values.yaml`: external Postgres + Redis + TLS
  ingress), plus the existing-Secret variant — so every conditional
  template branch is rendered at least once. **Remaining:** a smoke deploy
  on a real cluster (renders clean, but nothing's been `helm install`ed
  against a live API server), and managed/HA PostgreSQL (vs the bundled
  single-replica StatefulSet) as a follow-up.
- [x] ~~**27. The ~7 rule-8 handlers left as follow-up.**~~ Converted
  in PR [#137](https://github.com/datalign-technology/procela/issues/137).
  **Done.**

---

## Fast path

What "MVP go-live for one pilot customer" looks like. Minimum to run one
customer in production:

> **1, 2, 4, 6, 7, 9, 10, 12, 13, 15, 22, 23**

Everything else can follow in month-2 iterations once you have a live
signal.

For a tick-through, ordered operator worksheet covering exactly this
subset, see [`PILOT_GO_LIVE_WORKSHEET.md`](./PILOT_GO_LIVE_WORKSHEET.md).
