import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { loadStore, saveStore, registerStore } from '../lib/persistence';
import { hasDatabase } from '../db/prisma';
import { isOwnershipLevel, getCachedOrgList } from '../lib/org-scope';
import { scopeListForRequest, assertOrgAccess } from '../lib/tenant-scope';
import { REGULATORY_SENSITIVITY_TAGS } from '../services/ai.service';
import { auditService } from '../services/audit.service';
import { aiService, SENSITIVITY_TAGS, SensitivityTag } from '../services/ai.service';
import logger from '../lib/logger';
import { getDataAssetsRepository } from '../db/data-assets.repo';
import { getDataAssetBindingsRepository } from '../db/data-asset-bindings.repo';
import { getDataAssetColumnsRepository } from '../db/data-asset-columns.repo';
import { getDataQualityRulesRepository } from '../db/data-quality-rules.repo';
import { systems } from './systems';
import { dataDomains } from './data-domains';
import { mappings } from './mappings';
import { people } from './people';
import { processNodes } from './process-catalog';
import { getSystemsRepository } from '../db/systems.repo';
import { getMappingsRepository } from '../db/mappings.repo';
import { getDataDomainsRepository } from '../db/data-domains.repo';
import { getPeopleRepository } from '../db/people.repo';
import { getProcessNodesRepository } from '../db/process-nodes.repo';
import { countMeasuredRulesByAsset, effectiveHealthScore } from '../lib/asset-health';
import { computeRescanHealth } from '../lib/schema-drift';
// Type-only import — the runtime function is require()'d lazily at the call
// site because governance-issues.ts imports `dataAssets` from this module,
// so a static value import would close an initialization cycle.
import type { SchemaDriftEvent } from './governance-issues';
import { requireAiEnabled } from '../middleware/ai-enabled';
import { enforceAiBudget } from '../middleware/ai-budget';

export interface StoredDataAsset {
  id: string;
  orgId: string;
  name: string;
  description: string;
  systemId: string;
  /** @deprecated Use `ownerPersonId` (person FK). Kept for legacy display
   *  when no person link is set. Migrations attempt to resolve this to a
   *  person id where possible. */
  owner: string;
  /** Person id of the accountable owner. Aligns with how Domains and
   *  Glossary store ownership and lets the UI render a real name link. */
  ownerPersonId?: string | null;
  stewardIds: string[];
  governanceTier: 'BRONZE' | 'SILVER' | 'GOLD';
  /** True when this asset is the authoritative system-of-record — the golden
   *  copy other systems reconcile to. When several systems hold the same data,
   *  exactly one copy should carry this. Default false = a copy / replica or
   *  simply undeclared. Drives the "copies with no declared SOR" gap. */
  isSystemOfRecord?: boolean;
  /** Manual snapshot. When DQ rules are configured the engine derives a
   *  live score per column and rolls up to the asset; treat this field as
   *  the last manual override and use `healthScoreAt` for its provenance. */
  healthScore: number;
  /** Timestamp of the last manual healthScore set. */
  healthScoreAt?: string | null;
  /** @deprecated Use `bindings` (DataAssetBinding) — these flat fields
   *  are kept only for legacy reads and migration into bindings. */
  sourceConnectionId?: string;
  /** @deprecated see `bindings` */
  sourceAsset?: string;
  /** @deprecated see `bindings` */
  sourceColumn?: string;
  /** Sensitivity classifications. The single sensitivity axis for a data
   *  asset: the tags express data-sensitivity categories (PII/PHI/PCI/
   *  FINANCIAL/CREDENTIAL), the broad confidentiality level (CONFIDENTIAL /
   *  PUBLIC), and regulatory / export-control regimes (CUI / ITAR /
   *  EXPORT_CONTROLLED). Populated by the AI classifier route
   *  (POST /suggest-sensitivity → user accept → PUT /sensitivity), and
   *  validated server-side against the canonical SENSITIVITY_TAGS set.
   *  Empty / undefined = untagged. */
  sensitivityTags?: SensitivityTag[];
  /** Content classification of the data, not how it's used.
   *  Replaces the legacy mixed-axis `category`. */
  dataType?: 'MASTER' | 'REFERENCE' | 'TRANSACTIONAL' | 'ANALYTICAL' | 'METADATA';
  /** @deprecated Use `dataType`. Migrated on load. Kept for backwards-
   *  compatible reads from older callers / exports. */
  category?: 'OPERATIONAL' | 'GOVERNANCE' | 'REFERENCE' | 'ANALYTICAL' | 'MASTER';
  /** @deprecated Use `retentionDuration` + `retentionReason` for queryable
   *  retention policy. Free-text `retentionPolicy` kept for legacy reads. */
  retentionPolicy?: string;
  retentionDuration?: { value: number; unit: 'DAYS' | 'MONTHS' | 'YEARS' };
  retentionReason?: string;
  refreshFrequency?:
    | 'REAL_TIME'
    | 'HOURLY'
    | 'DAILY'
    | 'WEEKLY'
    | 'MONTHLY'
    | 'MANUAL'
    | 'EVENT_DRIVEN'
    | 'STREAMING'
    | 'AD_HOC';
  /** Provenance — how the asset entered the catalog. Immutable after
   *  creation. Used by the Data Assets page to filter governance
   *  placeholders out of source-data views, and by gap detection so a
   *  GOVERNANCE_TEMPLATE asset isn't penalised for lacking a binding. */
  origin?: 'MANUAL' | 'GOVERNANCE_TEMPLATE' | 'DISCOVERED' | 'IMPORTED' | 'SYNCED';
  /** Set by the on-prem connector when it last refreshed this asset's
   *  freshness signal. Drives the "Synced N min ago" chip on the Data
   *  Asset rows so users can tell a value reflects reality, not stale
   *  manual entry. */
  lastSyncedByConnectorId?: string | null;
  lastSyncedAt?: string | null;
  /** Latest row count reported by an on-prem connector scan. Approximate
   *  (engine statistics, not a live COUNT(*)); refreshed each scan and
   *  timestamped by `lastSyncedAt`. Undefined until a connector reports
   *  one — manually-created assets have no row count. */
  rowCount?: number | null;
  /** Fingerprint of the column set from the last connector scan, used to
   *  detect schema drift on the next scan. Undefined until a scan reports
   *  columns. */
  schemaFingerprint?: string | null;
  createdAt: string;
  updatedAt: string;
}

export const dataAssets: StoredDataAsset[] = loadStore<StoredDataAsset>('dataAssets');
registerStore('dataAssets', dataAssets);
const DEV_ORG_ID = '00000000-0000-0000-0000-000000000010';
const VALID_ORIGINS = ['MANUAL', 'GOVERNANCE_TEMPLATE', 'DISCOVERED', 'IMPORTED', 'SYNCED'] as const;

// Migrate legacy `category` → `dataType`. The old enum mixed three axes
// (use-case, content-type, stewardship); the new one is content-type only.
// Module-scoped — also consumed by the create/update handlers below.
const CATEGORY_TO_DATA_TYPE: Record<string, StoredDataAsset['dataType']> = {
  OPERATIONAL: 'TRANSACTIONAL',
  GOVERNANCE:  'METADATA',
  MASTER:      'MASTER',
  REFERENCE:   'REFERENCE',
  ANALYTICAL:  'ANALYTICAL',
};

// JSON mode only — one-time boot migrations that rewrite legacy rows in
// the in-memory array. Postgres rows carry the canonical shape, and reading
// the boot array in PG mode would just be a stale-store read.
if (!hasDatabase()) {
// Migrate legacy `steward` string → `stewardIds[]`
let migrated = false;
for (const a of dataAssets) {
  if (!a.stewardIds) {
    const legacy = (a as any).steward;
    a.stewardIds = legacy ? [legacy] : [];
    delete (a as any).steward;
    migrated = true;
  }
}

for (const a of dataAssets) {
  if (!a.dataType && a.category && CATEGORY_TO_DATA_TYPE[a.category]) {
    a.dataType = CATEGORY_TO_DATA_TYPE[a.category];
    migrated = true;
  }
}

// Backfill `healthScoreAt` from updatedAt where a manual score exists but
// no provenance timestamp is recorded. Cheap and lossless.
for (const a of dataAssets) {
  if (a.healthScore && a.healthScoreAt === undefined) {
    a.healthScoreAt = a.updatedAt;
    migrated = true;
  }
}

// Backfill `origin` for legacy rows. The legacy `category === 'GOVERNANCE'`
// is the only structural marker we have for governance-template seeds;
// rows with a sourceConnectionId or sourceAsset clearly came from a
// connection scan, so call those DISCOVERED. Everything else is treated
// as MANUAL — the safer default since we'd rather underclaim provenance
// than mislabel a real user-typed asset.
for (const a of dataAssets) {
  if (a.origin) continue;
  if ((a as any).category === 'GOVERNANCE') a.origin = 'GOVERNANCE_TEMPLATE';
  else if (a.sourceConnectionId || a.sourceAsset) a.origin = 'DISCOVERED';
  else a.origin = 'MANUAL';
  migrated = true;
}

if (migrated) saveStore('dataAssets', dataAssets);
}

// Resolve free-text `owner` to a person id where the names match. Deferred
// to next tick because people.ts and data-assets.ts import each other —
// running this synchronously can hit the people export while it is still
// in the TDZ. Leaves the legacy string in place when no match is found
// so the UI can still display it.
function backfillOwnerPersonIds(): void {
  if (hasDatabase()) return; // JSON-legacy backfill; PG rows carry ownerPersonId
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { people } = require('./people') as { people: { id: string; name: string }[] };
  let touched = false;
  for (const a of dataAssets) {
    if (a.ownerPersonId !== undefined) continue;
    if (!a.owner) { a.ownerPersonId = null; touched = true; continue; }
    // The legacy `owner` field has been used inconsistently — sometimes it
    // holds a person id (the UI dropdown wrote the id into it) and other
    // times a free-text name. Try id match first, then name match.
    const byId = people.find((p) => p.id === a.owner);
    if (byId) { a.ownerPersonId = byId.id; touched = true; continue; }
    const byName = people.find((p) => p.name.trim().toLowerCase() === a.owner.trim().toLowerCase());
    a.ownerPersonId = byName ? byName.id : null;
    touched = true;
  }
  if (touched) saveStore('dataAssets', dataAssets);
}
setImmediate(backfillOwnerPersonIds);

const VALID_TIERS = ['BRONZE', 'SILVER', 'GOLD'] as const;
const VALID_DATA_TYPES = ['MASTER', 'REFERENCE', 'TRANSACTIONAL', 'ANALYTICAL', 'METADATA'] as const;
const VALID_REFRESH_FREQUENCIES = [
  'REAL_TIME', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'MANUAL',
  'EVENT_DRIVEN', 'STREAMING', 'AD_HOC',
] as const;
const VALID_RETENTION_UNITS = ['DAYS', 'MONTHS', 'YEARS'] as const;

