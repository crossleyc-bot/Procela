# Capability Matrix

Live tracking of Procela's feature coverage against the four primary
benchmarks: **Collibra**, **Alation**, **Atlan**, and **Ataccama**.

The source of truth is [`capability-matrix.csv`](./capability-matrix.csv) —
open it in Excel or Google Sheets (File → Import → Upload) for the
filterable, sortable view.

## Status legend

| Status | Meaning |
|---|---|
| **Built** | Implemented and verified end-to-end in this codebase. |
| **Partial** | Working for one path; another path still missing. |
| **Stubbed** | UI / data model in place, but the underlying execution is simulated. |
| **Designed** | Schema or architectural decision made, implementation pending. |
| **Not Started** | No code yet. |

## Priority legend

| Priority | Meaning |
|---|---|
| **P0** | Required to ship a credible MVP / production v1. |
| **P1** | Important — table stakes against incumbents in target markets. |
| **P2** | Differentiator or nice-to-have; can ship without. |
| **P3** | Deferred — long-term parity, not pursuing now. |

## How to use

1. **Update the CSV** when a feature changes status. Commit the
   change so the diff explains what moved.
2. **Filter by Priority** to see the next batch of work — sort by
   `Priority` ascending, then by `Procela_Status` to surface P0/P1
   items still in `Not Started` / `Stubbed`.
3. **Filter by Category** when scoping a sprint to a particular
   area (e.g. lineage extraction, real connectors).
4. **The `Gap_To_Close` column** is the concrete next-step note
   per row — handy when triaging into a backlog.

## Quick summary (snapshot)

_Derived from `capability-matrix.csv` — regenerate these counts whenever a
row's status changes so the snapshot doesn't drift from the source of truth._

| Category | Built | Partial / Stubbed / Designed | Not Started |
|---|---|---|---|
| Catalog | 6 | 0 | 0 |
| Data assets | 12 | 0 | 0 |
| Glossary | 3 | 0 | 0 |
| Systems | 4 | 0 | 0 |
| Connections | 5 | 0 | 0 |
| Lineage | 1 | 2 | 1 |
| Data quality | 3 | 1 | 0 |
| Governance | 9 | 1 | 0 |
| Domains | 2 | 0 | 0 |
| Discovery | 2 | 0 | 1 |
| AI | 4 | 0 | 1 |
| Auth | 3 | 0 | 1 |
| Audit | 1 | 1 | 0 |
| Infrastructure | 2 | 3 | 1 |
| UX | 4 | 0 | 0 |
| Misc | 0 | 0 | 3 |

Where it actually matters: of the **P0** items, the open ones are the
SQL/query-log half of auto-extracted lineage (the dbt half ships) and
live SaaS hosting. (SSO — OIDC + SAML 2.0 with SCIM and JIT
provisioning — is implemented and config-gated; direct-connect
discovery is real across relational engines, cloud warehouses
[Snowflake/BigQuery/Databricks/Redshift], MongoDB, and cloud object
stores [S3/Azure Blob/GCS/SFTP], with the on-prem edge agent covering
firewalled sources — only API/spreadsheet sources remain simulated;
the Postgres backing is complete — set `DATABASE_URL` and the whole
backend runs on it.) Everything else is shipable wins or strategic
defers.
