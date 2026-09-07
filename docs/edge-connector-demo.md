# Edge-connector demo (utility + shipbuilder data)

Run **real** Procela on-prem edge connectors against a **real** source database
seeded with utility and shipbuilder test data — and watch them discover the
tables and measure their data quality inside the app. No stubs, no fabricated
connector row.

The demo is **split by industry**, so each company only sees its own data:

| Tenant | Connector | Scans schema | Discovers |
|---|---|---|---|
| **Tidewater Utilities** (electric / water) | Tidewater Edge Connector | `utility` | 4 utility tables |
| **Momentum Industries** (shipbuilding) | Momentum Edge Connector | `shipbuilder` | 4 shipbuilder tables |

Both connectors read the same physical source database (two schemas in one
Postgres) but each is paired into a different tenant and scoped to that tenant's
schema — so Tidewater never sees shipbuilder tables and vice-versa.

## What it shows

- The connector connects to a customer's operational database **on-prem**,
  discovers its tables and columns, and reports them to Procela as **Bronze**
  data assets. Row values never leave the source — only names, types, row
  counts, and freshness.
- When you add data-quality rules to those columns, the connector runs them as
  **aggregate pushdown** queries inside the source network and pushes back only
  pass/fail counts — driving **measured** health (badged as real, not "Est").

## One command

```bash
docker compose --profile demo up --build
```

That brings up the normal stack **plus** the demo services:

| Service | Role |
|---|---|
| `source-db` | A stand-in **customer** Postgres, seeded from `docker/demo/source-db/init/*.sql` with `utility.*` and `shipbuilder.*` operational tables (with deliberately dirty rows so DQ is non-trivial). This is **not** Procela's store. |
| `tidewater-seed` / `momentum-seed` | Seed the two tenants — Tidewater Utilities and Momentum Industries — so each connector has a home to pair into. Run once. |
| `tidewater-bootstrap` / `momentum-bootstrap` | Pair a real connector each (`pair/start` → `pair/claim`), one scoped to `utility` and one to `shipbuilder`, writing `connector.yaml` / `ship-connector.yaml` to a shared volume. Run once. |
| `tidewater-connector` / `momentum-connector` | The real agents. Each reads its config, discovers its schema's tables, reports them into its tenant, and measures any DQ rules. |

The schema each connector scans is set by the `SCHEMAS` env on its bootstrap
(comma-separated). To fold both industries back into one tenant, point a single
bootstrap at `SCHEMAS: utility,shipbuilder`.

The stack also runs a one-shot **`migrate`** service that applies the Prisma
schema (`prisma migrate deploy`) to Postgres before the backend starts — the
backend `depends_on` it completing. So the database is migrated automatically;
there is no manual migration step. (Migrations are a separate service, not part
of the backend image, mirroring the Helm migrate-hook Job used in production.)
This applies to a plain `docker compose up` too — see below.

A plain `docker compose up` (no `--profile demo`) is unchanged apart from the
same automatic `migrate` step.

## See it in the app

1. Open the app at <http://localhost:3000> and sign in (dev quick-login is fine).
2. Switch the org scope (top-left) to **Tidewater Utilities**.
3. **Data → Data Assets → Registry** — search `utility.` to see the 4 discovered
   utility tables, all **Bronze** (new arrivals surface as work items, not
   silently approved). Expand a row to see the discovered columns. You won't see
   any `shipbuilder.` tables here — those belong to the other tenant.
4. Switch the org scope to **Momentum Industries** and search `shipbuilder.` to
   see that tenant's 4 discovered tables.
5. **Settings → Integrations → On-prem connectors** — each tenant shows its own
   connector **ONLINE** with a recent heartbeat and its scan events.

## Measure data quality with the connector

Discovery alone doesn't measure quality — you tell Procela which columns matter:

1. Go to **Data → Data Quality → Rules → Add Rule**.
2. Pick a discovered asset (e.g. `utility.billing_accounts` under Tidewater),
   use the **Column** picker to target a column (e.g. `email`), and choose a
   **Rule Type** of **Not null**. The Rule Type is what makes the rule
   measurable — an untyped rule is never picked up by the connector. Add another
   (e.g. `service_class` → **In set** → `residential, commercial, industrial`).
   Under Momentum, try `work_packages.pct_complete` → **Numeric range** 0–100.
   (The quick way: on the **Quality** tab, expand an asset and use the per-column
   **Not null / Unique** buttons, which set the type for you.)
3. Within one scan cycle (`scanSeconds`, 30s in the demo) the connector picks up
   the rule plan, runs the aggregate query against the source DB, and the rule
   flips to a **measured** score. With the seeded data you'll see realistic
   numbers — e.g. `email` Not-null lands around **94%** (≈6% of rows have a null
   or malformed address), not a fabricated 100%.

The five pushdown-safe rule types run measured on the connector: `NOT_NULL`,
`UNIQUE`, `IN_SET`, `NUMERIC_RANGE`, `LENGTH_RANGE`. `REGEX_MATCH` / `CUSTOM`
still simulate.

## Schema drift & row-count signals

Independently of rules, each scan compares the reported column set against a
stored **schema fingerprint** on the asset. If a column is added, removed, or
retyped between scans, Procela lowers the asset's liveness health and opens an
auto-resolving **`SCHEMA_DRIFT`** governance issue (a later scan that matches the
previous schema closes it). A row-count **shrink** since the last scan is graded
by magnitude and feeds the same score, so a truncated or half-loaded table shows
up as a health drop. This runs on the on-prem connector report path **and** the
direct-connect discover/reconcile path (where introspection reads approximate
row counts from the engine's catalog statistics).

## Tuning

`docker/demo/bootstrap.mjs` renders the connector config from env (set on the
`tidewater-bootstrap` / `momentum-bootstrap` services in `docker-compose.yml`):

- `SCAN_SECONDS` / `HEARTBEAT_SECONDS` — cadences (kept short for the demo).
- `SOURCE_DSN` — the source database DSN (defaults to the `source-db` service).
- `CONNECTOR_NAME`, `ADMIN_EMAIL` — connector display name and the tenant admin
  to pair as.
- `SCHEMAS` — comma-separated schemas this connector scans (`utility` for the
  Tidewater connector, `shipbuilder` for the Momentum one). Defaults to
  `utility,shipbuilder` if unset.

To add or change the sample source tables, edit
`docker/demo/source-db/init/01-utility.sql` / `02-shipbuilder.sql` and recreate
the `source-db` volume.

## Reset

```bash
docker compose --profile demo down -v   # -v also drops the seeded source DB
```

## Running the connector without Docker

The same flow works against a locally-running backend and any Postgres:

```bash
# 1. Load the sample data into a Postgres you control:
psql "$SOURCE_DSN" -f docker/demo/source-db/init/01-utility.sql
psql "$SOURCE_DSN" -f docker/demo/source-db/init/02-shipbuilder.sql

# 2. Pair a connector + render config (writes ./connector.yaml):
PROCELA_URL=http://127.0.0.1:3001/api/v1 \
ADMIN_EMAIL=admin@tidewater-utilities.com \
SOURCE_DSN="$SOURCE_DSN" OUT=./connector.yaml \
node docker/demo/bootstrap.mjs

# 3. Run the agent:
PROCELA_CONNECTOR_CONFIG=./connector.yaml npm run dev -w packages/connector
```