// Request-body schemas — Zod at the API boundary. Silent-fallback fields
// (governanceTier, dataType, refreshFrequency,
// retentionDuration) use `.catch(undefined)` so invalid values are
// dropped rather than 400'd, matching the existing runtime fallback
// semantics. `origin` on create rejects invalid values (mirrors the
// existing pre-migration behaviour).
const createDataAssetBodySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
  systemId: z.string().nullable().optional(),
  owner: z.string().optional(),
  ownerPersonId: z.string().nullable().optional(),
  stewardIds: z.array(z.string()).optional(),
  governanceTier: z.enum(VALID_TIERS).optional().catch(undefined),
  healthScore: z.number().optional(),
  isSystemOfRecord: z.boolean().optional(),
  orgId: z.string().optional(),
  sourceConnectionId: z.string().optional(),
  sourceAsset: z.string().optional(),
  sourceColumn: z.string().optional(),
  dataType: z.enum(VALID_DATA_TYPES).optional().catch(undefined),
  category: z.enum(['OPERATIONAL', 'GOVERNANCE', 'REFERENCE', 'ANALYTICAL', 'MASTER']).optional().catch(undefined),
  retentionPolicy: z.string().optional(),
  retentionDuration: z.object({
    value: z.number().positive(),
    unit: z.enum(VALID_RETENTION_UNITS),
  }).optional().catch(undefined),
  retentionReason: z.string().optional(),
  refreshFrequency: z.enum(VALID_REFRESH_FREQUENCIES).optional().catch(undefined),
  origin: z.enum(VALID_ORIGINS).optional(),
});
const updateDataAssetBodySchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  systemId: z.string().nullable().optional(),
  owner: z.string().optional(),
  ownerPersonId: z.string().nullable().optional(),
  stewardIds: z.array(z.string()).optional(),
  governanceTier: z.enum(VALID_TIERS).optional().catch(undefined),
  healthScore: z.number().optional(),
  isSystemOfRecord: z.boolean().optional(),
  sourceConnectionId: z.string().optional(),
  sourceAsset: z.string().optional(),
  sourceColumn: z.string().optional(),
  dataType: z.enum(VALID_DATA_TYPES).optional().catch(undefined),
  category: z.enum(['OPERATIONAL', 'GOVERNANCE', 'REFERENCE', 'ANALYTICAL', 'MASTER']).optional().catch(undefined),
  retentionPolicy: z.string().optional(),
  retentionDuration: z.object({
    value: z.number().positive(),
    unit: z.enum(VALID_RETENTION_UNITS),
  }).optional().catch(undefined),
  retentionReason: z.string().optional(),
  refreshFrequency: z.enum(VALID_REFRESH_FREQUENCIES).optional().catch(undefined),
});
const createBindingBodySchema = z.object({
  connectionId: z.string({
    required_error: 'connectionId is required',
    invalid_type_error: 'connectionId is required',
  }).min(1, 'connectionId is required'),
  sourceAsset: z.string({
    required_error: 'sourceAsset is required (the table / file / endpoint name)',
    invalid_type_error: 'sourceAsset is required (the table / file / endpoint name)',
  }).min(1, 'sourceAsset is required (the table / file / endpoint name)'),
  sourceColumn: z.string().optional(),
  sourceColumns: z.array(z.string()).optional(),
  label: z.string().optional(),
  isPrimary: z.boolean().optional(),
});
const updateBindingBodySchema = z.object({
  sourceAsset: z.string().optional(),
  sourceColumn: z.string().optional(),
  sourceColumns: z.array(z.string()).optional(),
  label: z.string().optional(),
  isPrimary: z.boolean().optional(),
});
const createColumnBodySchema = z.object({
  columnName: z.string().min(1, 'columnName is required'),
  dataType: z.string().optional(),
  description: z.string().optional(),
  sourceConnectionId: z.string().optional(),
  sourceAsset: z.string().optional(),
  sourceColumn: z.string().optional(),
  isPrimaryKey: z.boolean().optional(),
  references: z.string().optional(),
});
const updateColumnBodySchema = z.object({
  columnName: z.string().optional(),
  dataType: z.string().optional(),
  description: z.string().optional(),
  isPrimaryKey: z.boolean().optional(),
  references: z.string().optional(),
});
const putSensitivityBodySchema = z.object({
  tags: z.array(z.string()),
});

// ── Data Asset Bindings ──────────────────────────────────────────────────
//
// A binding connects a Data Asset (stable business identity) to a specific
// physical location: a Connection + a table/file + (optionally) a column.
// The asset stays the same when you unlink one location and point to
// another — that's the whole reason bindings are separate rows.
//
// The model allows multiple bindings per asset (dev/staging/prod, primary/
// failover) but the current UI operates on one-at-a-time. `isPrimary`
// marks the binding that DQ rules, lineage, etc. default to; exactly one
// binding per asset should have it set when any bindings exist.

export interface StoredDataAssetBinding {
  id: string;
  orgId: string;
  dataAssetId: string;
  connectionId: string;
  sourceAsset: string;      // table / file / endpoint / sheet name
  sourceColumn?: string;    // legacy single column; null = whole asset. Kept
                            // for back-compat; the first of sourceColumns is
                            // mirrored here so single-column consumers still work.
  sourceColumns?: string[]; // the named column set this asset binds to; empty
                            // or absent = the whole source asset (all columns)
  label?: string;           // free-form, e.g. "prod"
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
}

export const dataAssetBindings: StoredDataAssetBinding[] =
  loadStore<StoredDataAssetBinding>('dataAssetBindings');
registerStore('dataAssetBindings', dataAssetBindings);

/**
 * Normalize the column set for a binding. Accepts the new multi-column array
 * and/or a legacy single column, trims, drops blanks, and de-duplicates while
 * preserving order. An empty result means "the whole source asset".
 */
