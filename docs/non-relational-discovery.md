# Non-relational source discovery — coverage survey

*What can Procela's Discover loop actually introspect today? This surveys the
connector layer's coverage of **semi-structured** and **unstructured** sources,
and of the cloud categories (object storage, NoSQL, warehouses). It reflects the
state after Track E of the [roadmap](./ROADMAP.md) (E1–E4); the "Track E
changelog" at the end records what changed from the original relational-only
picture.*

Discovery is dispatched in `packages/backend/src/services/connector.service.ts`
(`discoverAssets`): a profile resolves to a **real** driver where one exists,
otherwise it returns clearly-labelled sample assets flagged `simulated: true`
so the UI never mistakes a mock for a live scan.

---

## Short answer

- **Relational databases** — real discovery (Postgres · MySQL · SQL Server ·
  Oracle · **Redshift**).
- **Semi-structured** — **yes**, for the formats the file connector parses
  (CSV/TSV/JSON/JSONL/NDJSON, **Parquet**, **Avro**) via a local upload, and for
  **MongoDB** documents. Nested shapes flatten into dotted paths.
- **Unstructured** — **no**. Nothing reads free-form text, PDFs, documents, or
  images.
- **Cloud object storage / SDK warehouses / API / spreadsheets** — still
  **probe-and-mock** (`simulated: true`); they need per-service SDKs and a live
  account, so they're not yet real discovery.

---

## Coverage matrix

| Source | Discovery | Real? | Notes |
|---|---|---|---|
| PostgreSQL / MySQL / SQL Server / Oracle | Catalog SQL (`information_schema` / Oracle `all_*`) | ✅ real | tables/views, columns, data types, approx. row counts |
| **Redshift** (warehouse) | Postgres-wire via `pg`; `information_schema` + `svv_table_info` | ✅ real | **E3** — no new dependency; reuses the Postgres dialect |
| **MongoDB** | List collections, `$sample` docs, infer field/type schema | ✅ real | **E2** — polymorphic fields as `int\|string`; `estimatedDocumentCount` |
| Local file — CSV / TSV / JSON / JSONL / NDJSON | Parse header / union keys | ✅ real | dotted paths for nested JSON (**E4**) |
| Local file — **Parquet** | Footer metadata (`@dsnp/parquetjs`) | ✅ real | **E1** — leaf columns as dotted paths, footer row count |
| Local file — **Avro** | OCF header schema (`avsc`) | ✅ real | **E1** — nested records → dotted paths; nullable unions unwrap |
| dbt manifest | `manifest.json` (models/sources/seeds) | ✅ real | registers warehouse *relations* from a file — no live DB |
| Cloud object storage — S3 / Azure Blob / GCS / SFTP | Reachability probe + mock assets | ❌ simulated | remote *listing* is the open half of **E1** (needs object-store SDKs) |
| Warehouses — Snowflake / BigQuery / Databricks | Reachability probe + mock assets | ❌ simulated | open half of **E3** (each needs its own SDK + live account) |
| API / Spreadsheet (SharePoint, Google Sheets) | Reachability probe + mock assets | ❌ simulated | out of Track E scope |

Real paths set `simulated: false` and flow through the shared `discoverAssets`
→ reconciliation path; mock paths set `simulated: true`.

---

## What's real, by layer

- **Relational + Redshift** — `lib/db-source/introspect.ts` builds the catalog
  SQL and `discoverDbSchema` runs it through the shared driver layer
  (`lib/db-source/index.ts`). Redshift routes to the `pg` driver and the
  Postgres dialect, with a Redshift-specific row count (`svv_table_info`).
- **MongoDB** — `lib/db-source/mongo-introspect.ts`: `discoverMongoSchema`
  connects (lazy `mongodb` driver), lists collections, samples documents, and
  `inferMongoAssets` unions field paths + collapses per-field types. Pure
  inference is unit-tested without a live database.
- **Files** — `lib/local-file-connector.ts`: `analyzeLocalFileAsync` handles
  every format in `SUPPORTED_EXTENSIONS`. Text formats parse synchronously;
  Parquet/Avro read their self-describing schema from the file's own metadata.
- **Nested flattening** — `lib/flatten-paths.ts` (shared): a JSON row or Mongo
  document flattens into dotted leaf paths (`address.city`). Arrays, `Date`, and
  BSON wrappers are leaves; descending into array elements is deliberately out of
  scope (it would break the one-value-per-row data-quality contract).

## Data quality (measured vs simulated)

Measured DQ mirrors discovery: real for direct-connect databases (SQL pushdown)
and for the text file formats the reader can scan synchronously
(`isDqExecutableFile`). **Parquet/Avro DQ stays simulated** — their schema is
discovered, but their values aren't read synchronously yet. Cloud
object-storage / SDK-warehouse / API / spreadsheet DQ is simulated, matching
their discovery status.

## Remaining gaps

1. **Cloud object-listing** (open half of E1) — list a bucket/prefix on
   S3 / Azure Blob / GCS / SFTP, fetch each object, run the now-complete
   Parquet/Avro/CSV/JSON inference over it. Needs the object-store SDKs
   (`@aws-sdk/client-s3`, `@azure/storage-blob`, `@google-cloud/storage`).
2. **SDK warehouses** (open half of E3) — Snowflake / BigQuery / Databricks,
   each with its own driver and connection/auth model.
3. **Unstructured content** — no parser for text/PDF/document/image bodies; not
   on the roadmap.
4. **Parquet/Avro measured DQ** — read column values (not just schema) so rules
   execute for real instead of simulating.

Items 1–2 can't be validated in CI without live cloud accounts, which is why
they remain deliberately deferred.

---

## Track E changelog

What changed from the original relational-only survey:

- **E2 — MongoDB discovery.** Was modelled-but-rejected (mock); now real
  collection + field/type discovery.
- **E4 — Deep semi-structured parsing.** JSON/Mongo previously kept only
  top-level keys and stringified nested objects; now nested structures flatten
  into dotted leaf paths via the shared `flatten-paths` module.
- **E3 — Redshift warehouse discovery.** Was a mock warehouse category; now real
  discovery through the `pg` driver (Snowflake/BigQuery/Databricks still mock).
- **E1 — Parquet/Avro schema inference.** Uploading a `.parquet` / `.avro`
  previously threw "unsupported file type"; now both are parsed for their real
  schema (cloud object-listing remains the open half).
