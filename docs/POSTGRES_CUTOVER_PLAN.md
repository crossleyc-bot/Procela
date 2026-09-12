# Postgres cutover plan

> **Status: complete — this is a historical record.** Every PR in the
> sequence below is delivered (each is tagged `(done)`), the whole backend
> runs on Postgres when `DATABASE_URL` is set, and a live-Postgres CI job
> gates it. See [`POSTGRES.md`](./POSTGRES.md) for the current-state
> playbook. The present-tense framing below is preserved as the record of
> how the cutover was planned and carried out.

Moving the backend from JSON-file persistence to Postgres so that setting
`DATABASE_URL` yields a correct, multi-instance-safe system. This is the
detailed engineering plan behind go-live checklist items **#3, #4, #5** in
[`STATUS.md`](./STATUS.md#go-live-checklist). It is grounded in the current
code under `packages/backend/src`, not a summary.

## 1. Where we actually are

**Already done (everything below — the section headers kept their
plan-time "~80%" framing; the full sequence has since landed):**

- 47 `db/*.repo.ts` repositories, each with a JSON path and a Prisma path,
  switched on `hasDatabase()` (`= !!process.env.DATABASE_URL`, `db/prisma.ts`).
- 56 Prisma models (47 entities + 9 join tables); `prisma/migrations/20260716200000_init`.
- ~37 route files route **their own** entity's writes through `getXRepository(store)`.
- CI has a `test-backend-live-db` job: spins up `postgres:16-alpine`, runs
  `prisma migrate deploy`, runs `live-db.test.ts` against real Postgres.

**The failure mode (why flipping `DATABASE_URL` today is unsafe):**

Every module-level array is loaded from JSON at boot **unconditionally**
(`export const people = loadStore('people')`, no `DATABASE_URL` gate). In
Postgres mode the repo ignores that array and writes only to Postgres — so the
array stays frozen at boot state (empty on a fresh DB). Anything reading the raw
array sees empty/stale data forever.

Two **boot hazards** compounded it (both fixed in PR 0 below): `startAutoSave`
and the shutdown `flushStores` ran unconditionally, so Postgres mode would
overwrite `.procela-data/*.json` with the stale/empty arrays every 10s.

**The scope is bigger than the checklist's four files.** Direct-array readers
that break under Postgres:

- The four checklist consumers: `services/report-engine`, `services/digest.service`,
  `services/scheduler.service`, `lib/org-scope`.
- **The entire auth subsystem**: `routes/auth.ts`, `auth-password.ts`,
  `auth-mfa.ts`, `auth-webauthn.ts`, `routes/scim.ts`,
  `services/account-lockout.ts`, `services/scim-groups.ts` — all mutate the
  `people` array + `saveStore`, all sync handlers.
- **Cross-entity foreign-array writes even inside repo-converted routes**:
  `agent-executions.ts` → `governancePolicies.push`/`mappings.push`;
  `data-lineage.ts` → `dataAssets.push`/`dataQualityRules.push`;
  `dama-roles.ts` → `governanceTasks.push`; `dashboard.ts` → `raciOverrides`.
- **8 stores with no Prisma model** (would be lost in a cutover): `scim-groups`,
  `branding`, `raciOverrides`, `schedulerState`, `aiTemplateCache`, `aiSettings`,
  `dbtAssetMappings`, `dbtTestMappings`.
- **In-memory-only auth state with no store *and* no model**: refresh-token
  sessions (`validRefreshTokens` Map, `auth.ts`), `authConfig`, `oidcProviders`.

## 2. The one strategic decision (make this first)

**How do direct-array consumers get their data in Postgres mode?**

- **Option A — Hydration bridge (fast, single-instance only).** At boot, hydrate
  each module array from Postgres; keep arrays in sync on write. Lets the 25+
  direct-array call sites keep working unchanged. But every instance has its own
  array → violates the stateless / horizontal-scaling mandate in `CLAUDE.md`,
  and goes stale across instances. Acceptable only for a **single-node pilot**.
- **Option B — Full repo conversion (correct end state).** Convert every
  direct-array read to `await repo.list({orgId})` and every write to
  `await repo.*`. Stateless, multi-instance safe. This is the destination and
  what the PRs below assume.

**Recommendation:** Option B. If a single pilot must go live sooner, PR 0 plus a
scoped Option-A bridge gives a correct single-node deployment in ~2 PRs, then
continue with B behind it.

## 3. PR sequence

Each PR is independently mergeable, keeps the JSON path (and all 833 existing
tests) green, and is verified by extending `live-db.test.ts` so the new path runs
against real Postgres in CI.

| PR | Title | Scope | Effort | Risk |
|----|-------|-------|--------|------|
| 0 | Postgres boot safety | Gate `startAutoSave`/`flushStores` on JSON mode; boot log for persistence mode | S | Low |
| 1 | Close the model gaps | Prisma models + repos for the 8 model-less stores (or explicit "accept loss") | M | Low |
| 2 | Auth persistence foundation | Models for sessions/refresh tokens, `authConfig`, `oidcProviders` (or Redis for sessions) | M | Med |
| 3 | Auth/SCIM → repo (async) | Convert `auth*.ts`, `scim.ts`, `account-lockout`, `scim-groups` off the `people` array to `await peopleRepo.*`; sync→async handlers | L | Med |
| 4 | org-scope conversion | Load org tree once per request, thread it through the ~25 route callers of `lib/org-scope` | L | Med (wide) |
| 5 | report-engine conversion | Pre-materialize the 9 stores; move join reads out of per-row closures; `executeReport`→async — see [`POSTGRES_CUTOVER_PR5_REPORT_ENGINE.md`](./POSTGRES_CUTOVER_PR5_REPORT_ENGINE.md) | M | **High** |
| 6 | digest + scheduler | `gapSnapshots`→repo (preserve push-order via `ORDER BY`); org iteration + `schedulerState`→repo | M | Med |
| 7 | Foreign-array long tail | Every `<foreignArray>.push/splice` outside its owning route → foreign repo | M | Med |
| 8 | JSON→Postgres migration script | `scripts/migrate-json-to-postgres.ts` (the missing `prisma/seed.ts`) | M | Med |
| 9 | Statelessness cleanup | Gate `loadStore` hydration off in PG mode; retire dead arrays | S–M | Low |
| 10 | Expand live-db CI | Business-flow tests under `DATABASE_URL`, not just one file (checklist #24) | M | Low |

### Detail per PR

**PR 0 — Postgres boot safety.** *Prerequisite for everything. Landed.*
Gates `startAutoSave(stores)` / `flushStores(stores)` on `!hasDatabase()` and logs
the resolved persistence mode at boot, so Postgres mode never overwrites the JSON
files. No behavior change in JSON mode (all 833 tests green).

**PR 1 — Close the model gaps.** *Implemented.* Seven of the eight orphan stores
don't fit the standard `{id}` entity repository, so they're modeled by shape:

- **`AppSetting`** — one generic key-value table (`key` PK, JSONB `value`) backing
  the three global singletons `branding`, `aiSettings`, `schedulerState`. Exposed
  via a `SettingRepository` (`get`/`set`), not the CRUD `Repository<T>`.
- **`ScimGroup`** — standard `{id}` model + `Repository<StoredScimGroup>` (members
  as a JSON column; no orgId — SCIM groups are directory-global).
- **`RaciOverride`** — composite `@@id([nodeId, personId])`, FK-free; repo exposes
  `list`/`upsert`/`remove`.
- **`DbtAssetMapping`** / **`DbtTestMapping`** — composite `@@id([orgId,
  dbtUniqueId])`, served by one generic org-keyed mapping repository.
- **`aiTemplateCache`** — deliberately **not** modeled; it is a regenerable AI
  cache and stays in-memory per instance in Postgres mode.

Adds a Prisma migration (`20260721000000_pg_cutover_pr1_orphan_stores`) and repo
tests (JSON path + stubbed-delegate Prisma path). No consumer changes yet — the
wiring lands per-subsystem in PRs 3/6/7.

**PR 2 — Auth persistence foundation.** *Implemented.* Backs the auth state that
was in-memory-only (no store, no model):

- **`RefreshToken`** model + `RefreshTokenRepository` (`list`/`get`/`upsert`/
  `remove`, keyed by `jti`) — replaces the `validRefreshTokens` Map in
  `auth.ts`. Timestamps kept as ISO strings to match `RefreshTokenContext`
  verbatim. (Postgres-backed; Redis with TTL remains a valid production
  alternative for this high-churn store.)
- **`OidcProvider`** model + standard `{id}` repo — replaces the `oidcProviders`
  Map; persists the plain `OidcConfig` (running providers reconstructed at the
  call site in PR 3). `clientSecret` must be KMS-encrypted at rest before
  production (checklist #11).
- **`authConfig`** — the one-field `{ activeProvider }` global singleton reuses
  the PR 1 `AppSetting` table (key `"authConfig"`); **no new model**.

Adds a migration (`20260721010000_pg_cutover_pr2_auth_persistence`) and repo
tests. No consumer wiring yet — the auth/SCIM cutover is PR 3.

**PR 3 — Auth/SCIM → repo.** *First behavior-changing PR — delivered as small,
independently-reviewable slices rather than one large diff.* The `Person` model
**already carries every auth column** (`passwordHash`, `mfaSecret`,
`webauthnCredentials`, `lockedUntil`, …), so no people-schema change — the routes
just bypass the repo.

Slices:
- **3a — SCIM Groups (done).** `services/scim-groups.ts` + the `scim.ts` `/Groups`
  handlers converted to async over the `ScimGroup` repo; the `/Users` DELETE
  handler awaits the (now async) member cleanup. Added the first SCIM-groups
  service tests (the subsystem had none). Self-contained — `scim.ts` is the only
  consumer.
- **3b — SCIM Users (done).** `scim.ts` `/Users` handlers converted to async over
  a local `getPeopleRepository(people)`: list/get/create/update/delete replace the
  `people.find/some/push/splice` + `saveStore` calls, mirroring the proven
  mutate-then-`update(id, person)` pattern from `routes/people.ts`. Added the
  first SCIM `/Users` route tests.
- **3c — Auth-providers config (done).** `authConfig` → `AppSetting` (key
  `"authConfig"`) via a shared `stores/app-settings.ts`; `oidcProviders` Map →
  `OidcProvider` repo. The read API (`getAuthProvider`/`getOidcProvider`) stays
  **synchronous** over the in-memory instances; the three writes
  (`updateAuthConfig`/`upsertOidcProvider`/`removeOidcProvider`) became async and
  persist, and a new `initAuthProviders()` (called at boot in `index.ts`)
  rehydrates the in-memory state from persistence. Added persistence tests.
- **3d — Refresh tokens (done).** `validRefreshTokens` Map → `RefreshTokenRepository`
  across `auth.ts` (mint / refresh / rotation / logout / SLO / the three
  `/sessions` handlers). `createRefreshToken` became async, so its callers in
  `auth.ts`, `auth-mfa.ts`, `auth-webauthn.ts` await it (their handlers were
  already async). Added the first `/sessions` + `/refresh`-rotation tests.
- **3e — Password / MFA / WebAuthn / lockout (done).** `auth-password.ts`,
  `auth-mfa.ts`, `auth-webauthn.ts`, `account-lockout.ts`, plus the remaining
  `people.find` + `saveStore('people', …)` in `auth.ts`'s login/callback/refresh
  handlers → `await peopleRepo.*` (mutate-then-`update(id, person)`). Lockout
  helpers (`recordFailedLogin`/`clearLockout`/`adminClearLockout`) became async;
  their callers and the `account-lockout` test were updated to await.

**PR 3 complete:** no direct `people`-array or `saveStore('people', …)` access
remains anywhere in the auth/SCIM subsystem — it reads and writes entirely
through the repositories.

Verify each slice: `tsc` + JSON suite green, plus the live-db CI job for the
Postgres path. This subsystem had almost no prior test coverage, so each slice
adds tests as it lands.

**PR 4 — org-scope (done).** Widest blast radius: `lib/org-scope` helpers are
called inline at **80+ sites across 24 route modules**, so an async conversion
would ripple `await` everywhere. Instead — since the org tree is small,
slowly-changing reference data read synchronously — org-scope keeps its public
API and reads from a **repo-backed cached snapshot in Postgres mode** (the live
`organizations` array in JSON mode): hydrated at boot via `initOrgScope()`
(wired in `index.ts`), refreshed on a short background TTL, and only ever
under-inclusive while cold (never over-inclusive → no cross-org leak). The
scoping logic is factored into pure `*In(orgs, …)` helpers with direct unit
tests. **All 24 caller files are untouched** and JSON-mode behavior is
byte-identical. *Follow-up:* invalidate the cache on org writes for immediate
read-your-writes (currently eventually-consistent within the TTL).

**PR 5 — report-engine (done).** Implemented per its design doc
[`POSTGRES_CUTOVER_PR5_REPORT_ENGINE.md`](./POSTGRES_CUTOVER_PR5_REPORT_ENGINE.md):
the `STORES` array-thunk registry became a `REPOS` registry over the 9 entity
repositories; `executeReport` is async and **materializes each needed entity
once** into an id-indexed `Map`, so the per-row join closures resolve via O(1)
lookups (no N+1 against Postgres). `filterByOrg`/`matches`/sort/limit are
unchanged; `validateDefinition` stays sync (empty-index stub). The two
`reports.ts` callers `await`. JSON-mode behavior is byte-identical.

**PR 6 — digest + scheduler (done).** `digest.service`: `gapSnapshots` → the
gap-snapshots repo; `takeGapSnapshot`/`findPreviousSnapshot`/`digestForOrg` are
async. Push-order is preserved — the repo's Postgres `list()` now `ORDER BY
takenAt` (matching the JSON array/push order `findPreviousSnapshot` walks); the
same-millisecond tie is a test/rapid-trigger edge only. `scheduler.service`:
`for (const org of organizations)` → `await orgRepo.list()`, the injected digest
inputs fetched once via repos, and `schedulerState` → the shared `AppSetting`
table (key `"schedulerState"`); `getLastWeeklyDigestFiredAt` /
`shouldFireWeeklyDigest` / `setLastWeeklyDigestFiredAt` / `resetSchedulerState`
are async. `tick()` was already async, so the timer plumbing is unchanged.
`routes/digest.ts` fetches inputs via repos and awaits. JSON-mode behavior
unchanged.

**PR 7 — Foreign-array long tail.** Grep-driven sweep: every
`<foreignArray>.push/splice/find/filter` outside the array's owning route, routed
through that entity's repo. Split into two mergeable parts:

- **PR 7a (done) — config stores → AppSetting.** `branding` and `aiSettings`
  retired to the shared `AppSetting` table via the 3c hydrate-at-boot + persist
  pattern (`initBranding()` wired into `index.ts`; `rehydrateAiOverride()` async).
  Reads stay synchronous over the in-memory copy; writes are async. The old
  `brandingStoreArray` autosave entry is removed. `aiTemplateCache` stays
  in-memory (unmodeled, per PR 1).
- **PR 7b (done) — clean foreign-entity creates.** The routes that create a
  *foreign* entity but whose own reads were already fine: `dama-roles.ts` +
  `governance-calendar.ts` (governanceTasks) and `connectors.ts` (dataAssets) now
  create through the target repository instead of `array.push` + `saveStore`.
  (The governance-tasks repo is built lazily inside the handler to avoid a
  circular-import init cycle.) The cascade `mappings.splice` in `organizations.ts`
  / `process-catalog.ts` are JSON-mode cleanups Postgres FK cascades handle, and
  `demo-seed` / one-time migrations are boot/dev tooling — all left as-is.
- **PR 7c (done) — dashboard `raciOverrides`.** Fully migrated: `GET /raci`
  fetches the overrides once via the repo (`raciRepo.list()`) and the two matrix
  branches read that snapshot; `POST /raci/override` upserts/removes through the
  repo. Retires the PR-1 `raciOverrides` orphan store.
- **Remaining route migrations (own foreign-array reads) — broader than a tail.**
  `agent-executions.ts` and `data-lineage.ts` are full multi-handler routes that
  read their own still-array-backed entity across several handlers (plus the dbt
  mapping repos to wire), and `dashboard.ts`'s stats/scorecard handlers still read
  `people`/`systems`/`dataAssets`/… arrays. These are PR-3-style route migrations,
  not quick tail items. **PR 9 drives them**: gating `loadStore` hydration off in
  Postgres mode makes every remaining stale-array reader fail loudly, surfacing
  exactly which routes still need converting.

**PR 8 — Migration script.** No `prisma/seed.ts` exists though `package.json`
points at it. Model on `services/demo-seed.service.ts` (already inserts in
dependency order). Swap each `saveStore(name, arr)` for a loop of
`getXRepository(arr).create(row)` (auto-targets Postgres). FK insert order:
1. `Organization` (self-parent `parentId`, `onDelete: Restrict` → two-pass:
   insert with null parent, then set), then `Person` (root, `email @unique`).
2. `System`, `ProcessNode` (self-parent), `DataDomain`, `Skill`, `DamaRole`, `PersonOrg`.
3. `DataAsset`, join tables (`SystemCustodian`, `DataDomainSteward`, `ProcessNode*`).
4. `GovernancePolicy` → `Mapping`, `FlowRelationship`, `DataAssetBinding/Column/Steward`.
5. Leaves (Org-only or no FK): tasks, issues, comments, notifications, audit logs,
   connectors, lineage links, snapshots, agents, etc.
Person `onDelete: SetNull` FKs let you insert even if a referenced person is
missing. Make it idempotent (skip/upsert on existing id). *Optional* — most
customers cut over on a fresh org with no JSON to preserve.

*Done:* `scripts/migrate-json-to-postgres.ts` (npm `db:migrate-json`). Reads
`.procela-data/*.json` and creates each row through the entity repositories
(which target Postgres when `DATABASE_URL` is set), in the FK-tier order above,
with a two-pass insert for the self-parent entities (`organizations`,
`processNodes`, `governanceGroups`). Idempotent (get-then-create skips existing
ids); the composite-key (`raciOverrides`, dbt mappings) and `appSetting` stores
upsert. A `--dry-run` flag reports per-store counts without writing (verified:
444 rows across 34 stores from the dev fixtures). `refreshTokens` (ephemeral)
and `aiTemplateCache` (regenerable) are skipped. **Caveat:** entity repos
persist scalar columns; M2M join tables (org memberships, stewards, skills,
process-node systems/controls) migrate only to the extent an entity's own
`create()` writes them — verify join coverage before relying on this for a
data-carrying cutover, or take the fresh-org path.

**PR 9 — Statelessness cleanup.**

- **9a (done) — stale-read diagnostic.** In Postgres mode `loadStore` now returns
  a Proxy that logs a one-time warning (with the calling site) the first time a
  consumer reads the array — turning "which routes still read arrays?" into a
  loud, self-reporting worklist. JSON mode returns the plain array unchanged
  (inert for dev/test). `aiTemplateCache` is allow-listed (intentionally
  in-memory). The Proxy is a faithful array (tested), so it never breaks a route
  — an unconverted route keeps working (on stale/empty data) but now announces
  itself in the logs.
- **9b (in progress) — act on the worklist + retire arrays.** Run against
  Postgres, convert every route the diagnostic flags to its repository, then
  flip `loadStore` in Postgres mode to return `[]` (no proxy) and retire the
  dead module-level exports so an instance holds no per-process entity state.
  Multi-increment (like PR 7) — the diagnostic's live worklist below is larger
  than the three routes originally guessed: most route *list handlers* still
  read arrays even though every entity's repo exists and is proven.

  **The live worklist (booted the backend against a real Postgres, drove
  traffic, collected the one-time warnings).** 29 stores still have a direct
  array read, each at a precise call site:

  | store | first call site | store | first call site |
  |-------|-----------------|-------|-----------------|
  | agentExecutions | ~~agent-executions.ts~~ **done (9b.1)** | governanceGroups | governance-groups.ts:114 |
  | agents | agents.ts:47 | governancePolicies | governance-policies.ts:49 |
  | analysisReports | ~~analysis-reports.ts~~ **done (9b.2)** | governanceTasks | governance-tasks.ts:168 |
  | auditLogs | audit.service.ts:97 | mappings | org-scope.ts:135 † |
  | comments | comments.ts:76 | notifications | notifications.ts:59 |
  | connectionSystemLinks | systems.ts:211 | operationsManuals | ~~operations-manuals.ts~~ **done (9b.3)** |
  | connections | connections.ts:127 | organizations | dashboard.ts:140 |
  | connectors | ~~connectors.ts~~ **done (9b.4)** | people | people.ts:331 |
  | damaRoles | dama-roles.ts:85 | processNodes | process-catalog.ts:280 |
  | dataAssets | data-assets.ts:97 | reports | ~~reports.ts~~ **done (9b.2)** |
  | dataDomains | data-domains.ts:36 | sops | org-scope.ts:135 † (aggregator-gated) |
  | dataLineageLinks | data-lineage.ts:114 | suggestionDismissals | ~~process-catalog + dashboard~~ **done (9b.3)** |
  | dbtCloudConnections | ~~dbt-cloud-connections.ts~~ **done (9b.2)** | syncConnections | ~~sync-connections.ts~~ **done (9b.4)** |
  | decisionRights | ~~decision-rights.ts~~ **done (9b.2)** | systems | systems.ts:106 |
  | flowRelationships | ~~process-catalog + dashboard~~ **done (9b.4)** | (connectorEvents) | ~~connectors.ts~~ **done (9b.4, bonus)** |

  **Progress: 10 / 29 stores converted** (+ `connectorEvents`, a latent 30th the
  original traffic sweep never triggered, cleared as a bonus). Remaining: 19.

  † The `filterByOrgScope()` framing turned out too optimistic: the *first*
  diagnostic hit for these stores was a `filterByOrgScope` call, but a store's
  warning only clears once **every** reader of its array is converted — and the
  real shared readers are the **generic aggregators**: `organizations.ts` (org
  deletion-impact summary + export + reset read ~17 stores directly),
  `dashboard.ts` `/stats`, `process-catalog`, `chat`, `search`,
  `digest.service`, `gap-detection`, `enterprise-view`, `exports`, `docs`,
  `analysis`. `mappings` alone is read in **16 files**. So `sops` (gated on the
  `organizations.ts` aggregator) and `mappings` (16 files) are **not** isolable
  leaf work — they belong to the aggregator phase. `operationsManuals` (single
  reader) and `suggestionDismissals` (process-catalog + one dashboard line) were
  cleanly isolable and are done.

  Each store is independent work; the `loadStore → []` flip is the *last* step,
  only safe once the table above is empty.

  - **9b.1 (done) — `agent-executions`.** Self-contained (sole live reader of the
    `agentExecutions` array; `agent-schedules` imports only `runAgentExecution`,
    and `index.ts`'s autosave closure is inert in PG mode). Converted all six
    handlers to `agentExecutionsRepo` (list/get/update/delete), guarded the
    boot-time `promotedDocumentId` backfill to JSON mode (Postgres rows always
    carry the column). Verified against a **local Postgres**: list/get read from
    PG, review + delete-all write to PG, and the `agentExecutions` boot warning
    is gone. PG mapping already covered by the live-db round-trip suite; JSON
    behaviour unchanged (repo wraps the same array), full suite green.
    *Deferred to their own line items:* the promote handler's foreign writes to
    `governancePolicies` / `mappings` (those stores' own conversions).

  - **9b.2 (done) — simple-leaf batch: `analysis-reports`, `reports`,
    `decision-rights`, `dbt-cloud-connections`.** Four self-contained single-store
    CRUD routes (no foreign-array reads of their own store). Each converted its
    remaining list/get reads to its repository (writes already went through the
    repo). Route-specific notes: `decision-rights`/seed now pre-fetches the org's
    rights once and creates each via the repo (dropped the `push` + `saveStore`);
    `dbt-cloud-connections` guarded its boot-time polling-field backfill to JSON
    mode, made the `requireConn` helper async, and moved `performRefresh`'s two
    saves + the scheduler tick's array scan onto the repo. Verified against a
    **local Postgres**: create/list/seed round-trip through PG (e.g. decision-
    rights create + seed → 11 rows in `decision_rights`; dbt token never leaked
    via `publicShape`), and all four boot/traffic warnings are gone. tsc clean,
    full suite green (890).

  - **9b.3 (done) — the isolable `filterByOrgScope` stores: `operations-manuals`,
    `suggestion-dismissals`.** Investigating "the filterByOrgScope four" surfaced
    the aggregator finding above (see †). Of the four, only these two had a
    bounded reader set and could be fully cleared:
    - `operations-manuals` — single reader (its own route). Converted list
      (`filterByOrgScope(await repo.list(), …)`), get/put/delete, and the seed
      dup-check (pre-fetch once). Seed → 7 rows in `operations_manuals`.
    - `suggestionDismissals` — read in `process-catalog` (the `dismissedTargetsFor`
      helper, now async; three dismissal CRUD handlers) and one `dashboard` `/stats`
      line. `process-catalog` now `export`s its `suggestionDismissalsRepo`; the
      dashboard reader uses it via the existing lazy `require` (keeps JSON mode
      wrapping the real array — passing `[]` to the factory would have read empty
      in file mode). `/stats` + the three suggestion handlers made async.
    Verified against a **local Postgres**: both readers work, and neither store
    warns at boot or under traffic. `sops` and `mappings` deferred to the
    aggregator phase (see †). tsc clean, full suite green (890).

  - **9b.4 (done) — isolable-leaf sweep: `sync-connections`, `connectors`
    (+ `connectorEvents`), `flowRelationships`.** Re-ran the reader-footprint
    check (read-triggering methods only — `push`/`splice` don't trip the Proxy,
    so `demo-seed`'s array writes never counted) to find stores with a bounded
    reader set:
    - `sync-connections` — single reader. Five id-`find`s → `repo.get`, list →
      `repo.list({orgId})`, boot-time `connectionId` backfill guarded to JSON
      mode. Create → 1 row in `sync_connections`.
    - `connectors` — single reader. Token-lookup middleware (`requireConnectorToken`,
      now async), list, three `find`s, and the exported `scanForOfflineConnectors`
      (sync → async: reads via `repo.list()`, writes each transition via
      `repo.update`; callers in `index.ts`'s offline-scan interval and the connector
      test updated to await). Its `connectorEvents` reader (one handler) was cleared
      in the same pass — a latent store the original traffic sweep never triggered.
    - `flowRelationships` — read in six `process-catalog` sites (delete-all,
      node-delete cascade, GET `/flows`, the POST `/flows` dup-check + cycle-BFS,
      DELETE `/flows/:id`) and one `dashboard` `/stats` line. `process-catalog`
      now `export`s its `flowRelationshipsRepo`; dashboard imports it. The POST
      `/flows` handler fetches the flow set once and reuses it for both the
      duplicate check and the cycle BFS. GET `/flows` made async.
    Verified against a **local Postgres**: sync-connections + connectors create
    rows in PG, all readers work, and none of the four warn at boot or under
    traffic. tsc clean, full suite green (890).

  **Aggregator phase.** The 19 remaining stores are all read by the generic
  multi-store aggregators (see †), so they clear only once those aggregators
  are converted. Unlike the leaf increments, converting one aggregator doesn't
  make a store's warning disappear (the store has other readers) — the payoff is
  (a) **correctness**: in Postgres mode these endpoints currently read empty boot
  arrays and silently return wrong results, and (b) removing a shared reader so
  each store drops toward its last one. Verification shifts from "warning gone"
  to "endpoint reads/writes the right PG data + emits no stale read of its own."

  - **9b.5a (done) — `organizations.ts` read aggregators: `/:id/impact`,
    `/:id/snapshot`.** Both tally / export every entity in an org subtree across
    ~16 foreign stores. Added a repo-backed `loadOrgScopeStores()` helper (a
    registry of `{routePath, storeExport, repoPath, repoFactory}` per store; lazy
    `require` avoids the import cycle, `make(arr).list()` reads Postgres in DB
    mode and the wrapped array in JSON mode) and routed both endpoints through it;
    the `organizations` tree itself now comes from `orgRepo.list()`. Both handlers
    made async. Verified against a **local Postgres**: seeded a data-asset in an
    org → `/impact` reports `dataAssets:1` and `/snapshot` includes it, read from
    PG (pre-conversion both would read the empty boot array and report 0). tsc
    clean, full suite green (890). *Deferred to 9b.5b:* the `DELETE /:id` cascade
    (reads **and** deletes/moves/orphans the same 16 stores — higher blast radius,
    its own PR).

  - **9b.5b (done) — `organizations.ts` `DELETE /:id` cascade.** The subtree
    deletion that removes descendant orgs and, per a `{actions}` body, deletes /
    moves / orphans rows across the same 16 foreign stores — previously all direct
    array `splice` + `saveStore`, i.e. **completely broken in Postgres mode** (it
    mutated JSON files, deleting nothing from the DB). Rewrote it repo-backed:
    - The subtree is computed locally from `orgRepo.list()` — `people.getDescendantOrgIds`
      reads the stale org array (would return `[]` in PG mode, so the cascade would
      only touch the root); reparent/delete of orgs now go through `orgRepo`.
    - `applySingleOrg` / `applyMultiOrg` are now async and take a `Repository`
      instead of a store array: `list()` once, then `delete()` / `update()` each
      matched row (orphan rewrites `orgIds[]` and re-homes `orgId`). A new
      `repoForStore(key)` accessor (same registry as the loader) hands each helper
      its repo.
    - The cross-reference cleanup (prune `governanceGroups.members`, delete
      `damaRoles`/`mappings` by dangling FK, strip `dataDomains.dataAssetIds`) is
      likewise repo-backed.
    Verified against a **local Postgres** across every path — seeded an org
    subtree + foreign rows directly in PG (the create endpoints that would seed
    them are themselves unconverted aggregators — see below), then: descendant +
    root org delete (3 orgs → 1), foreign single-org delete (`data_assets` → 0),
    multi-org **orphan** rewriting a person's `person_orgs` join from `[child,
    keeper]` to `[keeper]`, multi-org **move** re-homing a process node to a keeper
    org, and cross-ref cleanup pruning a mapping whose data-asset was deleted.
    tsc clean, full suite green (890). **`organizations.ts` is now fully
    converted.** *Surfaced along the way:* `POST /organizations` and
    `POST /data-assets` still validate against the stale org array (reject
    PG-created parents/orgs), so they're on the aggregator worklist too.

  - **9b.6 (done) — `dashboard.ts` (all 7 handlers).** The read aggregator behind
    the dashboards: `stats`, `scorecard`, `raci`, `raci/override`, `my-items`,
    `my-dashboard`, `governance-status` tally data across 13 stores. Added
    module-level repo handles (`getXRepository(<importedArray>)` for each store),
    then gave every handler a `Promise.all([...repo.list()])` at the top whose
    local consts **shadow the array imports** — so each handler's tallying logic
    is otherwise unchanged. The five sync handlers became async. Verified against
    a **local Postgres**: all seven endpoints return 200 with **zero** dashboard
    stale-read warnings, and `stats` reflects PG data (seeded a BRONZE asset →
    `dataAssets:1, bronze:1`, where the pre-conversion path reported 0). tsc
    clean, full suite green (890). (`flowRelationships` + `suggestionDismissals`
    readers here were already converted in 9b.3/9b.4.)

  - **9b.7 (done) — `search.ts` (global Cmd-K search).** A single `GET /` handler
    that scores a query across 9 stores (`systems`, `dataAssets`, `processNodes`,
    `connections`, `people`, `dataDomains`, `governanceGroups`, `glossaryTerms`,
    `mappings`). Added module-level repo handles + one `Promise.all` fetch at the
    handler top (local consts shadow the imports); handler made async. Verified
    against a **local Postgres**: seeded a "Zephyr SCADA" system → `?q=Zephyr`
    returns it (`type: system`), read from PG (pre-conversion: empty array, 0
    results); zero `search.ts` stale warnings. tsc clean, full suite green (890).

  - **9b.8 (done) — `gap-detection.ts`.** A single `GET /` handler computing 11
    gap categories across 7 stores (`processNodes`, `dataAssets`, `dataDomains`,
    `people`, `connections`, `systems`, `mappings`). Same shadowing pattern; the
    module-level `findAncestorPath` helper was parameterised to take the
    repo-loaded node set (it read the `processNodes` import directly), and the
    lazy `require('./mappings')` became a static import + repo handle (no cycle:
    `mappings` imports only entity routes). Handler made async. Verified against a
    **local Postgres**: seeded an unmapped BRONZE asset → `orphanedAssets:1,
    unlinkedAssets:1`, read from PG (pre-conversion: 0); zero `gap-detection.ts`
    stale warnings. tsc clean, full suite green (890).

  **Entity routes (own list/read handlers).** The core entities' *write*
  handlers were converted long ago, but their read handlers + boot migrations
  still scan the arrays. Converting an entity's own route removes its single
  biggest reader; the store fully clears once the remaining aggregators drop it
  too. (Verification: the store no longer appears in the diagnostic when the
  route is exercised; any residual warnings the file still emits are for
  *foreign* stores it reads, tracked under those stores.)

  - **9b.9a (done) — `systems.ts`.** Nine handlers + a helper chain
    (`decorate` → `enrichIntegrations`/`referencedByIntegrations`, plus
    `validateIntegrations`) that read the `systems` array. Parameterised the four
    helpers to take the repo-loaded list; each handler fetches
    `await systemsRepo.list()` (or `.get`) and threads it through. Two boot
    migrations (the connectivity/integrations legacy rewrite and the
    `process.nextTick` dangling-reference prune) guarded to JSON mode — Postgres
    carries the canonical shape and enforces referential integrity via FKs. The
    import dup-check pre-fetches once and appends created rows so intra-import
    duplicates are still caught. Verified against a **local Postgres**: created
    two systems (one integrating with the other) → list resolves the integration
    target name from PG (`targetSystemName: "SysA"`) and `/:id/360` shows the
    reverse edge (`referencedByIntegrations: ["SysB"]`); the `systems` store no
    longer warns (the file's two residual warnings are foreign reads —
    `connectionSystemLinks`, `mappings`). tsc clean, full suite green (890).

  - **9b.9b (done) — `data-assets.ts` (`dataAssets` store).** 21 handlers; scoped
    to the `dataAssets` store (its sub-stores `dataAssetBindings`/`dataAssetColumns`
    weren't in the flagged set, and touching them would force the exported
    `getPrimaryBinding`/`purgeBindingsForConnection` async — cross-module ripple
    into `data-quality`/`connections` — so deferred). Converted the ~15 uniform
    `dataAssets.find(id)` lookups to `dataAssetsRepo.get`, the two
    `filterByOrgScope(dataAssets,…)` list handlers (list + orphans) to
    `repo.list()`, and `DELETE /all` to list+delete; three boot migrations
    (steward/dataType/health/origin backfills, `backfillOwnerPersonIds`,
    `migrateLegacySourceFieldsToBindings`) guarded to JSON mode. Six sync handlers
    made async. Verified against a **local Postgres**: create → list/get/orphans
    all read PG (`count:1`); the `dataAssets` store no longer warns (the one
    residual warning is a foreign `systems` read, tracked under systems). tsc
    clean, full suite green (890).

  - **9b.9c (done, partial) — `people.ts` handler reads.** Converted the CRUD/list
    handlers to repos: `DELETE /all`, `GET /`, `GET /:id`, `/:id/360`,
    `/:id/impact`, `/:id/forget` (GDPR), and the create/import email-dup checks
    (list-then-find; import prefetches once and appends created rows for
    intra-import dedup). The two legacy boot migrations (role→EDITOR, skillIds
    backfill) guarded to JSON mode. Verified against a **local Postgres** (person
    seeded directly): `GET /`, `GET /:id`, `/impact` all read PG and
    `publicPerson` still strips the password hash. **`people` is NOT yet fully
    cleared** — its *exported, synchronous* access-control helpers
    (`getVisibleOrgIds` / `canAccessOrg`, read on every request by auth middleware
    across the codebase) still read the array (people.ts:291). Making them async
    would ripple through the whole auth layer; the correct fix is a repo-hydrated
    **people cache** mirroring PR 4's org-scope cache — a distinct, auth-sensitive
    follow-up. Also surfaced: `POST /people` (like `POST /organizations` /
    `/data-assets`) validates the org against the stale array and has a
    create-path failure on PG — part of the create-endpoints worklist. tsc clean,
    full suite green (890).

  - **9b.10 (done) — create-endpoints cluster.** The user-visible "can't create
    anything on Postgres" breakage: create handlers validated the org against the
    stale `organizations` array (empty in PG mode → every create with an org
    parent/assignment 400s). Fixed the two raw-array validations:
    `POST /organizations` parent-id check → `orgRepo.get(parentId)`;
    `POST`/`PUT /people` assigned-org check → `organizationsRepo.list()` (added an
    org-repo handle to people.ts). `POST /data-assets` already validates via
    `isOwnershipLevel` (the PR 4 org-scope cache) and needs no change. Verified
    against a **local Postgres** end-to-end: create top-level company → child
    division (parent-id validated from PG) → person in the division → data-asset
    in the company all succeed (orgs=2, people=1, assets=1). Note: the org-scope
    cache is eventually-consistent (~5s TTL), so an org + data-asset created in
    rapid succession can hit a brief window where `isOwnershipLevel` hasn't seen
    the new org yet — inherent to PR 4's cache, not a create bug (a boot-hydrated
    org creates assets immediately). tsc clean, full suite green (890).

  - **9b.11 (done) — people cache (access control on Postgres).** The exported,
    synchronous access-control helpers in `routes/people.ts` (`getVisibleOrgIds`
    / `canAccessOrg`, called by auth middleware on every request) read the
    `people` and `organizations` arrays directly. In Postgres mode both are the
    empty boot array, so `getVisibleOrgIds` found no matching person → returned
    `null` → **unrestricted** — i.e. every user saw everything (a security hole),
    and org-scoped views leaked cross-tenant. Fixed by mirroring PR 4's org-scope
    cache: a repo-hydrated **people cache** (`peopleSource()`, hydrated at boot
    via `initPeopleCache()`, refreshed on a 5s TTL) plus a new exported
    `getCachedOrgList()` on `lib/org-scope` so the same helpers read the hydrated
    org list. The four helpers shadow the module arrays with the cached sources;
    bodies unchanged. Verified against a **local Postgres**: a non-admin
    `ORG_ADMIN` scoped to one division now correctly sees **only that division**
    (pre-fix: all orgs, unrestricted); the dev super-admin stays unrestricted.
    tsc clean, full suite green (890). (This clears people.ts's own remaining
    `people` read; the store stays flagged until its other file readers —
    systems/chat/exports/docs/comments/governance-*/data-quality — convert.)

  - **9b.12 (done) — data-domains.ts entity route.** Writes already went
    through `dataDomainsRepo`; converted the remaining stale-array *reads*:
    every `dataDomains.find/filter/map` → `dataDomainsRepo.get/list`
    (DELETE `/all`, GET `/`, `/summary`, `/:id`, `/:id/impact`, POST dup check,
    PUT, PATCH `/bulk`, POST `/bulk-delete`); `enrichDomain` parameterised to
    take the repo-loaded `people`/`dataAssets` lists (handlers pass
    `Promise.all([...])`); the two `organizations.find(statusMode)` reads →
    `getCachedOrgList()`; boot status-migration guarded behind `!hasDatabase()`.
    **Circular-import trap fixed:** `people.ts` and `data-assets.ts` both
    value-import `dataDomains` from this module, so it can be evaluated as a
    side-effect of loading either — at which point their `people` / `dataAssets`
    bindings are still in the temporal dead zone. Constructing
    `getPeopleRepository(people)` at *module-init* read that TDZ binding and, via
    the node `--test` loader, **hung** (`tenant-branding.test.ts` load, 0
    subtests). Fixed by building both foreign repos **lazily**
    (`peopleRepo()` / `dataAssetsRepo()` memoised on first call) so nothing reads
    a cyclic binding until request time. Verified against a **local Postgres**
    (18/18 checks): a PG-only "ghost" domain appears via `GET /` with `ownerName`
    + asset name enriched from PG, `/summary` / `/:id` / `/impact` read PG,
    DRAFT→ACTIVE persists, dup-check + bulk-delete + delete-all all hit PG.
    tsc clean, full suite green (890).

  - **9b.13 (done) — dama-roles.ts entity route.** Converted every
    `damaRoles.find/filter/map` → `damaRolesRepo.get/list` (DELETE `/all`,
    GET `/`, `/summary`, `/:id`, `/by-person`, `/by-agent`, POST dup +
    single-holder checks) and the foreign reads that enrich/validate the route:
    `people` / `agents` / `skills` / `dataDomains` `.find/.filter` →
    their repos; `roleOrgId()` parameterised to take the loaded domains list.
    Foreign repos built **lazily** (`peopleRepo()` etc.) — `people.ts`
    value-imports `dama-roles`, so eager `getPeopleRepository(people)` at
    module-init would hit the same TDZ-in-cycle hang as 9b.12; matches the
    file's already-lazy `governanceTasksRepo`. Boot agentId/agentName backfill
    guarded behind `!hasDatabase()`. **PG-only bug fixed:** a DOMAIN-scoped
    steward assignment auto-creates onboarding tasks with `orgId: scopeId` — but
    for DOMAIN scope `scopeId` is a *data-domain* id, so on Postgres the
    `governance_tasks_orgId_fkey` FK rejected it and the whole POST failed (JSON
    mode silently stored the wrong id). Now resolves the assignment's real org
    (`domain.orgId` for DOMAIN, `scopeId` for ORG) and uses it for the tasks.
    Verified against a **local Postgres** (25/25): create/list/enrich from PG,
    a PG-only "ghost" role surfaces, DOMAIN-scope validates the domain in PG,
    `?orgId=` resolves DOMAIN roles via the domain→org lookup, dup +
    single-holder + people-only rules read PG, `by-person`/`by-agent`,
    skill-match coverage off PG skills, steward onboarding tasks persist (4),
    summary counts, delete `:id`/`all`. tsc clean, full suite green (890).

  - **9b.14 (done) — comments.ts entity route.** Converted every
    `comments.find/filter` → `commentsRepo.get/list` (GET `/`, the parent
    lookup in POST, PATCH, DELETE); the foreign `people.filter/.find` reads in
    `parseMentions` / `dispatchMentionNotifications` / the POST author lookup
    are parameterised to take a repo-loaded people list (`peopleRepo()`, lazy);
    the v0-field boot migration is guarded behind `!hasDatabase()`. Verified
    against a **local Postgres** (15/15): author + @mention resolve from PG
    people, a PG-only "ghost" comment surfaces via `GET /`, reply threading
    reads the parent from PG (incl. reply-to-reply collapse + wrong-entity
    reject), edit is author-only and persists, soft-delete blanks the body in
    PG. tsc clean, full suite green (890). **Known foreign gap (out of scope):**
    the @mention path calls `createNotification` from `notifications.ts`, which
    is still a stale-array writer (`notifications.push` + `saveStore`) — so in
    Postgres mode mention notifications don't yet reach the DB. That's the
    `notifications` store's own conversion (its reads already go through the
    repo; only the create path lags); comments dispatches correctly.

  - **9b.15 (done) — notifications.ts (closes the 9b.14 gap).** The read
    endpoints already used `notificationsRepo`; this converts the write paths.
    `createNotification` (the sync helper ~14 inline call sites across 8 files
    depend on — several in non-async loops) keeps its synchronous signature and
    now branches: JSON mode pushes + saves as before; **Postgres mode persists
    through the repo as a fire-and-forget write** (`void repo.create().catch(log)`)
    — notifications are non-critical and eventually-consistent, the object is
    still returned synchronously, and awaiting would force every caller to
    change. GET `/count` reads via `repo.list()`; PUT `/read-all` and DELETE
    `/all` branch (JSON keeps the single bulk array-write + one save; Postgres
    issues a repo `update`/`delete` per row). Verified against a **local
    Postgres** (15/15): `POST /` and the `createNotification` helper both reach
    PG (helper polled, since fire-and-forget), a PG-only "ghost" surfaces via
    `GET /` newest-first, `/count` + `?unreadOnly=` read PG, `:id/read` and
    `read-all` mark PG rows, `:id`/`all` delete from PG. tsc clean, full suite
    green (890). This fully clears the `notifications` store.

  - **9b.16 (done) — business-glossary.ts entity route.** Writes already used
    `glossaryTermsRepo`; converted every `glossaryTerms.find/filter` →
    `glossaryTermsRepo.get/list` across all 10 handlers (GET `/`, `/summary`,
    `/:id`, POST + PUT dup checks, DELETE, `/seed`, PATCH `/bulk`, POST
    `/bulk-delete`, POST `/import`). `enrichTerm` parameterised to take the
    repo-loaded `people`/`dataDomains` lists (lazy `peopleRepo()` /
    `dataDomainsRepo()`); the `/seed` org-industry lookup switched from the
    stale `organizations` array to `getCachedOrgList()`; the `/import` loop
    prefetches the term list once and appends created rows so intra-batch
    duplicates are still caught. No boot migration in this file. Verified
    against a **local Postgres** (25/25): create with owner + domain enriched
    from PG, dup 409 off PG, list + status/category/domain/search filters read
    PG, a PG-only "ghost" term surfaces, `/summary`, `/:id`, PUT persist, seed
    resolves the org's Healthcare industry via the org-scope cache and creates
    industry terms in PG, bulk update/delete and CSV/JSON import (with dedup)
    all hit PG. tsc clean, full suite green (890).

  - **9b.17 (done) — sops.ts entity route.** Writes already used `sopsRepo`;
    converted every `sops.find/filter/some` → `sopsRepo.get/list` (GET `/`,
    `/:id`, PUT, DELETE, `/seed`). Two module-level helpers that read arrays
    were parameterised: `generateCode(allSops)` (scans existing SOP-### codes
    for the next number) and `resolveOwnerName(id, allPeople)` /
    `enrichSop(s, allPeople)` (foreign `people` read, via lazy `peopleRepo()`).
    POST and `/seed` load the SOP list from the repo for code generation; the
    seed loop appends each created SOP to that list so per-SOP `generateCode`
    and the title-existence check both see rows created earlier in the same
    batch. No boot migration in this file. Verified against a **local
    Postgres** (18/18): create yields SOP-001 with owner enriched from PG, a
    second create reads the prior code from PG → SOP-002, a PG-only "ghost"
    SOP surfaces, category/status/role filters read PG, `/:id`, PUT bumps
    version on a step change and persists, `/seed` creates 5 standard SOPs
    with distinct incrementing codes and is idempotent on re-seed, delete
    removes from PG. tsc clean, full suite green (890).

  - **9b.18 (done) — data-lineage.ts (dataLineageLinks CRUD/read handlers).**
    This file owns four stores (`dataLineageLinks`, `assetLineageEdges`,
    `dbtAssetMappings`, `dbtTestMappings`) plus a heavy dbt-import reconciler
    that also mutates foreign `dataAssets`/`dataQualityRules` arrays directly.
    Scoped this increment to the `dataLineageLinks` HTTP handlers: every
    `dataLineageLinks.find/filter/map` → `dataLineageLinksRepo.get/list`
    (DELETE `/all`, GET `/`, `/by-system/:systemId`, `/visualization`, `/:id`,
    PUT, DELETE) and the foreign `systems`/`dataAssets` enrichment reads in
    those handlers → lazy `systemsRepo()` / `dataAssetsRepo()`. This clears
    data-lineage.ts's own `dataLineageLinks` reads (the store stays flagged
    until its other readers — `enterprise-view.ts` + an `index.ts` boot line —
    convert). **Deliberately deferred to a dedicated dbt-import increment:** the
    `/asset-edges` GET and `reconcileManifestInner` / `import-dbt` path, which
    read+write `assetLineageEdges`, `dbtAssetMappings`, `dbtTestMappings` and
    directly `push`/`splice`+`saveStore` the foreign `dataAssets` and
    `dataQualityRules` arrays — that subsystem is coupled to the not-yet-
    converted `dataQualityRules` store and warrants its own PR. Verified
    against a **local Postgres** (19/19): create (+ same-source/target 400),
    list with source/target/asset names enriched from PG, a PG-only "ghost"
    link surfaces, `/by-system`, `/visualization` (nodes from PG systems,
    inbound/outbound counts, asset names on links), `/:id`, PUT persists,
    delete `:id`/`all`. tsc clean, full suite green (890).

  - **9b.19 (done) — process-catalog.ts (the big one) + a schema fix.** The
    largest route (~1950 lines): a heavily-mutated CRUD store read
    synchronously through `findNode` / `getChildren` / `getDescendants` at ~35
    sites, stateful per-level ID counters, 3 boot migrations, recursive tree
    helpers, and 24 handlers. Per-handler parameterisation would have been huge
    and risky, so `processNodes` uses a **source cache** like org-scope/people —
    but because this module both reads *and* writes the store, each mutating
    handler calls `refreshProcessNodesCache()` after its writes so
    create-then-read in the same flow stays consistent (verified). Hydrated at
    boot via `initProcessCatalog()` (wired into index.ts next to
    `initOrgScope`/`initPeopleCache`), which also re-seeds the ID counters from
    the DB so generated `activityId`s never collide. `findNode`/`getChildren`
    read `nodeSource()`; the 3 boot migrations are `!hasDatabase()`-guarded;
    `processVersions` (history + snapshot) and the two remaining
    `flowRelationships` reads go through their repos; `organizations` reads →
    `getCachedOrgList()`; and the reference validators
    (`validatePersonId`/`validateSystemIds`/`cleanControlIds`) now check
    `people`/`systems`/`governanceControls` via lazy repos so a create with
    valid owner/systems/controls isn't rejected on PG. The PUT handler fetches
    the node fresh from the repo so optimistic locking is correct.
    **Schema bug fixed:** `ProcessNode.activityId` was typed `@db.Uuid` but the
    app stores human-readable ids (`VS-0001`, `ACT-0042`) — so *every*
    process-node insert failed on Postgres (the repo test only ever used
    `activityId: null`, so CI never caught it). Migration
    `20260726120000_pg_cutover_process_node_activity_id_text` widens the column
    to text. Verified against a **local Postgres** (25/25): id counters from PG
    (VS-0001 → VS-0002), create-then-read consistency, owner enrichment,
    parent/system/control/person validation off PG, children+ancestry, a
    PG-only "ghost" node surfacing, status transition writing a version
    snapshot + version bump, `/history` off PG, optimistic-lock 409,
    apply-template bulk create with incrementing VS orderIndex + tree, and
    cascade delete. tsc clean, full suite green (890). **Deferred (documented):**
    the secondary Phase-3 suggestion (`/nodes/:id/{asset,system,people}-suggestions`)
    and `/data-graph` endpoints still lazy-require `dataAssets`/`mappings`/
    `systems`/`people` for their foreign reads, and the governance-template's
    `governancePolicies` dedup read — these belong to those stores' own
    conversions (esp. the deferred 16-file `mappings` store).

  - **9b.20 (done) — governance-controls.ts + governance-policies.ts.** First
    two of the governance cluster (tightly coupled — controls belong to a
    policy, and each cascades to the other on delete). Writes already used their
    repos; converted every `governanceControls`/`governancePolicies`
    `.find/.filter/.length` → repo `get/list`, made both `generateCode` helpers
    async (they read the store to pick the next `CTL-###` / per-type
    `CHA-/POL-/STD-/FRW-###` sequence — now off the repo), and parameterised the
    `resolveOwnerName`/`resolvePolicyName` enrichers onto repo-loaded
    `people`/`policies` lists (lazy repos). Cross-store paths go through repos
    too: the policy's `linkedControlsCount` and its delete-time "orphan the
    linked controls" cascade use the controls repo. `agent-executions.ts`
    imports `generateCode` (as `generateDocCode`) — its one call site now
    `await`s. Verified against a **local Postgres** (20/20): create with codes
    sequenced from PG (CHA-001, POL-001, CTL-001) + owner/policy-name
    enrichment, list/summary/`:id` read PG, PG-only rows surface,
    `linkedControlsCount`, update, and policy-delete orphaning its linked
    control (`policyId` cleared in PG). tsc clean, full suite green (890). The
    control-delete → `processNodes.controlIds` cascade stays a stale-array
    write (foreign `processNodes`) — it self-heals via process-catalog's
    `cleanControlIds` pruning, so it's left as a documented PG no-op.

  - **9b.21 (done) — governance-tasks.ts (CRUD).** Third of the governance
    cluster. Converted the HTTP CRUD read paths: `filterByOrgScope(governanceTasks, …)`
    in list/summary → `filterByOrgScope(await repo.list(), …)`; `:id`/PUT/DELETE
    `.find` → `repo.get`; and `enrichTask` parameterised onto a repo-loaded
    `people` list (lazy repo) for assignee names. Verified against a **local
    Postgres** (14/14): create with assignee enriched from PG, list + status/
    assignee filters + org-scope, a PG-only "ghost" task surfacing, summary,
    `:id`, status transition (IN_PROGRESS→COMPLETED sets completedAt), delete.
    tsc clean, full suite green (890). **Deferred (documented):**
    `sweepOverdueTasks` — the exported, synchronous overdue-notification helper
    called by the scheduler and by 13 sync test call-sites that push into and
    assert against the live `governanceTasks` array — still reads/writes the
    array. Converting it to async/repo would rewrite that sync test contract;
    it's a scheduler concern (like `createNotification`), left for a focused
    follow-up, so the store stays flagged until then.

  - **9b.22 (done) — governance-issues.ts (CRUD).** Fourth of the cluster; same
    shape as governance-tasks. Converted the HTTP CRUD reads: summary/list
    `filterByOrgScope(governanceIssues, …)` → `await repo.list()`; `:id`/PUT/
    DELETE `.find` → `repo.get`; and `enrichIssue` parameterised onto repo-loaded
    `people`/`dataDomains`/`dataAssets` lists (lazy repos) for reporter/assignee/
    domain/asset names. Verified against a **local Postgres** (15/15): create
    with reporter+domain+asset enriched from PG, list + severity/domain filters
    + org scope, a PG-only "ghost" issue surfacing, summary, `:id`, terminal
    status transition setting `closedAt`, delete. tsc clean, full suite green
    (890). **Deferred (documented):** the two exported sync auto-issue helpers
    `syncDataQualityIssueForRule` (called by the DQ engine/scheduler) and
    `openAgentOwnershipIssue` (called by the agents route) still
    `governanceIssues.find`/`.push` + `saveStore` the array — same sync-helper +
    caller/test coupling as `sweepOverdueTasks`; deferred to a focused
    follow-up, so the store stays flagged.

  - **9b.23 (done) — governance-groups.ts (last of the cluster, fully
    cleared).** The most write-heavy of the five: it used `.push`/`.splice` +
    `saveStore` throughout, not just `.find` reads. Converted every handler to
    the repo — DELETE `/all` (list+delete loop), GET `/` (list + `buildTree`),
    `generate-template` (prefetch org groups once, `repo.create` per template
    row, append to the local list so intra-batch parent lookups + the response
    tree stay correct), `:id` (member enrichment + parent/children off
    repo-loaded `people`/`agents`/groups), `:id/recommendations` (org groups +
    `dataDomains` via repos), POST (parent + council checks off `repo.list`),
    PUT/DELETE (`repo.get`), and the member add/remove handlers (members live on
    the group row, so each mutates `group.members` then `repo.update(group)`).
    The delete-time **re-parent-children cascade** now issues a `repo.update`
    per child instead of mutating the array. The two boot migrations (dedup +
    member backfill) are `!hasDatabase()`-guarded. Foreign `people`/`agents`/
    `dataDomains` reads use lazy repos. Verified against a **local Postgres**
    (25/25): generate-template hierarchy (idempotent re-run), create + parent
    validation, list + tree, a PG-only "ghost" group surfacing, person/agent
    member add (agent-only-ADVISOR rule) persisting to the group row, `:id`
    member enrichment + parent/children, recommendations off PG domains, member
    remove, update, delete with child re-parenting, and delete-all. tsc clean,
    full suite green (890). **This fully clears the `governanceGroups` store.**

  - **9b.24 (done) — control-tower.ts + enterprise-view.ts (aggregators).**
    First two of the read-only aggregator batch. `control-tower`'s `/summary`
    loads governanceIssues/Tasks/Policies/Controls + dataDomains/dataAssets/
    processNodes via repos (`Promise.all`) then runs the same in-memory
    `filterByOrgScope` + `countBy` roll-ups. `enterprise-view`'s graph builder
    loads processNodes/systems/dataAssets/dataDomains/dataQualityRules/people/
    dataLineageLinks/mappings via repos (mappings lazy — its module imports back
    into the catalog graph) and assembles the node/edge graph off those
    snapshots. Both were sync handlers → made async; no writes (the many
    `.push` calls build local result arrays, not stores). Verified against a
    **local Postgres** (14/14): control-tower issue/policy/coverage counts read
    PG (incl. a direct-PG insert bumping the total) with owners resolved from
    PG; enterprise-view emits process/system/asset/person nodes and the
    asset→system edge from PG. tsc clean, full suite green (890).

  - **9b.25 (done) — exports.ts (executive report aggregator).**
    `buildExecutiveReportMarkdown` read processNodes/dataAssets/systems/mappings/
    people synchronously to render the executive PDF/markdown. Made it async and
    repo-backed (loads the five stores via `Promise.all`); `buildContext`'s org
    lookup moved to `getCachedOrgList()`. Both handlers (`/executive.pdf`,
    `/executive.md`) await it, and the exported function's 3 sync test call-sites
    were made `async`/`await`. The audit-log "recent activity" section still uses
    `auditService.getAll` (the deferred `auditLogs` store). Verified against a
    **local Postgres** (7/7): the rendered markdown's catalog counts (value
    streams, systems, 2 data assets, 2 orphans, Gold/Bronze tier mix) and the
    org name all come from PG. tsc clean, full suite green (890).
    (**digest** needed no work — `digest.service` already reads `gapSnapshots`
    via its repo and takes processNodes/dataAssets/mappings by injection, and
    both callers — `routes/digest.ts` and `scheduler.service.ts` — already load
    those via repos, done in PR 6.)
  - **9b.26 (done) — analysis.ts (cube/pivot aggregator).** The pivot engine
    built its in-memory fact table and label lookups straight off the module
    arrays (systems, dataAssets, dataAssetBindings, dataDomains, processNodes,
    people, damaRoles, connections, connectionSystemLinks, mappings). Added the
    ten repo factories and made both builders repo-backed: `makeLookups()` loads
    six stores via `Promise.all` to build the id→label maps, and
    `buildFacts(orgId)` loads eight stores the same way (including processNodes
    and systems, which the owner-fact loops had still been reading directly).
    Both are now `async`; the `/cube` and `/drill` handlers became `async` and
    `await Promise.all([buildFacts(...), makeLookups()])`. `/dimensions` is
    static metadata and needed no change. Verified against a **local Postgres**
    (8/8): a Systems × Data Assets pivot and a Systems × People ownership pivot
    both read the seeded rows off PG, drill resolved a fact id back to
    label-enriched refs, and a data asset inserted directly into Postgres showed
    up in a subsequent cube call (fresh snapshot per request). tsc clean, full
    suite green (890).
  - **9b.27 (done) — chat.ts (AI-assistant catalog snapshot).** The two
    exported builders that pack the assistant's grounding context read ~14
    module arrays synchronously — `buildOrgSnapshot` (processNodes, dataAssets,
    systems, mappings, people, dataDomains, glossaryTerms, governancePolicies,
    governanceIssues, governanceTasks, dataQualityRules, connections,
    connectionSystemLinks, suggestionDismissals) and `buildEntityIndex`
    (processNodes, systems, dataAssets, people). In Postgres mode both would
    have handed Claude an empty catalog. Added the fourteen repo factories; both
    builders are now `async` and load every store once via `Promise.all` before
    the in-memory `filterByOrgScope`/tree-walk logic runs. The direct
    `organizations.find` org lookup in both handlers moved to
    `getCachedOrgList()`. `/chat` and `/chat/stream` await the builders; the
    chat-routes test's 17 synchronous builder call-sites were made
    `async`/`await`. Verified against a **local Postgres** (8/8): the snapshot
    and entity index both render a PG-only org's systems/assets/catalog, and a
    data asset inserted directly into Postgres appears in a later snapshot. tsc
    clean, full suite green (890). This completes the aggregator cluster —
    control-tower, enterprise-view, exports, analysis and chat all read
    Postgres; digest was already repo-backed (PR 6) and docs.ts serves static
    markdown (no store reads).
  - **9b.28 (done) — data-quality.ts (DQ rules CRUD + summary + scheduler).**
    Not a read-only aggregator — this route *owns* the `dataQualityRules` store
    and runs a once-a-minute rule scheduler — but every read and every
    find-then-mutate write went through the module array, so in Postgres mode
    the DQ dashboards were empty and the run/update paths 404'd. Converted the
    whole surface: the read handlers (`GET /`, `/summary`, `/by-asset/:id`,
    `/:id`, `/templates`) load via `dataQualityRulesRepo` (plus dataAssets /
    connections / dataAssetBindings for enrichment) instead of the arrays; the
    write handlers (`POST /`, `PUT /:id`, `DELETE /:id`, `DELETE /all`) resolve
    the row with `repo.get`/`repo.list` before `repo.update`/`repo.delete`;
    `compute-health` reads the rules + asset from the repos and writes the new
    `healthScore` back with `dataAssetsRepo.update`. The core `runRuleNow`
    (shared by `/:id/run`, `/run-all/:assetId` and the scheduler tick) is now
    `async` — it loads the asset + connection from the repos, persists the run
    result via `repo.update`, recomputes the weighted asset health from a fresh
    `repo.list`, and writes it back via `dataAssetsRepo.update`; `tickScheduler`
    iterates `repo.list()`. `contextForRule` / `getPrimaryBinding` were replaced
    with a store-agnostic `primaryBindingFrom(bindings, …)` that works off a
    loaded snapshot. The `syncDataQualityIssueForRule` governance-sync helper
    stays as-is (already-documented deferred item — it reads the governanceIssues
    array), and the `dataAssetColumns` column-name lookup in `POST /` is left to
    the data-assets cutover. Verified against a **local Postgres** (13/13):
    create→persist, list/summary/by-asset/get reads, PUT persisting
    score+status, compute-health writing asset health back to PG, a rule
    inserted directly into Postgres appearing via the API, and DELETE removing
    it — all off the DB. tsc clean, full suite green (890; dq-routes +
    dq-issue-sync 10/10).
  - **9b.29 (done) — deferred sync helper: `syncDataQualityIssueForRule`.**
    First of the three deferred governance auto-issue helpers, now unblocked
    because its only production caller — data-quality's `runRuleNow` — became
    async in 9b.28. The helper opened/updated/resolved a governance issue by
    `governanceIssues.find`/`.push` + `saveStore` and read `dataAssets.find` /
    `dataDomains.find` directly, so in Postgres mode the DQ engine's auto-issues
    never appeared. Made it `async`: the linked-issue lookup runs over
    `await governanceIssuesRepo.list()`; the asset and domain resolution use the
    module's existing lazy `dataAssetsRepo()` / `dataDomainsRepo()`; open →
    `repo.create`, resolve/bump → `repo.update`. `createNotification` stays a
    plain call (already PG-aware — fire-and-forget `notificationsRepo.create`
    when `hasDatabase()`). `runRuleNow` now `await`s it; the dq-issue-sync test's
    8 synchronous call-sites (6 `it` blocks) were made `async`/`await`. Verified
    against a **local Postgres** (6/6): a FAILING rule opens exactly one HIGH
    `DATA_QUALITY` issue routed to the PG-resolved domain steward, a second
    FAILING run is idempotent (no duplicate), and a PASSING run auto-resolves it
    with `resolutionSummary` + `closedAt` written to the DB. tsc clean, full
    suite green (890). *Still deferred:* `openAgentOwnershipIssue` (nested inside
    the synchronous `pauseAgentsForMissingOwner`, which reads the un-converted
    `agents` store — belongs to the agents-cluster cutover) and
    `sweepOverdueTasks` (governance-tasks scheduler + 13 sync test call-sites).
  - **9b.30 (done) — deferred sync helper: `sweepOverdueTasks`.** Second of the
    deferred governance helpers. The overdue-task sweep — driven by the
    `/sweep-overdue` route and the once-a-minute `scheduler.service` tick —
    iterated the `governanceTasks` array, stamped `overdueNotifiedAt` /
    `updatedAt` in place and `saveStore`'d, so in Postgres mode it swept an empty
    list and never notified. Made it `async`: scans `await governanceTasksRepo.list()`,
    and each fired task's `overdueNotifiedAt` + `updatedAt` are persisted via
    `governanceTasksRepo.update`. `createNotification` stays a plain call
    (PG-aware). Both callers now `await` — the route handler and
    `scheduler.service`'s `tick()` (already async). The overdue-sweep test's 10
    call-sites were awaited (the `it` callbacks were already `async`); the
    in-place `task.dueDate` / `overdueNotifiedAt` mutations in the "re-arms" case
    still work because `jsonRepository.list()` returns live element references
    and `update` does `Object.assign` on the same object. Dropped the now-dead
    `saveStore` import. Verified against a **local Postgres** (7/7): a sweep over
    four seeded tasks fires for exactly the two overdue active ones, stamps
    `overdueNotifiedAt` back to the DB, persists one WARNING notification per
    fired task, and a second sweep is idempotent (fires 0, no duplicate
    notifications). tsc clean, full suite green (890). *Still deferred:*
    `openAgentOwnershipIssue` (agents-cluster cutover).
  - **9b.31 (done) — agents cluster + `openAgentOwnershipIssue` (last deferred
    helper).** The third deferred governance helper couldn't be converted in
    isolation: its only callers live inside `agents.ts`'s synchronous
    `pauseAgentsForMissingOwner`, which read the still-array-backed `agents`
    store, so converting the helper alone would leave the pause-cascade reading
    an empty list in Postgres mode. Converted the whole cluster:
      * **agents.ts** — writes already went through `agentsRepo`; converted the
        reads. `GET /`, `GET /:id`, `PUT /:id`, `DELETE /:id`, `DELETE /all`
        load/mutate via the repo; `hasValidOwner` became `async` and reads the
        responsible person through a **lazy** `peopleRepo()` accessor (eager
        binding tripped the documented circular-import TDZ — `people`
        value-import in the TDZ at boot; the lazy accessor defers the read).
        `pauseAgentsForMissingOwner` is now `async`: `agentsRepo.list()` →
        filter ACTIVE-owned-by-person → per agent `await openAgentOwnershipIssue`
        + `agentsRepo.update`. The three `organizations.find` validations moved to
        `getCachedOrgList()`; the legacy skillIds/instructions backfill is now
        guarded `if (!hasDatabase())`.
      * **governance-issues.ts** — `openAgentOwnershipIssue` is `async`: dedup
        lookup over `await governanceIssuesRepo.list()`, open → `repo.create`.
      * **people.ts** — the DELETE and deactivate cascade call-sites now `await`
        `pauseAgentsForMissingOwner`.
    Verified against a **local Postgres** (8/8): create an ACTIVE agent with a
    valid PG owner, reject ACTIVE with no owner (invariant reads people off PG),
    list/`:id` reads, and the full cascade — deactivating the responsible person
    auto-pauses the agent **in PG** and opens exactly one HIGH `OWNERSHIP`
    governance issue **in PG**. tsc clean, full suite green (890;
    agents + agent-owner-invariant + dq-issue-sync 25/25). **All three deferred
    governance sync helpers are now repository-backed.**
  - **9b.32 (done) — systems.ts foreign-store reads (decoration + 360 + impact
    + delete cascade).** The systems store itself was already repo-backed, but
    the per-system *decoration* read two foreign stores off the module arrays —
    `resolveOwnership` (people → owner / deputy / custodian names) and
    `profilesForSystem` / `rollupConnectionStatus` (connections + the
    connection↔system join table → connection count + status pill). In Postgres
    mode every system therefore showed blank owners and `NOT_CONNECTED`
    regardless of real data. Converted the whole route's foreign reads:
      * Added lazy foreign-repo accessors (`connsRepo`, `linksRepo`,
        `dataAssetsRepo`, `mappingsRepo`, `peopleRepo`, `processNodesRepo`) —
        lazy for the same circular-import-TDZ reason as elsewhere; `people` /
        `processNodes` are `require()`d inside the accessor rather than
        top-imported.
      * `profilesForSystem`, `rollupConnectionStatus`, `resolveOwnership` and
        `decorate` now take pre-loaded snapshots (the join is done in memory);
        `connectionsForSystem` was inlined so the join table is read once.
      * `GET /`, `GET /:id`, `GET /:id/360` and `GET /:id/impact` load the stores
        they need once via `Promise.all` and thread them through; `/360`'s
        people / dataAssets / mappings / processNodes reads were converted too.
      * `DELETE /:id`'s connection↔system-link cascade now runs through
        `linksRepo().delete` instead of `splice` + `saveStore`.
      The boot prune block was already `hasDatabase()`-guarded. Verified against
      a **local Postgres** (12/12): list + detail decoration resolve owner name
      from PG people and `CONNECTED` status from PG connections+links; `/360`
      surfaces the linked connection, the asset that lives here, and PG-resolved
      ownership; `/impact` counts off PG; and deleting a system cascade-removes
      its join-table links from PG while the connection itself survives. tsc
      clean, full suite green (890).
  - **9b.33 (done) — process-catalog secondary foreign reads (suggestions +
    data-graph).** process-catalog's own store (`processNodes`) was converted in
    9b.19, but its four Phase-3 discovery endpoints still read foreign stores via
    `require(...)` + `.filter` on the arrays: `GET /nodes/:id/asset-suggestions`
    (dataAssets + mappings), `/system-suggestions` (systems),
    `/people-suggestions` (people + systems), and `GET /data-graph` (dataAssets +
    mappings + systems). In Postgres mode all four returned empty — no ranked
    suggestions and an empty data map. Added lazy `dataAssetsRepo()` /
    `mappingsRepo()` accessors (the module already had lazy `peopleRepo()` /
    `systemsRepo()`) and switched each endpoint to `await repo.list()` +
    in-memory filter/rank; `data-graph` became `async`. Verified against a
    **local Postgres** (9/9): asset-suggestions ranks an unmapped PG asset while
    correctly excluding the already-mapped one (proving both dataAssets *and*
    mappings are read off PG), system/people-suggestions return off PG, and
    data-graph surfaces the PG activity, the asset with its PG-resolved system
    name, and the PG mapping edge. tsc clean, full suite green (890;
    asset/system/people-suggestion + data-graph-routes + process-catalog-routes
    33/33).
  - **9b.34 (done) — data-quality `columnName` lookup (9b.28 gap close-out).**
    The one foreign read deferred when data-quality was converted in 9b.28: the
    `POST /` create handler resolved a column-scoped rule's display `columnName`
    with an inline `require('./data-assets').dataAssetColumns.find(...)`, so in
    Postgres mode a column-scoped rule was stored with a blank column name.
    Added a `dataAssetColumnsRepo` (the `data-asset-columns.repo` already
    existed) and hoisted the lookup to `await dataAssetColumnsRepo.get(columnId)`
    before the rule object is built. Verified against a **local Postgres** (3/3):
    creating a rule with a `columnId` resolves `columnName` from the PG
    `data_asset_columns` table and persists it. tsc clean, full suite green
    (890). This closes the last small foreign-read gap in the data-quality
    route. **Index autosave** needed no work — the JSON autosave timer and
    shutdown flush in `index.ts` are already gated on `!hasDatabase()`.
  - **9b.35 (done) — audit.service hash-chain → repository.** The tamper-evident
    audit ledger was the largest remaining reader: `auditService.log()` is called
    ~210 times across 39 files, always synchronously (fire-and-forget), and it
    appends to a SHA-256 hash chain where each entry links to the previous
    entry's `entryHash`. In Postgres mode every write went to the stale boot
    array and every query (`getAll`/`getByEntity`/`verifyChain`) read it back
    empty — the audit trail was effectively blank. Converted without touching the
    210 call-sites:
      * **`log()` stays synchronous / `void`.** It computes and advances the
        chain against an in-memory cursor, then fire-and-forgets
        `auditLogsRepo.create(entry)` (same durability model as
        `createNotification`). The tail source is mode-split so the chain is
        always correct and test-isolation-safe: JSON mode derives the tail from
        the array (the source of truth, reset per-test by the store-isolation
        helper); Postgres mode uses the cursor, seeded from the DB tail at boot
        by the new `initAuditChain()` (wired into `index.ts` next to the other
        cache initialisers). Computing the chain synchronously in-memory means
        concurrent `log()` calls can't fork it, regardless of when the async
        writes land.
      * **`getAll` / `getByEntity` / `verifyChain` / `redactPerson` are now
        `async`** and go through the repo (`list` orders by timestamp asc so the
        chain walk sees insertion order). `redactPerson` re-chains the tail and
        persists each scrubbed row via `repo.update`, then advances the cursor.
      * Callers followed: `routes/audit.ts` (list / export.csv / verify),
        `routes/trends.ts`, `routes/exports.ts` (already async), and the GDPR
        cascade — `gdpr.service.erasePersonReferences` became `async` and its
        `routes/people.ts` caller now awaits it. The `audit-chain` and
        `gdpr-cascade` test call-sites were made `async`/`await`.
      Verified against a **local Postgres** (11/11): three chained `log()` calls
      persist a linked chain to PG (root `prevHash=""`, each entry linking to the
      prior `entryHash`); `getAll`/`getByEntity` read off PG; `verifyChain`
      reports the PG ledger valid; `redactPerson` tombstones the target `userId`
      to `[deleted]` and re-chains in PG with the chain still verifying; and a
      post-redact `log()` chains onto the re-hashed tail. tsc clean, full suite
      green (890). *Durability caveat:* the PG insert was fire-and-forget here —
      a failed write was logged, not retried. **Hardened in 9b.38** with a
      serialized retry queue + graceful-shutdown flush.

  - **9b.36 (done) — dbt-import reconcile + asset-lineage edges → repository.**
    The last deferred subsystem. `POST /import-dbt` → `reconcileDbtManifest`
    fans a dbt manifest out across five stores; the writes to `assetLineageEdges`
    already went through a repo, but everything else read the module arrays, so
    in Postgres mode the import created assets/rules against stale state and its
    reconcile (match / prune) never saw prior rows. Converted the whole reconcile:
      * Loads `dataAssets`, `dbtAssetMappings`, `dbtTestMappings`,
        `dataQualityRules` and the org's existing dbt `assetLineageEdges` once as
        mutable working snapshots, so rows created earlier in the loop are
        visible to later iterations (exact-name asset match, rule dedup) before a
        re-read.
      * Asset upsert → `dataAssetsRepo().create` + push-to-working-copy; mapping
        upsert/repair → `dbtAssetMappingsRepo.upsert`; edge upsert → the existing
        `assetLineageEdgesRepo` but the **existing-edge lookup and the prune now
        read the loaded snapshot** instead of the empty array (the bug that made
        re-imports duplicate edges and prunes no-op in PG); test→DQ-rule
        create/refresh → `dataQualityRulesRepo().create`/`.update`; stale-rule
        prune → `dataQualityRulesRepo().delete` + `dbtTestMappingsRepo.remove`.
        The four whole-store `saveStore` calls were dropped (every write persists
        through its repo).
      * The sibling `GET /asset-edges` list view (edge + asset-name enrichment)
        was converted in the same pass — it read `assetLineageEdges` + dataAssets
        off the arrays. `dataQualityRules` is lazy-required (data-lineage ↔
        data-quality cycle); the dead `saveStore` / `dataQualityRules` imports
        were removed.
      Verified against a **local Postgres** (11/11): a first import creates 2
      assets + 1 edge + 1 DQ rule (with side-table mappings) in PG; an identical
      re-import is idempotent (0 created, edge touched, counts unchanged); and a
      shrunk manifest prunes exactly the dropped edge and test-derived rule while
      keeping the assets. tsc clean, full suite green (890).
  - **9b.37 (done) — retire the JSON arrays in Postgres mode (`loadStore → []`).**
    The final step. With every reader repo-backed, `loadStore(name)` now returns
    an empty, stale-read-instrumented array in Postgres mode instead of
    hydrating boot-state from `.procela-data/*.json` — so no dead JSON data
    lingers in memory and any un-migrated reader is forced to surface via the
    instrument proxy. Confirmed every one of the ~55 stores is repo-backed
    (only `aiTemplateCache`, a regenerable per-instance cache, stays real via
    `IN_MEMORY_STORES`). Booting the backend against a live Postgres then
    surfaced four remaining **boot-time** array reads (not request-path); each
    was guarded `if (!hasDatabase())` because its Postgres equivalent runs at
    boot: the audit tail-cursor seed (`initAuditChain` reseeds from the DB
    tail), the process-catalog ID-counter reseed (`initProcessCatalog` reseeds
    from the repo cache), the connections legacy `systemId → link` migration
    (owned by the `migrate-json` script in PG), and the governance-policies
    `documentType` load-time backfill (the column carries it in PG). The
    on-disk JSON files are left untouched — nothing writes them in PG mode — so
    a machine can still switch back to JSON mode and find its data. Verified:
    tsc clean; full JSON-mode suite green (890, unaffected — the flip is
    PG-only); the backend **boots against a live Postgres with zero stale-read
    warnings**; and the `live-db` suite passes 21/21 with the flip active.