function normalizeColumnSet(columns?: string[], legacySingle?: string): string[] {
  const raw = columns !== undefined ? columns : (legacySingle ? [legacySingle] : []);
  const out: string[] = [];
  for (const c of raw) {
    const v = (c || '').trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * One-time migration: any existing Data Asset that still carries the legacy
 * `sourceConnectionId` triplet gets a synthetic primary binding. The legacy
 * fields stay on the asset (deprecated shadow state) so consumers that
 * haven't been updated still work; new code should go through bindings.
 */
function migrateLegacySourceFieldsToBindings(): void {
  if (hasDatabase()) return; // JSON-legacy binding backfill; PG uses real binding rows
  let migrated = 0;
  const now = new Date().toISOString();
  for (const asset of dataAssets) {
    if (!asset.sourceConnectionId || !asset.sourceAsset) continue;
    const existing = dataAssetBindings.find(
      (b) => b.dataAssetId === asset.id && b.connectionId === asset.sourceConnectionId,
    );
    if (existing) continue;
    dataAssetBindings.push({
      id: uuid(),
      orgId: asset.orgId,
      dataAssetId: asset.id,
      connectionId: asset.sourceConnectionId,
      sourceAsset: asset.sourceAsset,
      sourceColumn: asset.sourceColumn,
      isPrimary: true,
      createdAt: now,
      updatedAt: now,
    });
    migrated++;
  }
  if (migrated > 0) {
    saveStore('dataAssetBindings', dataAssetBindings);
    logger.info({ migrated }, 'Migrated legacy source fields to DataAssetBindings');
  }
}
migrateLegacySourceFieldsToBindings();

/**
 * Ensure a DataAssetBinding exists that matches the asset's current
 * sourceConnectionId/sourceAsset/sourceColumn fields. Used when create/update
 * routes accept the legacy single-source form so the bindings store (which
 * drives the UI's "Source" column and Link button) stays in sync.
 *
 * If the asset has no source fields, this is a no-op. If a binding for the
 * same (asset, connection) already exists, its sourceAsset/sourceColumn are
 * refreshed; otherwise a new primary binding is appended.
 */
async function syncBindingFromAssetFields(asset: StoredDataAsset): Promise<void> {
  if (!asset.sourceConnectionId || !asset.sourceAsset) return;
  const now = new Date().toISOString();
  const allBindings = await dataAssetBindingsRepo.list();
  const existing = allBindings.find(
    (b) => b.dataAssetId === asset.id && b.connectionId === asset.sourceConnectionId,
  );
  if (existing) {
    const changed =
      existing.sourceAsset !== asset.sourceAsset ||
      existing.sourceColumn !== asset.sourceColumn;
    if (!changed) return;
    existing.sourceAsset = asset.sourceAsset;
    existing.sourceColumn = asset.sourceColumn;
    existing.updatedAt = now;
    await dataAssetBindingsRepo.update(existing.id, existing);
    return;
  }
  const isFirstBinding = !allBindings.some((b) => b.dataAssetId === asset.id);
  await dataAssetBindingsRepo.create({
    id: uuid(),
    orgId: asset.orgId,
    dataAssetId: asset.id,
    connectionId: asset.sourceConnectionId,
    sourceAsset: asset.sourceAsset,
    sourceColumn: asset.sourceColumn,
    isPrimary: isFirstBinding,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Project a binding's named column set into the asset's governed columns.
 *
 * A DataAssetBinding.sourceColumns entry names a physical column the asset is
 * scoped to, but all governance — DQ rules, per-column health, gap detection —
 * hangs off DataAssetColumn rows keyed by columnId. So binding a set must
 * materialize those rows or the set stays inert (a label, not something you can
 * put a rule on). Idempotent: skips columns that already exist (case-insensitive
 * by name), so re-linking or editing the set never duplicates. A binding with no
 * column set (whole table/file) materializes nothing here — the full column list
 * comes from auto-discover instead.
 *
 * Returns the columns it created (for messaging / audit context).
 */
async function materializeColumnsFromBinding(
  asset: StoredDataAsset,
  binding: StoredDataAssetBinding,
): Promise<StoredDataAssetColumn[]> {
  const cols = binding.sourceColumns || [];
  if (cols.length === 0) return [];
  const existing = (await dataAssetColumnsRepo.list()).filter((c) => c.dataAssetId === asset.id);
  const seen = new Set(existing.map((c) => c.columnName.toLowerCase()));
  const now = new Date().toISOString();
  const created: StoredDataAssetColumn[] = [];
  for (const colName of cols) {
    if (seen.has(colName.toLowerCase())) continue;
    seen.add(colName.toLowerCase());
    const col: StoredDataAssetColumn = {
      id: uuid(),
      dataAssetId: asset.id,
      columnName: colName,
      dataType: '',
      description: '',
      sourceConnectionId: binding.connectionId,
      sourceAsset: binding.sourceAsset,
      sourceColumn: colName,
      createdAt: now,
      updatedAt: now,
    };
    await dataAssetColumnsRepo.create(col);
    created.push(col);
  }
  return created;
}

// ── Data Asset Columns ──────────────────────────────────────────────────
//
// Columns are the measurable data points within a Data Asset. A Data Asset
// represents the business concept ("Customer Accounts"); columns represent
// the individual fields ("email", "phone", "created_at"). DQ rules target
// columns specifically, and asset health rolls up from column-level scores.
//
// Columns can be auto-populated from a connection's discovery output (the
// Link flow offers this), or manually added.

export interface StoredDataAssetColumn {
  id: string;
  dataAssetId: string;
  columnName: string;
  dataType?: string;
  description?: string;
  sourceConnectionId?: string;
  sourceAsset?: string;
  sourceColumn?: string;
  /** True when this column is (part of) the asset's primary key — the field(s)
   *  that uniquely identify a row. Primary keys are what duplicate detection
   *  and cross-asset joins key on. */
  isPrimaryKey?: boolean;
  /** Free-text foreign-key / relationship reference to another entity's key,
   *  e.g. "Customer Master.customer_id". Captures the "Key Relationships" a
   *  canonical model records; feeds lineage between assets. */
  references?: string;
  createdAt: string;
  updatedAt: string;
}

const STANDARD_DATA_TYPES = [
  'String', 'Integer', 'Decimal', 'Boolean', 'Date', 'DateTime',
  'Timestamp', 'Binary', 'JSON', 'Array', 'UUID', 'Email', 'Phone',
  'URL', 'Currency', 'Percentage', 'Text', 'Other',
];

const DATA_TYPE_ALIASES: Record<string, string> = {
  varchar: 'String', char: 'String', text: 'Text', string: 'String', nvarchar: 'String',
  int: 'Integer', integer: 'Integer', bigint: 'Integer', smallint: 'Integer', tinyint: 'Integer', number: 'Integer',
  float: 'Decimal', double: 'Decimal', decimal: 'Decimal', numeric: 'Decimal', real: 'Decimal',
  bool: 'Boolean', boolean: 'Boolean', bit: 'Boolean',
  date: 'Date', datetime: 'DateTime', timestamp: 'Timestamp', datetime2: 'DateTime',
  blob: 'Binary', binary: 'Binary', varbinary: 'Binary', bytea: 'Binary',
  json: 'JSON', jsonb: 'JSON',
  uuid: 'UUID', uniqueidentifier: 'UUID',
  array: 'Array',
};

function normalizeDataType(raw: string): string {
  if (!raw) return '';
  const lower = raw.toLowerCase().replace(/\(.*\)/, '').trim();
  return DATA_TYPE_ALIASES[lower] || raw;
}

export const dataAssetColumns: StoredDataAssetColumn[] =
  loadStore<StoredDataAssetColumn>('dataAssetColumns');
registerStore('dataAssetColumns', dataAssetColumns);

const dataAssetsRepo = getDataAssetsRepository(dataAssets);
const dataAssetBindingsRepo = getDataAssetBindingsRepository(dataAssetBindings);
const dataAssetColumnsRepo = getDataAssetColumnsRepository(dataAssetColumns);

// Foreign-store repos, lazily bound — these stores are value-imported from
// sibling routes (some via an import cycle), so binding the repo eagerly
// would read the array in the circular-import TDZ at boot. Each accessor
// defers construction to first call (request time), after the cycle settles.
let _systemsRepo: ReturnType<typeof getSystemsRepository> | null = null;
const systemsRepo = () => (_systemsRepo ??= getSystemsRepository(systems));
let _mappingsRepo: ReturnType<typeof getMappingsRepository> | null = null;
const mappingsRepo = () => (_mappingsRepo ??= getMappingsRepository(mappings));
let _dataDomainsRepo: ReturnType<typeof getDataDomainsRepository> | null = null;
const dataDomainsRepo = () => (_dataDomainsRepo ??= getDataDomainsRepository(dataDomains));
let _peopleRepo: ReturnType<typeof getPeopleRepository> | null = null;
const peopleRepo = () => (_peopleRepo ??= getPeopleRepository(people));
let _processNodesRepo: ReturnType<typeof getProcessNodesRepository> | null = null;
const processNodesRepo = () => (_processNodesRepo ??= getProcessNodesRepository(processNodes));

/**
 * Resolve the primary binding for an asset, or undefined if it isn't linked
 * to a physical location yet. Exported so other modules (DQ engine,
 * lineage, dashboards) can consume it without reaching into the array.
 */
export async function getPrimaryBinding(assetId: string): Promise<StoredDataAssetBinding | undefined> {
  const own = (await dataAssetBindingsRepo.list()).filter((b) => b.dataAssetId === assetId);
  return own.find((b) => b.isPrimary) || own[0];
}

/**
 * Remove every binding that points at a given connection. Called by the
 * connections route when a connection is deleted so no orphaned bindings
 * linger.
 */
export async function purgeBindingsForConnection(connectionId: string): Promise<number> {
  const victims = (await dataAssetBindingsRepo.list()).filter((b) => b.connectionId === connectionId);
  for (const v of victims) await dataAssetBindingsRepo.delete(v.id);
  return victims.length;
}

const HEALTH_SCORE_THRESHOLD = 80;

/**
 * Derive the highest tier this asset is currently *eligible* for based
 * on observable governance signals. This is advisory only — actual
 * promotion still requires a human action so "Certified" retains its
 * attestation meaning. Used by the UI to surface a "Promote?" prompt.
 *
 * Eligibility ladder (each rung includes the rungs below):
 *   SILVER   needs: owner, ≥1 steward, ≥1 sensitivity tag
 *   GOLD     needs: SILVER + ≥1 binding + healthScore ≥ threshold
 *
 * BRONZE is the floor; everyone is eligible for it.
 */
function computeSuggestedTier(
  asset: StoredDataAsset,
  boundAssetIds: Set<string>,
  effectiveHealth: number,
): 'BRONZE' | 'SILVER' | 'GOLD' {
  const hasOwner = !!asset.ownerPersonId;
  const hasSteward = Array.isArray(asset.stewardIds) && asset.stewardIds.length > 0;
  const hasSensitivity = Array.isArray(asset.sensitivityTags) && asset.sensitivityTags.length > 0;
  const silverEligible = hasOwner && hasSteward && hasSensitivity;
  if (!silverEligible) return 'BRONZE';

  // GOLD is quality-certified: it requires a measured health score at/above
  // the threshold. An asset with no measured DQ rule has 0 effective health
  // and can't reach GOLD on that basis, no matter its stored stand-in.
  const hasBinding = boundAssetIds.has(asset.id);
  const healthOk = effectiveHealth >= HEALTH_SCORE_THRESHOLD;
  if (hasBinding && healthOk) return 'GOLD';
  return 'SILVER';
}

/**
 * Effective (measured-or-0) health for a single asset, derived at read time.
 * Loads the DQ rules through the repo (Postgres-aware) and returns the stored
 * score only when a measured rule backs the asset — otherwise 0. Used by the
 * single-asset endpoints so they agree with the list's Health column.
 */
async function effectiveHealthForAsset(asset: StoredDataAsset): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rules = await getDataQualityRulesRepository(require('./data-quality').dataQualityRules).list();
  const measured = countMeasuredRulesByAsset(rules).get(asset.id) || 0;
  return effectiveHealthScore(asset.healthScore, measured);
}

const router = Router();

/** DELETE /api/v1/data-assets/all — delete all data assets */
router.delete('/all', async (_req: Request, res: Response) => {
  const allAssets = await dataAssetsRepo.list();
  const count = allAssets.length;
  for (const a of allAssets) await dataAssetsRepo.delete(a.id);
  // Wipe bindings alongside the assets they were pointing at.
  const allBindings = await dataAssetBindingsRepo.list();
  const bindingCount = allBindings.length;
  for (const b of allBindings) await dataAssetBindingsRepo.delete(b.id);
  auditService.log(DEV_ORG_ID, null, 'DataAsset', '*', 'DELETE_ALL', null, { count, bindingCount });
  logger.info({ count, bindingCount }, 'Deleted all data assets and their bindings');
  res.json({ success: true, deleted: count });
});

/** GET /api/v1/data-assets/orphans — Phase 3 reverse view. Returns
 *  data assets that have zero mapping rows pointing at them, so the
 *  catalog can surface "you have data nobody's using" candidates for
 *  cleanup or fresh process mapping. Scope by ?orgId like the main
 *  list. Each row is enriched with system name + suggested tier so
 *  the UI doesn't need a second round-trip. */
router.get('/orphans', async (req: Request, res: Response) => {
  const [allAssets, allSystems, allMappings, allPeople] = await Promise.all([
    dataAssetsRepo.list(),
    systemsRepo().list(),
    mappingsRepo().list(),
    peopleRepo().list(),
  ]);
  const filtered = scopeListForRequest(req, allAssets);
  const filteredSystems = scopeListForRequest(req, allSystems);
  const peopleById = new Map(allPeople.map((p) => [p.id, p]));
  const mappedAssetIds = new Set<string>();
  for (const m of allMappings) if (m.dataAssetId) mappedAssetIds.add(m.dataAssetId);
  const orphans = filtered
    .filter((a) => !mappedAssetIds.has(a.id))
    .map((a) => {
      const systemName = a.systemId ? filteredSystems.find((s) => s.id === a.systemId)?.name || null : null;
      const ownerName = a.ownerPersonId
        ? peopleById.get(a.ownerPersonId)?.name || null
        : null;
      return {
        id: a.id,
        name: a.name,
        description: a.description,
        systemId: a.systemId,
        systemName,
        governanceTier: a.governanceTier,
        ownerName,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      };
    });
  res.json({ success: true, data: orphans });
});

/** GET /api/v1/data-assets */
router.get('/', async (req: Request, res: Response) => {
  const [allAssets, allSystems, allMappings, allDomains, allPeople, allBindings, allRules] = await Promise.all([
    dataAssetsRepo.list(),
    systemsRepo().list(),
    mappingsRepo().list(),
    dataDomainsRepo().list(),
    peopleRepo().list(),
    dataAssetBindingsRepo.list(),
    // Read DQ rules through the repo (Postgres-aware) so the per-asset
    // coverage summary is correct in DB mode, not just JSON mode.
    getDataQualityRulesRepository(require('./data-quality').dataQualityRules).list(),
  ]);
  const filtered = scopeListForRequest(req, allAssets);
  const filteredSystems = scopeListForRequest(req, allSystems);
  const boundAssetIds = new Set(allBindings.map((b) => b.dataAssetId));

  // Per-asset DQ coverage counts for the "rules" filter on the list page:
  //   ruleCount         — any rule on the asset (typed or not, run or not)
  //   measuredRuleCount — rules with a real (non-simulated) last run, i.e.
  //                       the ones that actually move measured health.
  // The client derives three coverage states from these: has rules /
  // no rules / rules-but-unmeasured (Est).
  const ruleCountByAsset = new Map<string, number>();
  const measuredCountByAsset = new Map<string, number>();
  for (const r of allRules as Array<{ dataAssetId?: string; lastRun?: { simulated?: boolean } }>) {
    if (!r.dataAssetId) continue;
    ruleCountByAsset.set(r.dataAssetId, (ruleCountByAsset.get(r.dataAssetId) || 0) + 1);
    if (r.lastRun && r.lastRun.simulated === false) {
      measuredCountByAsset.set(r.dataAssetId, (measuredCountByAsset.get(r.dataAssetId) || 0) + 1);
    }
  }

  // Orphan signal: an asset with zero mapping rows pointing at it is
  // "unmapped" — nobody's process uses it. Computed here (same set the
  // dedicated /orphans view builds) so the main list can render an
  // Unmapped badge + drive the mapping-status filter without a second
  // round-trip. The standalone Orphan Assets page folded into this flag.
  const mappedAssetIds = new Set<string>();
  for (const m of allMappings) if (m.dataAssetId) mappedAssetIds.add(m.dataAssetId);

  // Enrich each asset with domain, owner, steward and health info so the
  // table can display them without a per-row 360 fetch.
  const enriched = filtered.map((asset) => {
    const domain = allDomains.find((d) => d.dataAssetIds?.includes(asset.id));
    let domainName: string | null = null;
    let ownerName: string | null = null;
    let stewardName: string | null = null;
    // Owner resolution has THREE fields the client cares about:
    //   ownerName      — the effective owner name for display
    //   ownerSource    — 'asset' if set on the row itself, 'domain'
    //                    if inherited from the domain owner, null if
    //                    the domain also has no owner
    //   domainOwner*   — the domain's owner even when the asset
    //                    overrides it, so the form can show
    //                    "Overrides domain (X)" and offer a reset
    // The 'domain' source is what makes ownership propagate: a
    // domain owner change automatically shows through on every
    // inheriting asset without a per-row update.
    let ownerSource: 'asset' | 'domain' | null = null;
    if (asset.ownerPersonId) {
      ownerName = allPeople.find((p) => p.id === asset.ownerPersonId)?.name || null;
      if (ownerName) ownerSource = 'asset';
    }
    if (!ownerName && asset.owner) {
      ownerName = allPeople.find((p) => p.id === asset.owner || p.name === asset.owner)?.name || asset.owner;
      if (ownerName) ownerSource = 'asset';
    }
    let domainOwnerId: string | null = null;
    let domainOwnerName: string | null = null;
    if (domain) {
      domainName = domain.name;
      if (domain.ownerId) {
        domainOwnerId = domain.ownerId;
        domainOwnerName = allPeople.find((p) => p.id === domain.ownerId)?.name || null;
      }
      if (!ownerName && domainOwnerName) {
        ownerName = domainOwnerName;
        ownerSource = 'domain';
      }
    }
    // Stewards mirror the owner-inheritance model. Same three-way
    // provenance:
    //   stewardSource       — 'asset' if the row has its own list,
    //                         'domain' if inherited, null if neither
    //                         has any.
    //   domainStewardIds    — the domain's own list, always emitted
    //                         when present so the form can show
    //                         "Overrides domain (…)" plus a reset.
    // stewardName (comma-joined names) still surfaces the *effective*
    // stewards for lists/table display — unchanged consumer contract.
    const assetStewardIds = asset.stewardIds?.length > 0 ? asset.stewardIds : [];
    const domainStewardIds: string[] = domain?.stewardIds || [];
    const domainStewardNames = domainStewardIds
      .map((sid: string) => allPeople.find((p) => p.id === sid)?.name)
      .filter(Boolean) as string[];
    let stewardSource: 'asset' | 'domain' | null = null;
    let effectiveStewardIds: string[] = [];
    if (assetStewardIds.length > 0) {
      effectiveStewardIds = assetStewardIds;
      stewardSource = 'asset';
    } else if (domainStewardIds.length > 0) {
      effectiveStewardIds = domainStewardIds;
      stewardSource = 'domain';
    }
    if (effectiveStewardIds.length > 0) {
      stewardName = effectiveStewardIds
        .map((sid: string) => allPeople.find((p) => p.id === sid)?.name)
        .filter(Boolean)
        .join(', ') || null;
    }
    const systemName = asset.systemId ? filteredSystems.find((s) => s.id === asset.systemId)?.name || null : null;
    // Effective health: the stored (rolled-up) score only when a measured DQ
    // rule backs the asset, otherwise 0. Health is earned from measured
    // quality, never a connector-freshness or manual stand-in.
    const measuredRuleCount = measuredCountByAsset.get(asset.id) || 0;
    const health = effectiveHealthScore(asset.healthScore, measuredRuleCount);
    const suggestedTier = computeSuggestedTier(asset, boundAssetIds, health);
    return {
      ...asset,
      healthScore: health,
      domainName,
      ownerName, ownerSource, domainOwnerId, domainOwnerName,
      stewardName, stewardSource, domainStewardIds, domainStewardNames,
      systemName, suggestedTier,
      isOrphan: !mappedAssetIds.has(asset.id),
      ruleCount: ruleCountByAsset.get(asset.id) || 0,
      measuredRuleCount,
    };
  });

  res.json({ success: true, data: enriched, systems: filteredSystems, dataTypes: STANDARD_DATA_TYPES });
});

/** GET /api/v1/data-assets/:id/360 — full 360 view of a data asset */
router.get('/:id/360', async (req: Request, res: Response) => {
  const asset = await dataAssetsRepo.get(String(req.params.id));
  if (!asset) { res.status(404).json({ success: false, error: 'Data asset not found' }); return; }
  if (!assertOrgAccess(req, res, asset.orgId, 'Data asset not found')) return;

  const [allSystems, allDomains, allMappings, allProcessNodes, allPeople] = await Promise.all([
    systemsRepo().list(),
    dataDomainsRepo().list(),
    mappingsRepo().list(),
    processNodesRepo().list(),
    peopleRepo().list(),
  ]);

  // Resolve system
  const system = asset.systemId ? allSystems.find((s) => s.id === asset.systemId) || null : null;

  // Find data domain containing this asset
  const domain = allDomains.find((d) => d.dataAssetIds.includes(asset.id));
  let domainInfo = null;
  if (domain) {
    const owner = domain.ownerId ? allPeople.find((p) => p.id === domain.ownerId) : null;
    const stewards = domain.stewardIds
      .map((sid) => allPeople.find((p) => p.id === sid))
      .filter(Boolean)
      .map((p) => ({ id: p!.id, name: p!.name }));
    domainInfo = { id: domain.id, name: domain.name, ownerName: owner?.name || null, stewards };
  }

  // Mappings enriched with process node path
  const assetMappings = allMappings
    .filter((m) => m.dataAssetId === asset.id)
    .map((m) => {
      const node = allProcessNodes.find((n) => n.id === m.processStepId);
      let path = m.processStepId;
      if (node) {
        const parts: string[] = [node.name];
        let current = node;
        while (current.parentId) {
          const parent = allProcessNodes.find((n) => n.id === current.parentId);
          if (!parent) break;
          parts.unshift(parent.name);
          current = parent;
        }
        path = parts.join(' > ');
      }
      return { id: m.id, processStepId: m.processStepId, linkType: m.linkType, notes: m.notes, processPath: path };
    });

  // Resolve owner and stewards from people
  const ownerPerson = asset.owner ? allPeople.find((p) => p.id === asset.owner || p.name === asset.owner) : null;
  const stewardInfos = (asset.stewardIds || [])
    .map((sid: string) => allPeople.find((p) => p.id === sid))
    .filter(Boolean)
    .map((p) => ({ id: p!.id, name: p!.name }));

  // Physical binding + the governed columns it scopes the asset to, each with
  // its per-column DQ health. This is where a client sees "this business asset
  // maps to these columns of that table, and here's each column's quality."
  const primaryBinding = await getPrimaryBinding(asset.id);
  const assetColumns = (await dataAssetColumnsRepo.list()).filter((c) => c.dataAssetId === asset.id);
  const enrichedColumns = await enrichColumnsWithDq(asset.id, assetColumns);
  const bindingInfo = primaryBinding
    ? {
        id: primaryBinding.id,
        connectionId: primaryBinding.connectionId,
        sourceAsset: primaryBinding.sourceAsset,
        sourceColumn: primaryBinding.sourceColumn,
        sourceColumns: primaryBinding.sourceColumns || (primaryBinding.sourceColumn ? [primaryBinding.sourceColumn] : []),
        label: primaryBinding.label,
      }
    : null;

  const assetHealth = await effectiveHealthForAsset(asset);

  res.json({
    success: true,
    data: {
      asset: { ...asset, healthScore: assetHealth },
      system: system ? { id: system.id, name: system.name, systemType: system.systemType } : null,
      domain: domainInfo,
      mappings: assetMappings,
      ownerInfo: ownerPerson ? { id: ownerPerson.id, name: ownerPerson.name } : (asset.owner ? { id: null, name: asset.owner } : null),
      stewardInfos,
      binding: bindingInfo,
      columns: enrichedColumns,
    },
  });
});

// ── Bindings ─────────────────────────────────────────────────────────────
// MUST be declared before `GET /:id` or Express resolves `/:id/bindings`
// as `{ id: "bindings" }` → 404.

/** GET /api/v1/data-assets/:id/bindings — list bindings for an asset */
router.get('/:id/bindings', async (req: Request, res: Response) => {
  const asset = await dataAssetsRepo.get(String(req.params.id));
  if (!asset) { res.status(404).json({ success: false, error: 'Data asset not found' }); return; }
  if (!assertOrgAccess(req, res, asset.orgId, 'Data asset not found')) return;
  const bindings = (await dataAssetBindingsRepo.list()).filter((b) => b.dataAssetId === asset.id);
  res.json({ success: true, data: bindings });
});

/**
 * POST /api/v1/data-assets/:id/bindings
 *
 * Link a Data Asset to a concrete location on a Connection. Body:
 *   { connectionId, sourceAsset, sourceColumn?, label?, isPrimary? }
 *
 * If this is the asset's first binding it's automatically marked primary.
 * If `isPrimary: true` is sent, any previously-primary binding is demoted.
 */
router.post('/:id/bindings', async (req: Request, res: Response) => {
  const asset = await dataAssetsRepo.get(String(req.params.id));
  if (!asset) { res.status(404).json({ success: false, error: 'Data asset not found' }); return; }
  if (!assertOrgAccess(req, res, asset.orgId, 'Data asset not found')) return;

  const parsed = createBindingBodySchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    res.status(400).json({ success: false, error: first?.message || 'Invalid request body', details: parsed.error.issues });
    return;
  }
  const { connectionId, sourceAsset, sourceColumn, sourceColumns, label, isPrimary } = parsed.data;
  const columnSet = normalizeColumnSet(sourceColumns, sourceColumn);

  // Look up the connection lazily so we don't create a static import cycle
  // with the connections route (which imports back into routes/data-assets
  // via the discover flow in the past).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { connections } = require('./connections') as typeof import('./connections');
  const conn = connections.find((c) => c.id === connectionId);
  if (!conn) {
    res.status(400).json({ success: false, error: 'Connection not found' });
    return;
  }

  const existing = (await dataAssetBindingsRepo.list()).filter((b) => b.dataAssetId === asset.id);
  const shouldBePrimary = isPrimary === true || existing.length === 0;
  if (shouldBePrimary) {
    // Demote any previously primary binding so there's only one active.
    for (const b of existing) {
      if (b.isPrimary) {
        b.isPrimary = false;
        b.updatedAt = new Date().toISOString();
        await dataAssetBindingsRepo.update(b.id, b);
      }
    }
  }

  const now = new Date().toISOString();
  const binding: StoredDataAssetBinding = {
    id: uuid(),
    orgId: asset.orgId,
    dataAssetId: asset.id,
    connectionId,
    sourceAsset,
    sourceColumn: columnSet[0],
    sourceColumns: columnSet.length ? columnSet : undefined,
    label: label || undefined,
    isPrimary: shouldBePrimary,
    createdAt: now,
    updatedAt: now,
  };
  await dataAssetBindingsRepo.create(binding);
  // Project the bound column set into governed DataAssetColumn rows so the set
  // is immediately something you can attach DQ rules to and measure.
  await materializeColumnsFromBinding(asset, binding);
  auditService.log(asset.orgId, null, 'DataAssetBinding', binding.id, 'CREATE', null, binding);
  res.status(201).json({ success: true, data: binding });
});

/**
 * PUT /api/v1/data-assets/:id/bindings/:bindingId
 *
 * Update a binding's source asset/column/label/primary flag. Connection
 * cannot be changed here — to point at a different connection, delete
 * this binding and create a new one (mirrors the "unlink → link"
 * interaction the UI offers).
 */
router.put('/:id/bindings/:bindingId', async (req: Request, res: Response) => {
  const asset = await dataAssetsRepo.get(String(req.params.id));
  if (!asset) { res.status(404).json({ success: false, error: 'Data asset not found' }); return; }
  if (!assertOrgAccess(req, res, asset.orgId, 'Data asset not found')) return;
  const binding = await dataAssetBindingsRepo.get(String(req.params.bindingId));
  if (!binding || binding.dataAssetId !== asset.id) { res.status(404).json({ success: false, error: 'Binding not found' }); return; }

  const parsed = updateBindingBodySchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    res.status(400).json({ success: false, error: first?.message || 'Invalid request body', details: parsed.error.issues });
    return;
  }
  const { sourceAsset, sourceColumn, sourceColumns, label, isPrimary } = parsed.data;
  if (sourceAsset !== undefined) binding.sourceAsset = sourceAsset;
  // sourceColumns is the canonical multi-column set; sourceColumn stays as its
  // mirrored first entry. A caller may send either — the array wins when both
  // are present, and a legacy single column is treated as a one-column set.
  if (sourceColumns !== undefined) {
    const columnSet = normalizeColumnSet(sourceColumns, undefined);
    binding.sourceColumns = columnSet.length ? columnSet : undefined;
    binding.sourceColumn = columnSet[0];
  } else if (sourceColumn !== undefined) {
    const columnSet = normalizeColumnSet(undefined, sourceColumn);
    binding.sourceColumns = columnSet.length ? columnSet : undefined;
    binding.sourceColumn = columnSet[0];
  }
  if (label !== undefined) binding.label = label || undefined;
  if (isPrimary === true && !binding.isPrimary) {
    const allBindings = await dataAssetBindingsRepo.list();
    for (const b of allBindings) {
      if (b.dataAssetId === asset.id && b.id !== binding.id && b.isPrimary) {
        b.isPrimary = false; b.updatedAt = new Date().toISOString();
        await dataAssetBindingsRepo.update(b.id, b);
      }
    }
    binding.isPrimary = true;
  }
  binding.updatedAt = new Date().toISOString();
  await dataAssetBindingsRepo.update(binding.id, binding);
  // Newly-added columns in the set become governed columns; existing ones and
  // removed ones are left untouched (removing a column here should not silently
  // drop its DQ rules — that stays an explicit column delete).
  await materializeColumnsFromBinding(asset, binding);
  auditService.log(asset.orgId, null, 'DataAssetBinding', binding.id, 'UPDATE', null, binding);
  res.json({ success: true, data: binding });
});

/**
 * DELETE /api/v1/data-assets/:id/bindings/:bindingId
 *
 * Unlink a binding. If the removed binding was primary and other bindings
 * exist, the next one in creation order is promoted to primary so the
 * asset still has a canonical location.
 */
router.delete('/:id/bindings/:bindingId', async (req: Request, res: Response) => {
  const asset = await dataAssetsRepo.get(String(req.params.id));
  if (!asset) { res.status(404).json({ success: false, error: 'Data asset not found' }); return; }
  if (!assertOrgAccess(req, res, asset.orgId, 'Data asset not found')) return;
  const removed = await dataAssetBindingsRepo.get(String(req.params.bindingId));
  if (!removed || removed.dataAssetId !== asset.id) { res.status(404).json({ success: false, error: 'Binding not found' }); return; }
  await dataAssetBindingsRepo.delete(removed.id);

  // Promote a successor so there's still one primary when any bindings remain.
  if (removed.isPrimary) {
    const remaining = (await dataAssetBindingsRepo.list()).filter((b) => b.dataAssetId === asset.id);
    if (remaining.length > 0) {
      const next = remaining.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      next.isPrimary = true;
      next.updatedAt = new Date().toISOString();
      await dataAssetBindingsRepo.update(next.id, next);
    }
  }
  auditService.log(asset.orgId, null, 'DataAssetBinding', removed.id, 'DELETE', removed, null);
  res.status(204).send();
});

/** GET /api/v1/data-assets/:id */
router.get('/:id', async (req: Request, res: Response) => {
  const asset = await dataAssetsRepo.get(String(req.params.id));
  if (!asset) { res.status(404).json({ success: false, error: 'Data asset not found' }); return; }
  if (!assertOrgAccess(req, res, asset.orgId, 'Data asset not found')) return;
  const healthScore = await effectiveHealthForAsset(asset);
  res.json({ success: true, data: { ...asset, healthScore } });
});

/** POST /api/v1/data-assets */
router.post('/', async (req: Request, res: Response) => {
  const parsed = createDataAssetBodySchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    res.status(400).json({ success: false, error: first?.message || 'Invalid request body', details: parsed.error.issues });
    return;
  }
  const { name, description, systemId, owner, ownerPersonId, stewardIds, governanceTier, healthScore, isSystemOfRecord, orgId,
    sourceConnectionId, sourceAsset, sourceColumn,
    dataType, category,
    retentionPolicy, retentionDuration, retentionReason,
    refreshFrequency, origin } = parsed.data;
  // Ownership-level guard: data assets attach to one org, but only
  // at the company or division level. A department or team can't
  // be the owner — it inherits visibility from above. Skip when no
  // orgId was supplied so the DEV_ORG_ID fallback path keeps
  // working unchanged.
  if (orgId && !isOwnershipLevel(orgId)) {
    res.status(400).json({ success: false, error: 'Data assets can only be owned at the company or division level. Pick a different org from "Working in...".' });
    return;
  }
  // Trust an explicit origin from the caller (governance template, sync,
  // future importer); otherwise infer DISCOVERED when source-connection
  // fields are present, MANUAL by default.
  const resolvedOrigin: StoredDataAsset['origin'] =
    origin || (sourceConnectionId || sourceAsset ? 'DISCOVERED' : 'MANUAL');

  const tier = governanceTier || 'BRONZE';
  const score = typeof healthScore === 'number' ? Math.max(0, Math.min(100, healthScore)) : 0;
  const now = new Date().toISOString();

  // Map legacy `category` to `dataType` if a new caller still sends only the
  // old field. Prefer an explicit `dataType` value when both are present.
  const resolvedDataType: StoredDataAsset['dataType'] | undefined =
    dataType
    || (category && CATEGORY_TO_DATA_TYPE[category])
    || undefined;

  const asset: StoredDataAsset = {
    id: uuid(), orgId: orgId || DEV_ORG_ID, name,
    description: description || '',
    systemId: systemId || '',
    owner: owner || '',
    ownerPersonId: ownerPersonId || null,
    stewardIds: Array.isArray(stewardIds) ? stewardIds : [],
    governanceTier: tier,
    healthScore: score,
    ...(isSystemOfRecord ? { isSystemOfRecord: true } : {}),
    ...(score > 0 ? { healthScoreAt: now } : { healthScoreAt: null }),
    ...(sourceConnectionId ? { sourceConnectionId } : {}),
    ...(sourceAsset ? { sourceAsset } : {}),
    ...(sourceColumn ? { sourceColumn } : {}),
    ...(resolvedDataType ? { dataType: resolvedDataType } : {}),
    ...(category ? { category } : {}),
    ...(retentionPolicy ? { retentionPolicy } : {}),
    ...(retentionDuration ? { retentionDuration } : {}),
    ...(retentionReason ? { retentionReason } : {}),
    ...(refreshFrequency ? { refreshFrequency } : {}),
    origin: resolvedOrigin,
    createdAt: now, updatedAt: now,
  };
  await dataAssetsRepo.create(asset);
  await syncBindingFromAssetFields(asset);
  res.status(201).json({ success: true, data: asset });
});

/** PUT /api/v1/data-assets/:id */
router.put('/:id', async (req: Request, res: Response) => {
  const asset = await dataAssetsRepo.get(String(req.params.id));
  if (!asset) { res.status(404).json({ success: false, error: 'Data asset not found' }); return; }
  if (!assertOrgAccess(req, res, asset.orgId, 'Data asset not found')) return;

  const parsed = updateDataAssetBodySchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    res.status(400).json({ success: false, error: first?.message || 'Invalid request body', details: parsed.error.issues });
    return;
  }
  const rawBody = req.body as Record<string, unknown> | undefined;
  const { name, description, systemId, owner, ownerPersonId, stewardIds, governanceTier, healthScore, isSystemOfRecord,
    sourceConnectionId, sourceAsset, sourceColumn,
    dataType, category,
    retentionPolicy, retentionDuration, retentionReason,
    refreshFrequency } = parsed.data;
  const now = new Date().toISOString();

  if (name !== undefined) asset.name = name;
  if (description !== undefined) asset.description = description;
  if (systemId !== undefined) asset.systemId = systemId || '';
  if (owner !== undefined) asset.owner = owner;
  if (ownerPersonId !== undefined) asset.ownerPersonId = ownerPersonId || null;
  if (stewardIds !== undefined && Array.isArray(stewardIds)) asset.stewardIds = stewardIds;
  if (governanceTier !== undefined) asset.governanceTier = governanceTier;
  if (isSystemOfRecord !== undefined) asset.isSystemOfRecord = isSystemOfRecord;
  if (healthScore !== undefined && typeof healthScore === 'number') {
    const clamped = Math.max(0, Math.min(100, healthScore));
    if (clamped !== asset.healthScore) {
      asset.healthScore = clamped;
      asset.healthScoreAt = now;
    }
  }
  if (sourceConnectionId !== undefined) asset.sourceConnectionId = sourceConnectionId || undefined;
  if (sourceAsset !== undefined) asset.sourceAsset = sourceAsset || undefined;
  if (sourceColumn !== undefined) asset.sourceColumn = sourceColumn || undefined;
  // Presence checks use the raw body: zod's `.catch(undefined)` collapses
  // invalid values to `undefined`, which is indistinguishable from the
  // field being omitted in the parsed body. The runtime semantics
  // (`if (field !== undefined) { ... }`) required distinguishing
  // "explicitly sent" from "omitted", so we consult the raw body for the
  // presence bit while still using the parsed (validated) value.
  if (rawBody && 'dataType' in rawBody) {
    asset.dataType = dataType;
  } else if (category !== undefined && CATEGORY_TO_DATA_TYPE[category]) {
    // Older callers may still send only the legacy `category`; carry over.
    asset.dataType = CATEGORY_TO_DATA_TYPE[category];
  }
  if (category !== undefined) asset.category = category || undefined;
  if (retentionPolicy !== undefined) asset.retentionPolicy = retentionPolicy || undefined;
  if (rawBody && 'retentionDuration' in rawBody) {
    asset.retentionDuration = retentionDuration;
  }
  if (retentionReason !== undefined) asset.retentionReason = retentionReason || undefined;
  if (rawBody && 'refreshFrequency' in rawBody) {
    asset.refreshFrequency = refreshFrequency;
  }
  asset.updatedAt = now;
  await dataAssetsRepo.update(asset.id, asset);
  await syncBindingFromAssetFields(asset);
  res.json({ success: true, data: asset });
});

