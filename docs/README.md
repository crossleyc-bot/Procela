# docs/

Standalone documents that don't belong in the app or the code.

### Product & demo

| File | Purpose |
|---|---|
| [`TRAINING.md`](./TRAINING.md) | Hands-on 90-minute walkthrough of Procela. Written against the Tidewater Utilities demo fixture; the shape (Modules 1–12) applies to any customer once their own data is loaded. Served in-app at **Help → Training**. |
| [`demo-playbook.html`](./demo-playbook.html) | Presenter's runbook for the 45-minute Procela demo against the Tidewater Utilities fixture. Open in a browser or Cmd/Ctrl-P to print. |
| [`edge-connector-demo.md`](./edge-connector-demo.md) | One-command Docker demo (`docker compose --profile demo up --build`) that runs real on-prem edge connectors against a seeded source database — split by industry (a Tidewater Utilities connector scans `utility`, a Momentum Industries connector scans `shipbuilder`) to show discovery and connector-measured data quality. |

### Go-live & operations

| File | Purpose |
|---|---|
| [`PILOT_GO_LIVE_WORKSHEET.md`](./PILOT_GO_LIVE_WORKSHEET.md) | The fast-path subset (see `STATUS.md` § Go-live checklist), as an ordered tick-through operator worksheet for standing up one pilot customer on AWS. All ops/config, no code. |
| [`DEPLOY_RUNBOOK.md`](./DEPLOY_RUNBOOK.md) | Day-0 secret & config provisioning: how to generate each secret, where it lives (AWS Secrets Manager / Helm), and how to verify the app came up configured. Covers checklist #6–#12. Opens with a **Deployment models** section (multi-tenant SaaS vs. SaaS + on-prem connector vs. fully on-premise). |
| [`DR_RUNBOOK.md`](./DR_RUNBOOK.md) | Disaster-recovery procedures — restore from backup, roll back a migration, rotate a compromised secret, full rebuild — for checklist #23. |
| [`RELEASING.md`](./RELEASING.md) | How the on-prem connector container image is released and published to GHCR — `connector-v*` tags → semver + `latest`, trunk → `edge`/`sha-*`, manual dispatch, provenance/SBOM, and the one-time package-visibility prerequisite. |

### Planning & roadmap

| File | Purpose |
|---|---|
| [`STATUS.md`](./STATUS.md) | **The single source of truth for status, roadmap and open work.** One consolidated doc: the snapshot, roadmap tracks A–E, open/partial items by priority, deferrals, recommendations, the full go-live checklist, the AWS production-hardening reference, the competitor coverage matrix, the discovery coverage survey, and the GA-audit outcome. The in-app **/roadmap** page renders it live. (Supersedes the former `ROADMAP.md`, `future-work.csv`, `capability-matrix`, `non-relational-discovery.md`, `GO_LIVE_CHECKLIST.md`, `AWS_PRODUCTION_GUIDE.md`, and GA-audit docs.) |

### Architecture & data model

| File | Purpose |
|---|---|
| [`POSTGRES.md`](./POSTGRES.md) | How to run the backend against Postgres locally and the repository pattern every entity follows. The cutover is complete; this is the reference shape for adding a **new** entity. |
| [`POSTGRES_CUTOVER_PLAN.md`](./POSTGRES_CUTOVER_PLAN.md) | Engineering plan (now executed) for moving persistence from JSON files to Postgres — current state, the boot-safety fix, and the ~10-PR sequence with critical path. Historical record of the cutover. |
| [`POSTGRES_CUTOVER_PR5_REPORT_ENGINE.md`](./POSTGRES_CUTOVER_PR5_REPORT_ENGINE.md) | File-level conversion design for the riskiest cutover step — routing the report engine through repositories without per-row N+1 joins. |
| [`DATA_OWNERSHIP.md`](./DATA_OWNERSHIP.md) | Which tables and columns are written by the interactive UI / REST API versus the on-prem edge agent (`@procela/connector`) — the four co-managed tables, their column-level split, the audit-only write stance, and how the connector (Option 2) maps onto a direct Connection (Option 1) as the metadata-only subset of the same catalog. |
| [`RBAC_PERMISSION_MATRIX.md`](./RBAC_PERMISSION_MATRIX.md) | Authoritative reference for role-based authorization. `packages/backend/src/lib/permissions.ts` is the source of truth; this explains it. |

For in-app help see `packages/backend/src/docs/HELP.md` (the Help page). The GA
tightening audit (§A–G, now closed) is summarised in `STATUS.md` § GA tightening
audit.