**Every reader in the JSON→Postgres cutover is now repository-backed, and the
JSON arrays are retired in Postgres mode.**

  - **9b.38 (done) — audit-log write durability (serialized retry queue).**
    Follow-up hardening for 9b.35. The Postgres audit insert was
    fire-and-forget (`void auditLogsRepo.create(entry).catch(log)`), so a
    transient DB failure silently dropped the entry while the in-memory chain
    cursor had already advanced — a gap that only surfaced on a later
    `verifyChain`. Replaced it with a **serialized, retrying append queue**:
    `log()` stays synchronous / `void` but now enqueues in Postgres mode; a
    single drainer persists in FIFO order (so inserts land in the same order
    the chain was computed), retrying each write with capped exponential
    backoff (`persistAuditEntryWithRetry`, 6 attempts) before, as a last
    resort, logging the full entry at error level and dropping it so one poison
    row can't wedge the pipeline. `flushAuditQueue()` is awaited in the
    graceful-shutdown path (`index.ts` `server.close`) so a restart mid-write
    persists the backlog; `auditQueueDepth()` is exposed for health/metrics.
    JSON mode is unchanged — its `repo.create` runs synchronously, so tests and
    the JSON store still see the entry immediately. Verified: the retry policy
    is unit-tested with injected `create` + `sleep` (first-try success, recover
    after 2 failures, give-up after `maxAttempts`, backoff schedule) — full
    suite **894/894**; and against a **live Postgres**, 25 synchronously-logged
    entries drain to PG, `flushAuditQueue` empties the backlog, the chain still
    verifies (FIFO order preserved), and a second batch re-flushes cleanly.