/** DELETE /api/v1/data-assets/:id */
router.delete('/:id', async (req: Request, res: Response) => {
  const removed = await dataAssetsRepo.get(String(req.params.id));
  if (!removed) { res.status(404).json({ success: false, error: 'Data asset not found' }); return; }
  if (!assertOrgAccess(req, res, removed.orgId, 'Data asset not found')) return;
  await dataAssetsRepo.delete(removed.id);
  // Cascade: delete this asset's bindings so they don't linger.
  const ownBindings = (await dataAssetBindingsRepo.list()).filter((b) => b.dataAssetId === removed.id);
  for (const b of ownBindings) await dataAssetBindingsRepo.delete(b.id);
  res.status(204).send();
});

// ──────────────────────────────────────────────────────────────────────────
// Column CRUD — nested under /data-assets/:id/columns
// ──────────────────────────────────────────────────────────────────────────

/**
 * Enrich an asset's columns with their per-column DQ summary: rule counts by
 * status and a weight-averaged health score (null when the column has no
 * rules). Shared by GET /:id/columns and the 360 view so both compute
 * column health identically.
 */
async function enrichColumnsWithDq(assetId: string, cols: StoredDataAssetColumn[]) {
  // Read DQ rules through the persistence-aware repo, NOT the raw in-memory
  // `dataQualityRules` array. Under Postgres that array stays empty (the rules
  // live in the DB), so reading it directly reported every column as having
  // zero rules / null health even when rules existed — while the asset-level
  // rollup (repo-backed) showed the real count. The repo is built lazily over
  // the shared store so the module-level circular dep with ./data-quality is
  // still avoided.
  let dqRules: any[] = [];
  try {
    dqRules = await getDataQualityRulesRepository(require('./data-quality').dataQualityRules).list();
  } catch { /* */ }

  return cols.map((col) => {
    const rules = dqRules.filter((r: any) => r.dataAssetId === assetId && r.columnId === col.id);
    const passing = rules.filter((r: any) => r.status === 'PASSING').length;
    const failing = rules.filter((r: any) => r.status === 'FAILING').length;
    const warning = rules.filter((r: any) => r.status === 'WARNING').length;
    // Column health, like asset health, is weighted over MEASURED rules only.
    // A rule created but never run (or one that could only be simulated) must
    // NOT drag the column to a fabricated 0% — an unmeasured column reads null
    // ("—") so the UI never presents an estimate as a measurement.
    const measured = rules.filter((r: any) => r.lastRun && r.lastRun.simulated === false);
    const totalWeight = measured.reduce((s: number, r: any) => s + (r.weight || 5), 0);
    const weightedSum = measured.reduce((s: number, r: any) => s + (r.currentScore || 0) * (r.weight || 5), 0);
    const health = measured.length > 0 && totalWeight > 0 ? Math.round(weightedSum / totalWeight) : null;
    const enrichedRules = rules.map((r: any) => ({
      id: r.id, name: r.name, ruleType: r.ruleType || null,
      dimension: r.dimension, threshold: r.threshold,
      currentScore: r.currentScore, status: r.status,
      lastMeasured: r.lastMeasured, weight: r.weight,
      scheduleFrequency: r.scheduleFrequency || 'NEVER',
      nextRunAt: r.nextRunAt || null,
    }));
    return {
      ...col,
      rulesCount: rules.length,
      rulesPassing: passing,
      rulesFailing: failing,
      rulesWarning: warning,
      healthScore: health,
      rules: enrichedRules,
    };
  });
}

