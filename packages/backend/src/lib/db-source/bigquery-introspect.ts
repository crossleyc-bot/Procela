// BigQuery warehouse discovery. BigQuery exposes INFORMATION_SCHEMA, but
// per-dataset and reached with a project + dataset (not host:port), so — like
// Snowflake and MongoDB — it gets its own module. The dataset is part of the
// table path (`project.dataset.INFORMATION_SCHEMA.TABLES`) and can't be a query
// parameter, so the project and dataset identifiers are validated against a
// strict charset (the injection boundary) and back-tick quoted. The flat rows
// group through the shared engine-agnostic groupAssets / applyRowCounts.
//
// The SQL builders are PURE so they unit-test without @google-cloud/bigquery;
// only discoverBigQuerySchema opens a real client.

import {
  groupAssets,
  applyRowCounts,
  MAX_DISCOVERED_TABLES,
  MAX_DISCOVERED_COLUMNS,
  type DiscoveredAsset,
} from './introspect';
import { normalizeRow } from './sql';
import type { SourceRow } from './types';

export interface BigQuerySourceRequest {
  projectId: string;
  dataset: string;
  /** Inline service-account JSON key. Absent → Application Default Credentials. */
  serviceAccountJson?: string;
}

// A BigQuery project id allows letters, digits, hyphens and (domain-scoped) a
// dot/colon; a dataset id allows letters, digits and underscores. Anything else
// is rejected before it can reach a back-ticked table path.
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DATASET_RE = /^[A-Za-z0-9_]{1,1024}$/;

export function assertBqProject(id: string): string {
  if (!PROJECT_RE.test(id)) throw new Error(`Invalid BigQuery project id: ${JSON.stringify(id)}`);
  return id;
}
export function assertBqDataset(id: string): string {
  if (!DATASET_RE.test(id)) throw new Error(`Invalid BigQuery dataset id: ${JSON.stringify(id)}`);
  return id;
}

/** The back-ticked `project`.`dataset`.INFORMATION_SCHEMA.<view> prefix. */
function schemaView(project: string, dataset: string, view: string): string {
  return `\`${assertBqProject(project)}\`.\`${assertBqDataset(dataset)}\`.INFORMATION_SCHEMA.${view}`;
}

export function buildBigQueryTableListSql(project: string, dataset: string): string {
  return `SELECT table_name, table_type FROM ${schemaView(project, dataset, 'TABLES')} `
    + `ORDER BY table_name LIMIT ${MAX_DISCOVERED_TABLES}`;
}

export function buildBigQueryColumnListSql(project: string, dataset: string): string {
  return `SELECT table_name, column_name, data_type, ordinal_position FROM ${schemaView(project, dataset, 'COLUMNS')} `
    + `ORDER BY table_name, ordinal_position LIMIT ${MAX_DISCOVERED_COLUMNS}`;
}

export function buildBigQueryRowCountSql(project: string, dataset: string): string {
  // TABLE_STORAGE carries a maintained total_rows per table — approximate, cheap.
  return `SELECT table_name, total_rows AS row_count FROM ${schemaView(project, dataset, 'TABLE_STORAGE')}`;
}

/**
 * Run real discovery against a BigQuery dataset. Throws on auth / query failure
 * (fail-loud). The @google-cloud/bigquery client is imported lazily.
 */
export async function discoverBigQuerySchema(req: BigQuerySourceRequest): Promise<DiscoveredAsset[]> {
  if (!req.projectId) throw new Error('BigQuery source is missing a project id');
  if (!req.dataset) throw new Error('BigQuery source is missing a dataset');
  assertBqProject(req.projectId);
  assertBqDataset(req.dataset);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ns: any = await import('@google-cloud/bigquery');
  const BigQuery = ns.BigQuery ?? ns.default?.BigQuery ?? ns.default;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const opts: any = { projectId: req.projectId };
  if (req.serviceAccountJson) {
    let creds: { project_id?: string };
    try { creds = JSON.parse(req.serviceAccountJson); }
    catch { throw new Error('BigQuery service-account key is not valid JSON'); }
    opts.credentials = creds;
  }
  const bq = new BigQuery(opts);

  const run = async (query: string): Promise<SourceRow[]> => {
    const [rows] = await bq.query({ query });
    return (rows as Array<Record<string, unknown>>).map((r) => normalizeRow(r));
  };

  const tableRows = await run(buildBigQueryTableListSql(req.projectId, req.dataset));
  const columnRows = await run(buildBigQueryColumnListSql(req.projectId, req.dataset));
  const assets = groupAssets(tableRows, columnRows);
  try {
    const rowCountRows = await run(buildBigQueryRowCountSql(req.projectId, req.dataset));
    applyRowCounts(assets, rowCountRows);
  } catch { /* TABLE_STORAGE may be permission-gated — leave rowCount undefined */ }
  return assets;
}