The remaining follow-ups are ops-only, not app code: any future column-level
lineage work, and the go-live checklist (Postgres provisioning, secrets,
HTTPS, backups, monitoring, security review).

**PR 10 (done) — Expand live-db CI.** `live-db.test.ts` had a
`live-db repository round-trips` suite proving each repo maps to Postgres in
isolation. Added a `live-db business flows` suite that drives the
cutover-converted *services* against the same live Postgres — the paths that
broke most subtly during the cutover, where a service still closing over a
stale boot-time array would pass the repo tests but return empty here. Seeds via
the Prisma repos, then asserts the service reads what the DB holds:
report-engine `executeReport` resolving a `processNodes → responsiblePerson`
join off Postgres; org-scope `getVisibleOrgScope` cascading over a
`refreshOrgScopeCache()`-hydrated tree; `SettingRepository` set→get round-trip
through the `app_settings` Json column. Same SKIP-when-`DATABASE_URL`-unset
harness, so `npm test` stays fast locally and the suite runs in CI's
`test-backend-live-db` job (checklist #24).

## 4. Critical path & sequencing

```
PR0 (boot safety) ─┬─> PR3 (auth) ──> PR7 (long tail) ──> PR9 (cleanup) ──> PR10 (CI)
                   ├─> PR4 (org-scope) ─┘        (PR8 migration can land any time after PR1)
PR1 (models) ──────┼─> PR6 (digest/scheduler)
PR2 (auth models) ─┘
                   └─> PR5 (report-engine)  [parallelizable, highest risk — start early]
```

- **PR 0 first, always** — it stops Postgres mode from corrupting the JSON files.
- **PR 1 + PR 2 (models)** unblock PR 3 and PR 6.
- **PR 5 (report-engine)** is the long pole on risk — scope it early even if it
  merges later.
- PRs 3–7 are the bulk; each is verifiable in isolation against the live-db harness.

## 5. Deploy prerequisites (ops, not app code — parallel track)

Go-live checklist items that gate an actual Postgres deploy but need no app
changes: **#1** provision Postgres, **#2** `prisma migrate deploy`, **#7** RS256
`JWT_PRIVATE_KEY`/`PUBLIC_KEY`, **#8** real `REDIS_URL`, **#11** `KMS_PROVIDER`
for at-rest MFA/password secrets.

## 6. Rough size

~10 PRs. PRs 4, 5, 7 are the large ones; PRs 0, 9 are small. The critical path
for a **single-node pilot** (0→1→2→3→6 + migration) is a couple of weeks; full
statelessness (4, 5, 7, 9, 10) is the tail.