/** GET /data-assets/:id/columns — list columns for an asset, enriched with
 *  per-column DQ rule summary (count, passing, failing, health score). */
router.get('/:id/columns', async (req: Request, res: Response) => {
  const asset = await dataAssetsRepo.get(String(req.params.id));
  if (!asset) { res.status(404).json({ success: false, error: 'Data asset not found' }); return; }
  if (!assertOrgAccess(req, res, asset.orgId, 'Data asset not found')) return;
  const cols = (await dataAssetColumnsRepo.list()).filter((c) => c.dataAssetId === asset.id);
  res.json({ success: true, data: await enrichColumnsWithDq(asset.id, cols) });
});

/** POST /data-assets/:id/columns — create a column */
router.post('/:id/columns', async (req: Request, res: Response) => {
  const asset = await dataAssetsRepo.get(String(req.params.id));
  if (!asset) { res.status(404).json({ success: false, error: 'Data asset not found' }); return; }
  if (!assertOrgAccess(req, res, asset.orgId, 'Data asset not found')) return;
  const parsed = createColumnBodySchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    res.status(400).json({ success: false, error: first?.message || 'Invalid request body', details: parsed.error.issues });
    return;
  }
  const { columnName, dataType, description, sourceConnectionId, sourceAsset, sourceColumn, isPrimaryKey, references } = parsed.data;
  const now = new Date().toISOString();
  const col: StoredDataAssetColumn = {
    id: uuid(), dataAssetId: asset.id, columnName,
    dataType: normalizeDataType(dataType || ''), description: description || '',
    sourceConnectionId: sourceConnectionId || undefined,
    sourceAsset: sourceAsset || undefined,
    sourceColumn: sourceColumn || columnName,
    ...(isPrimaryKey ? { isPrimaryKey: true } : {}),
    ...(references ? { references } : {}),
    createdAt: now, updatedAt: now,
  };
  await dataAssetColumnsRepo.create(col);
  res.status(201).json({ success: true, data: col });
});

/** PUT /data-assets/:id/columns/:colId — update a column */
router.put('/:id/columns/:colId', async (req: Request, res: Response) => {
  const parentAsset = await dataAssetsRepo.get(String(req.params.id));
  if (!parentAsset) { res.status(404).json({ success: false, error: 'Column not found' }); return; }
  if (!assertOrgAccess(req, res, parentAsset.orgId, 'Column not found')) return;
  const col = await dataAssetColumnsRepo.get(String(req.params.colId));
  if (!col || col.dataAssetId !== req.params.id) { res.status(404).json({ success: false, error: 'Column not found' }); return; }
  const parsed = updateColumnBodySchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    res.status(400).json({ success: false, error: first?.message || 'Invalid request body', details: parsed.error.issues });
    return;
  }
  const { columnName, dataType, description, isPrimaryKey, references } = parsed.data;
  const patch: Partial<StoredDataAssetColumn> = { updatedAt: new Date().toISOString() };
  if (columnName !== undefined) patch.columnName = columnName;
  if (dataType !== undefined) patch.dataType = normalizeDataType(dataType);
  if (description !== undefined) patch.description = description;
  if (isPrimaryKey !== undefined) patch.isPrimaryKey = isPrimaryKey;
  if (references !== undefined) patch.references = references || undefined;
  const updated = await dataAssetColumnsRepo.update(col.id, patch);
  res.json({ success: true, data: updated });
});

/** DELETE /data-assets/:id/columns/:colId — delete a column */
router.delete('/:id/columns/:colId', async (req: Request, res: Response) => {
  const parentAsset = await dataAssetsRepo.get(String(req.params.id));
  if (!parentAsset) { res.status(404).json({ success: false, error: 'Column not found' }); return; }
  if (!assertOrgAccess(req, res, parentAsset.orgId, 'Column not found')) return;
  const col = await dataAssetColumnsRepo.get(String(req.params.colId));
  if (!col || col.dataAssetId !== req.params.id) { res.status(404).json({ success: false, error: 'Column not found' }); return; }
  await dataAssetColumnsRepo.delete(col.id);
  res.status(204).send();
});

/**
 * POST /data-assets/:id/columns/auto-discover
 *
 * Reads the asset's primary binding, calls the connection's discover
 * endpoint to enumerate columns, and creates DataAssetColumn records for
 * any columns that don't already exist. Idempotent — re-running it picks
 * up new columns without duplicating existing ones.
 */
router.post('/:id/columns/auto-discover', async (req: Request, res: Response) => {
  const asset = await dataAssetsRepo.get(String(req.params.id));
  if (!asset) { res.status(404).json({ success: false, error: 'Data asset not found' }); return; }
  if (!assertOrgAccess(req, res, asset.orgId, 'Data asset not found')) return;
  const binding = await getPrimaryBinding(asset.id);
  if (!binding) {
    res.status(400).json({ success: false, error: 'Asset has no connection binding. Link it to a connection first.' });
    return;
  }
  // Import the connector dynamically to avoid circular deps at module level.
  const { connections } = require('./connections');
  const conn = connections.find((c: any) => c.id === binding.connectionId);
  if (!conn) {
    res.status(400).json({ success: false, error: 'The linked connection no longer exists.' });
    return;
  }
  try {
    // Use the shared connector service — it runs real discovery for LOCAL
    // files, relational databases, warehouses, MongoDB, and cloud object
    // stores, and simulates discovery for API / SPREADSHEET sources.
    const { discoverAssets } = require('../services/connector.service');
    const result = await discoverAssets(conn);

    let discoveredColumns: string[] = [];
    if (result.success && result.details?.assets) {
      // Find the asset whose name matches the binding's sourceAsset.
      const matchingAsset = result.details.assets.find(
        (a: any) => a.name === binding.sourceAsset,
      );
      if (matchingAsset?.columns) {
        discoveredColumns = matchingAsset.columns;
      } else if (result.details.assets.length > 0 && !binding.sourceAsset) {
        // No sourceAsset on the binding (rare) — take columns from the
        // first discovered asset as a best-effort fallback.
        discoveredColumns = result.details.assets[0].columns || [];
      }
    }
    // Fallback: if the connection config itself has a columns array
    // (populated during the original test/upload for LOCAL files).
    if (discoveredColumns.length === 0 && conn.config?.columns && Array.isArray(conn.config.columns)) {
      discoveredColumns = conn.config.columns;
    }
    // If the binding scopes the asset to a NAMED column set, honor it: ingest
    // only those columns (case-insensitively), so the governed columns match
    // what the asset was actually bound to instead of the whole physical table.
    // An empty set means "whole table" — ingest everything discovered.
    const boundSet = binding.sourceColumns || [];
    if (boundSet.length > 0) {
      const wanted = new Set(boundSet.map((c) => c.toLowerCase()));
      const filtered = discoveredColumns.filter((c) => wanted.has(c.toLowerCase()));
      // Fall back to the bound names themselves if discovery returned nothing
      // that matches (e.g. simulated discovery of a different table) — the set
      // is the source of truth for scope.
      discoveredColumns = filtered.length > 0 ? filtered : boundSet;
    }
    if (discoveredColumns.length === 0) {
      res.json({ success: true, data: [], message: 'No columns discovered from this connection.' });
      return;
    }
    const existing = (await dataAssetColumnsRepo.list()).filter((c) => c.dataAssetId === asset.id);
    const existingNames = new Set(existing.map((c) => c.columnName.toLowerCase()));
    const now = new Date().toISOString();
    const created: StoredDataAssetColumn[] = [];
    for (const colName of discoveredColumns) {
      if (existingNames.has(colName.toLowerCase())) continue;
      const col: StoredDataAssetColumn = {
        id: uuid(), dataAssetId: asset.id, columnName: colName,
        dataType: '', description: '',
        sourceConnectionId: binding.connectionId,
        sourceAsset: binding.sourceAsset,
        sourceColumn: colName,
        createdAt: now, updatedAt: now,
      };
      await dataAssetColumnsRepo.create(col);
      created.push(col);
    }
    res.json({ success: true, data: created, message: `Discovered ${created.length} new column(s).`, total: existing.length + created.length });
  } catch (err: any) {
    logger.error({ err, assetId: asset.id }, 'Column auto-discover failed');
    res.status(500).json({ success: false, error: err?.message || 'Discovery failed' });
  }
});

// ── Suggest source ────────────────────────────────────────────────────────
//
// Given a Data Asset (a business concept like "Customer Accounts"), score
// the existing connections in the same org and surface the candidates
// whose names are likely to back this asset. Asset-rooted complement to
// the connection-rooted "Discover assets" button on the Connections page.
//
// We score against names already known to the connection — file names
// and column lists for LOCAL files. Database/API connections that
// haven't been live-discovered have no pre-populated candidate list so
// they're skipped here; the user can still reach them from the
// connection-rooted Discover flow.

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

function similarity(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  const union = ta.size + tb.size - intersection;
  const jaccard = intersection / union;
  // Substring boost — "customer" appearing in "customers.csv" should
  // outrank a same-jaccard candidate without the substring overlap.
  const aLow = a.toLowerCase();
  const bLow = b.toLowerCase();
  const sub = aLow.includes(bLow) || bLow.includes(aLow) ? 0.15 : 0;
  return Math.min(1, jaccard + sub);
}

router.get('/:id/suggest-source', requireAiEnabled, enforceAiBudget, async (req: Request, res: Response) => {
  const asset = await dataAssetsRepo.get(String(req.params.id));
  if (!asset) { res.status(404).json({ success: false, error: 'Data asset not found' }); return; }
  if (!assertOrgAccess(req, res, asset.orgId, 'Data asset not found')) return;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { connections } = require('./connections') as typeof import('./connections');
  const orgConnections = connections.filter((c) => c.orgId === asset.orgId);

  // Don't suggest sources already bound to *some* asset — those have a
  // claim on them. Bound-to-this-asset is also excluded since the user
  // is looking for a missing or additional binding.
  const claimed = new Set(
    (await dataAssetBindingsRepo.list()).map((b) =>
      `${b.connectionId}::${b.sourceAsset || ''}::${b.sourceColumn || ''}`,
    ),
  );

  type Candidate = {
    connectionId: string;
    connectionName: string;
    connectionType: string;
    sourceAsset: string;
    sourceColumn: string | null;
    score: number;
    /** A short human-readable reason the candidate ranked. Helps the
     *  UI explain "why this match" without re-running the scorer. */
    reason: string;
  };

  const candidates: Candidate[] = [];
  const assetText = `${asset.name} ${asset.description || ''}`;

  for (const conn of orgConnections) {
    const cfg: any = conn.config || {};
    const file: string | undefined = cfg.originalFileName;
    const cols: string[] = Array.isArray(cfg.columns) ? cfg.columns : [];
    if (!file && cols.length === 0) continue; // nothing observable to match

    if (file) {
      const score = similarity(assetText, file);
      const key = `${conn.id}::${file}::`;
      if (score > 0 && !claimed.has(key)) {
        candidates.push({
          connectionId: conn.id,
          connectionName: conn.name,
          connectionType: conn.connectionType,
          sourceAsset: file,
          sourceColumn: null,
          score,
          reason: `File name "${file}" overlaps with asset name`,
        });
      }
    }
    for (const col of cols) {
      const score = similarity(assetText, col);
      const key = `${conn.id}::${file || ''}::${col}`;
      if (score > 0 && !claimed.has(key)) {
        candidates.push({
          connectionId: conn.id,
          connectionName: conn.name,
          connectionType: conn.connectionType,
          sourceAsset: file || conn.name,
          sourceColumn: col,
          score,
          reason: `Column "${col}" overlaps with asset name`,
        });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  // Cap at 10 — beyond that the user is better off using the
  // connection-rooted Discover flow with full filtering.
  res.json({ success: true, data: candidates.slice(0, 10) });
});

// ── Discovery reconciliation (Phase 3, A2) ────────────────────────────────
//
// After a connection is discovered, reconcile each discovered table/file
// against the business catalog: suggest the best-matching existing Data Asset
// by name (reusing `similarity`), flag ones already bound, and let the user
// confirm the suggestion, link to a different asset, or create a new Bronze
// asset. Connection-rooted (mirrors the Discover flow), the inverse of the
// asset-rooted `/:id/suggest-source`.

const RECONCILE_MATCH_THRESHOLD = 0.4;

function loadConnectionById(connectionId: string): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { connections } = require('./connections');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getConnectionsRepository } = require('../db/connections.repo');
  return getConnectionsRepository(connections).get(connectionId);
}

/** GET /api/v1/data-assets/reconcile/:connectionId — discovered assets +
 *  their reconciliation status against the catalog. */
router.get('/reconcile/:connectionId', async (req: Request, res: Response) => {
  const connectionId = String(req.params.connectionId);
  const conn = await loadConnectionById(connectionId);
  if (!conn) { res.status(404).json({ success: false, error: 'Connection not found' }); return; }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { discoverAssets } = require('../services/connector.service');
  const result = await discoverAssets(conn);
  if (!result.success) { res.status(502).json({ success: false, error: result.message || 'Discovery failed' }); return; }
  const discovered = (result.details?.assets || []) as Array<{ name: string; type?: string; columns?: string[]; rowCount?: number | null }>;

  const orgAssets = (await dataAssetsRepo.list()).filter((a) => a.orgId === conn.orgId);
  const bindings = await dataAssetBindingsRepo.list();
  // Source keys already bound on THIS connection: lower(sourceAsset) → assetId.
  const linkedBySource = new Map<string, string>();
  for (const b of bindings) {
    if (b.connectionId === connectionId && b.sourceAsset) linkedBySource.set(b.sourceAsset.toLowerCase(), b.dataAssetId);
  }
  const nameOf = (id: string) => orgAssets.find((a) => a.id === id)?.name || 'Unknown asset';

  const items = discovered.map((d) => {
    const base = { sourceAsset: d.name, type: d.type || 'TABLE', columns: d.columns || [], rowCount: d.rowCount ?? null };
    const linkedId = linkedBySource.get(d.name.toLowerCase());
    if (linkedId) {
      return { ...base, status: 'linked', linkedAssetId: linkedId, linkedAssetName: nameOf(linkedId) };
    }
    let best: { dataAssetId: string; dataAssetName: string; score: number } | null = null;
    for (const a of orgAssets) {
      const score = similarity(d.name, `${a.name} ${a.description || ''}`);
      if (!best || score > best.score) best = { dataAssetId: a.id, dataAssetName: a.name, score };
    }
    if (best && best.score >= RECONCILE_MATCH_THRESHOLD) {
      return {
        ...base, status: 'suggested',
        suggestion: { dataAssetId: best.dataAssetId, dataAssetName: best.dataAssetName, score: Math.round(best.score * 100), reason: `Name matches "${best.dataAssetName}"` },
      };
    }
    return { ...base, status: 'new' };
  });

  res.json({ success: true, data: { connectionId, connectionName: conn.name, simulated: !!result.simulated, items } });
});

/**
 * POST /api/v1/data-assets/reconcile/:connectionId
 * Body: { decisions: [{ sourceAsset, action: 'link'|'create'|'skip',
 *                       dataAssetId?, dataAssetName?, columns?: string[] }] }
 *
 * Apply the user's confirmed reconciliation. 'link' binds the source to an
 * existing asset; 'create' makes a new Bronze DISCOVERED asset and binds it;
 * both materialize the named columns so DQ rules can attach. 'skip' is a no-op.
 */
router.post('/reconcile/:connectionId', async (req: Request, res: Response) => {
  const connectionId = String(req.params.connectionId);
  const conn = await loadConnectionById(connectionId);
  if (!conn) { res.status(404).json({ success: false, error: 'Connection not found' }); return; }

  const decisions = Array.isArray(req.body?.decisions) ? req.body.decisions : [];
  if (decisions.length === 0) { res.status(400).json({ success: false, error: 'No decisions provided' }); return; }

  const bindings = await dataAssetBindingsRepo.list();
  const hasBinding = (assetId: string) => bindings.some((b) => b.dataAssetId === assetId);
  const iso = () => new Date().toISOString();

  const bindSource = async (asset: StoredDataAsset, sourceAsset: string, columns?: string[]): Promise<void> => {
    const cols = normalizeColumnSet(columns);
    const binding: StoredDataAssetBinding = {
      id: uuid(), orgId: asset.orgId, dataAssetId: asset.id, connectionId,
      sourceAsset, sourceColumn: cols[0], sourceColumns: cols.length ? cols : undefined,
      isPrimary: !hasBinding(asset.id), createdAt: iso(), updatedAt: iso(),
    };
    await dataAssetBindingsRepo.create(binding);
    bindings.push(binding);
    await materializeColumnsFromBinding(asset, binding);
    auditService.log(asset.orgId, null, 'DataAssetBinding', binding.id, 'CREATE', null, binding);
  };

  // Re-run discovery once to get authoritative, server-side row counts and
  // column sets for this connection — the same live scan the connector's
  // report path carries. Best-effort: if it fails (or returns nothing for a
  // source), we still apply the user's decisions, just without the drift /
  // row-count health enrichment for that asset.
  const scanByName = new Map<string, { rowCount: number | null; columns: string[]; columnTypes: Record<string, string> }>();
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { discoverAssets } = require('../services/connector.service');
    const disc = await discoverAssets(conn);
    if (disc?.success) {
      for (const a of (disc.details?.assets || []) as Array<{ name?: string; columns?: string[]; rowCount?: number | null; columnTypes?: Record<string, string> }>) {
        const nm = String(a?.name || '');
        if (nm) scanByName.set(nm.toLowerCase(), {
          rowCount: typeof a?.rowCount === 'number' ? a.rowCount : null,
          columns: Array.isArray(a?.columns) ? a.columns.map(String) : [],
          columnTypes: a?.columnTypes && typeof a.columnTypes === 'object' ? a.columnTypes : {},
        });
      }
    }
  } catch { /* enrichment is best-effort */ }

  // Drift verdicts for assets re-linked this run, reconciled into governance
  // issues after the loop (batched, off the per-decision path).
  const driftEvents: SchemaDriftEvent[] = [];

  // Refresh an existing asset's row count, schema fingerprint, and liveness
  // health from this scan, and record whether its schema drifted. A first
  // fingerprint just establishes the baseline; a changed one lowers the score
  // and raises a SCHEMA_DRIFT issue below.
  const rescanExisting = async (asset: StoredDataAsset, source: string): Promise<void> => {
    const scan = scanByName.get(source.toLowerCase());
    if (!scan) return; // no live scan data for this source — leave health as-is
    const res = computeRescanHealth({
      previousFingerprint: asset.schemaFingerprint ?? null,
      previousRowCount: typeof asset.rowCount === 'number' ? asset.rowCount : null,
      columns: scan.columns.map((c) => ({ name: c, dataType: scan.columnTypes[c] })),
      rowCount: scan.rowCount,
    });
    if (scan.rowCount !== null) asset.rowCount = scan.rowCount;
    if (res.schemaFingerprint) asset.schemaFingerprint = res.schemaFingerprint;
    asset.healthScore = res.healthScore;
    asset.updatedAt = iso();
    await dataAssetsRepo.update(asset.id, asset);
    if (res.schemaFingerprint) {
      driftEvents.push({
        asset: { id: asset.id, name: asset.name, systemId: asset.systemId || null, ownerPersonId: asset.ownerPersonId || null },
        drifted: res.drifted,
        columnCount: scan.columns.length,
      });
    }
  };

  const summary = { linked: 0, created: 0, skipped: 0, errors: [] as string[] };
  for (const d of decisions) {
    const sourceAsset = String(d?.sourceAsset || '').trim();
    const action = String(d?.action || 'skip');
    if (!sourceAsset || action === 'skip') { summary.skipped++; continue; }
    try {
      if (action === 'link') {
        const asset = await dataAssetsRepo.get(String(d.dataAssetId || ''));
        if (!asset || asset.orgId !== conn.orgId) { summary.errors.push(`${sourceAsset}: target asset not found`); continue; }
        // Refresh health + fingerprint and detect drift against this asset's
        // stored baseline before binding the (possibly new) source.
        await rescanExisting(asset, sourceAsset);
        await bindSource(asset, sourceAsset, d.columns);
        summary.linked++;
      } else if (action === 'create') {
        const name = (String(d.dataAssetName || '').trim()) || sourceAsset;
        // First sighting establishes the fingerprint baseline (never drift)
        // and seeds the liveness health from this scan's row count.
        const scan = scanByName.get(sourceAsset.toLowerCase());
        const res = scan
          ? computeRescanHealth({ columns: scan.columns.map((c) => ({ name: c, dataType: scan.columnTypes[c] })), rowCount: scan.rowCount })
          : null;
        const asset: StoredDataAsset = {
          id: uuid(), orgId: conn.orgId, name, description: '',
          systemId: (Array.isArray(conn.systemIds) && conn.systemIds[0]) || '',
          owner: '', stewardIds: [], governanceTier: 'BRONZE',
          healthScore: res ? res.healthScore : 0, origin: 'DISCOVERED',
          sourceConnectionId: connectionId, sourceAsset,
          ...(scan && scan.rowCount !== null ? { rowCount: scan.rowCount } : {}),
          ...(res && res.schemaFingerprint ? { schemaFingerprint: res.schemaFingerprint } : {}),
          createdAt: iso(), updatedAt: iso(),
        };
        await dataAssetsRepo.create(asset);
        auditService.log(asset.orgId, null, 'DataAsset', asset.id, 'CREATE', null, asset);
        await bindSource(asset, sourceAsset, d.columns);
        summary.created++;
      } else {
        summary.skipped++;
      }
    } catch (err) {
      summary.errors.push(`${sourceAsset}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Raise / resolve schema-drift issues for the assets re-linked this run.
  // Best-effort + lazy require (governance-issues imports this module, so a
  // static import would close an init cycle) — a hiccup must not fail the
  // reconcile, which is the user's actual action.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { reconcileSchemaDriftIssues } = require('./governance-issues');
    await reconcileSchemaDriftIssues(conn.orgId, driftEvents);
  } catch (err) {
    logger.warn({ err, connectionId }, 'Schema-drift issue reconciliation failed during reconcile');
  }

  auditService.log(conn.orgId, null, 'ConnectionProfile', connectionId, 'RECONCILE', null, summary);
  res.json({ success: true, data: summary });
});

// ── Sensitivity classification ──
//
// Two-step flow so the user reviews before we tag anything:
//
//   POST /:id/suggest-sensitivity → asks Claude to classify the
//     asset from its metadata (name, description, systemType,
//     columns). Returns an array of {tag, confidence, reason} —
//     NOT persisted. The client renders one chip per suggestion
//     with accept/reject buttons.
//
//   PUT /:id/sensitivity → replaces the asset's sensitivityTags
//     array with what the user accepted. Validated against the
//     canonical SENSITIVITY_TAGS set so a rogue client can't
//     write arbitrary strings.
//
// Delete-all: PUT with `tags: []` clears the asset back to
// untagged. There is no separate DELETE endpoint — one PUT
// route is the durable API.

/**
 * GET /api/v1/data-assets/:id/impact
 *
 * "What breaks if this asset changes?" A change-management view over
 * the same catalog data the 360 endpoint reads, but framed as a
 * blast-radius answer rather than an informational lookup.
 *
 * Response shape:
 *   summary — headline counts (activities, processes, value streams,
 *             people to notify).
 *   activities — every activity that consumes or produces the asset,
 *                each with its ancestor breadcrumb + linkType + the
 *                owner and responsible person on that activity.
 *   people — de-duped notify list: for each affected person we record
 *            the *roles* they hold that make them relevant, so a
 *            reviewer can see "Susan Chen — Domain owner (Customer
 *            Data), Responsible on 2 activities" in one line.
 *   domain — the domain owner + stewards (they always need to know).
 */
router.get('/:id/impact', async (req: Request, res: Response) => {
  const asset = await dataAssetsRepo.get(String(req.params.id));
  if (!asset) { res.status(404).json({ success: false, error: 'Data asset not found' }); return; }
  if (!assertOrgAccess(req, res, asset.orgId, 'Data asset not found')) return;

  const [allProcessNodes, allMappings, allPeople, allDomains] = await Promise.all([
    processNodesRepo().list(),
    mappingsRepo().list(),
    peopleRepo().list(),
    dataDomainsRepo().list(),
  ]);

  // Build a per-node ancestor breadcrumb.
  const breadcrumb = (nodeId: string): string => {
    const node = allProcessNodes.find((n) => n.id === nodeId);
    if (!node) return nodeId;
    const parts: string[] = [node.name];
    let cur = node;
    while (cur.parentId) {
      const p = allProcessNodes.find((n) => n.id === cur.parentId);
      if (!p) break;
      parts.unshift(p.name);
      cur = p;
    }
    return parts.join(' > ');
  };

  const findValueStreamName = (nodeId: string): string | null => {
    const node = allProcessNodes.find((n) => n.id === nodeId);
    if (!node) return null;
    let cur = node;
    while (cur.parentId) {
      const p = allProcessNodes.find((n) => n.id === cur.parentId);
      if (!p) break;
      cur = p;
    }
    return cur.level === 'VALUE_STREAM' ? cur.name : null;
  };

  const findProcessName = (nodeId: string): string | null => {
    const node = allProcessNodes.find((n) => n.id === nodeId);
    if (!node) return null;
    let cur: typeof node | undefined = node;
    while (cur && cur.level !== 'PROCESS') {
      cur = cur.parentId ? allProcessNodes.find((n) => n.id === cur!.parentId) : undefined;
    }
    return cur ? cur.name : null;
  };

  // Every mapping row that references this asset.
  const relevant = allMappings.filter((m) => m.dataAssetId === asset.id);
  const activityRows = relevant.map((m) => {
    const node = allProcessNodes.find((n) => n.id === m.processStepId);
    const owner = node?.ownerId ? allPeople.find((p) => p.id === node.ownerId) : null;
    const responsible = node?.responsiblePersonId ? allPeople.find((p) => p.id === node.responsiblePersonId) : null;
    return {
      id: node?.id || m.processStepId,
      name: node?.name || m.processStepId,
      breadcrumb: breadcrumb(m.processStepId),
      valueStream: findValueStreamName(m.processStepId),
      process: findProcessName(m.processStepId),
      linkType: m.linkType,
      owner: owner ? { id: owner.id, name: owner.name } : null,
      responsible: responsible ? { id: responsible.id, name: responsible.name } : null,
    };
  });

  // Domain owners and stewards always need to know about changes to
  // assets in their domain.
  const domain = allDomains.find((d) => d.dataAssetIds && d.dataAssetIds.includes(asset.id));
  const domainOwner = domain?.ownerId ? allPeople.find((p) => p.id === domain.ownerId) : null;
  const domainStewards = ((domain?.stewardIds) || [])
    .map((sid) => allPeople.find((p) => p.id === sid))
    .filter(Boolean) as Array<{ id: string; name: string }>;

  // The asset's own owner / stewards (if set at the asset level).
  const assetOwner = asset.ownerPersonId ? allPeople.find((p) => p.id === asset.ownerPersonId) : null;
  const assetStewards = (asset.stewardIds || [])
    .map((sid) => allPeople.find((p) => p.id === sid))
    .filter(Boolean) as Array<{ id: string; name: string }>;

  // Aggregate the people-to-notify list with role provenance. Roles
  // deduped per person so someone who's responsible on two activities
  // reads as "Responsible on 2 activities" rather than two entries.
  const peopleMap = new Map<string, { id: string; name: string; roles: Map<string, number> }>();
  const stampRole = (person: { id: string; name: string } | null | undefined, roleLabel: string) => {
    if (!person) return;
    const existing = peopleMap.get(person.id) || { id: person.id, name: person.name, roles: new Map() };
    existing.roles.set(roleLabel, (existing.roles.get(roleLabel) || 0) + 1);
    peopleMap.set(person.id, existing);
  };
  if (assetOwner) stampRole(assetOwner, 'Asset owner');
  for (const s of assetStewards) stampRole(s, 'Asset steward');
  if (domainOwner) stampRole(domainOwner, `Domain owner (${domain!.name})`);
  for (const s of domainStewards) stampRole(s, `Domain steward (${domain!.name})`);
  for (const a of activityRows) {
    stampRole(a.owner, 'Activity owner');
    stampRole(a.responsible, 'Responsible on activity');
  }

  const peopleList = Array.from(peopleMap.values()).map((p) => ({
    id: p.id,
    name: p.name,
    roles: Array.from(p.roles.entries()).map(([label, count]) => count > 1 ? `${label} × ${count}` : label),
  }));

  const uniqueProcessIds = new Set(activityRows.map((a) => a.process).filter(Boolean));
  const uniqueVsIds = new Set(activityRows.map((a) => a.valueStream).filter(Boolean));

  res.json({
    success: true,
    data: {
      summary: {
        activityCount: activityRows.length,
        processCount: uniqueProcessIds.size,
        valueStreamCount: uniqueVsIds.size,
        peopleCount: peopleList.length,
      },
      activities: activityRows,
      people: peopleList,
      domain: domain ? {
        id: domain.id,
        name: domain.name,
        owner: domainOwner ? { id: domainOwner.id, name: domainOwner.name } : null,
        stewards: domainStewards,
      } : null,
    },
  });
});

// Which regulatory regimes are active for an org — walk up to the first
// ancestor that has an explicit config; unset (JSON never-configured) = all
// active (back-compat). Universal data-sensitivity tags are never gated.
function activeRegimesForOrg(orgId: string | undefined): Set<string> {
  const all = new Set<string>(REGULATORY_SENSITIVITY_TAGS as readonly string[]);
  if (!orgId) return all;
  const orgs = getCachedOrgList();
  let cur = orgs.find((o) => o.id === orgId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    const regimes = (cur as { activeSensitivityRegimes?: string[] }).activeSensitivityRegimes;
    if (Array.isArray(regimes)) return new Set(regimes);
    cur = cur.parentId ? orgs.find((o) => o.id === cur!.parentId) : undefined;
  }
  return all;
}

// Drop regulatory tags that aren't active for the org; keep every universal
// data-sensitivity tag untouched.
function filterTagsByRegime<T extends string>(tags: readonly T[], orgId: string | undefined): T[] {
  const regSet = new Set<string>(REGULATORY_SENSITIVITY_TAGS as readonly string[]);
  const active = activeRegimesForOrg(orgId);
  return tags.filter((t) => !regSet.has(t) || active.has(t));
}

/** POST /api/v1/data-assets/:id/suggest-sensitivity */
router.post('/:id/suggest-sensitivity', requireAiEnabled, enforceAiBudget, async (req: Request, res: Response) => {
  const asset = await dataAssetsRepo.get(String(req.params.id));
  if (!asset) { res.status(404).json({ success: false, error: 'Data asset not found' }); return; }
  if (!assertOrgAccess(req, res, asset.orgId, 'Data asset not found')) return;
  const [allColumns, allSystems] = await Promise.all([
    dataAssetColumnsRepo.list(),
    systemsRepo().list(),
  ]);
  const cols = allColumns
    .filter((c) => c.dataAssetId === asset.id)
    .map((c) => ({ name: c.columnName, dataType: c.dataType, description: c.description }));
  const system = asset.systemId ? allSystems.find((s) => s.id === asset.systemId) : undefined;
  try {
    const suggestions = await aiService.suggestAssetSensitivity({
      name: asset.name,
      description: asset.description,
      systemType: system?.systemType,
      columns: cols,
    });
    // Drop any regulatory regime the tenant has turned off, so the classifier
    // never suggests a tag the org can't apply.
    const activeTags = new Set<string>(filterTagsByRegime(SENSITIVITY_TAGS, asset.orgId));
    const filtered = Array.isArray(suggestions)
      ? (suggestions as Array<{ tag?: string }>).filter((s) => typeof s?.tag === 'string' && activeTags.has(s.tag))
      : suggestions;
    res.json({ success: true, data: filtered });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'AI classification failed.';
    logger.error({ err, assetId: asset.id }, 'Sensitivity classification failed');
    res.status(502).json({ success: false, error: `Sensitivity classification failed: ${msg}` });
  }
});

/** PUT /api/v1/data-assets/:id/sensitivity */
router.put('/:id/sensitivity', async (req: Request, res: Response) => {
  const asset = await dataAssetsRepo.get(String(req.params.id));
  if (!asset) { res.status(404).json({ success: false, error: 'Data asset not found' }); return; }
  if (!assertOrgAccess(req, res, asset.orgId, 'Data asset not found')) return;
  const parsed = putSensitivityBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'tags must be an array of sensitivity tag strings.' });
    return;
  }
  const { tags } = parsed.data;
  const validSet = new Set<string>(SENSITIVITY_TAGS);
  const regSet = new Set<string>(REGULATORY_SENSITIVITY_TAGS as readonly string[]);
  const activeRegimes = activeRegimesForOrg(asset.orgId);
  const clean: SensitivityTag[] = [];
  for (const t of tags) {
    if (typeof t !== 'string' || !validSet.has(t)) {
      res.status(400).json({ success: false, error: `Unknown sensitivity tag: ${String(t)}. Valid: ${SENSITIVITY_TAGS.join(', ')}` });
      return;
    }
    if (regSet.has(t) && !activeRegimes.has(t)) {
      res.status(400).json({ success: false, error: `Classification regime "${t}" is not active for this tenant. An org admin can enable it in Settings.` });
      return;
    }
    if (!clean.includes(t as SensitivityTag)) clean.push(t as SensitivityTag);
  }
  const previous = asset.sensitivityTags || [];
  asset.sensitivityTags = clean.length > 0 ? clean : undefined;
  asset.updatedAt = new Date().toISOString();
  await dataAssetsRepo.update(asset.id, asset);
  auditService.log(asset.orgId, null, 'DataAsset', asset.id, 'SENSITIVITY_UPDATED', { sensitivityTags: previous }, { sensitivityTags: clean });
  res.json({ success: true, data: { id: asset.id, sensitivityTags: clean } });
});

export default router;
