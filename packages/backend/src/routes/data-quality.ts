import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { loadStore, registerStore } from '../lib/persistence';
import { scopeListForRequest, assertOrgAccess } from '../lib/tenant-scope';
import { startBackgroundSweep } from '../lib/background-timer';
import { auditService } from '../services/audit.service';
import logger from '../lib/logger';
import { getDataQualityRulesRepository } from '../db/data-quality-rules.repo';
import { getDataAssetsRepository } from '../db/data-assets.repo';
import { getConnectionsRepository } from '../db/connections.repo';
import { getDataAssetBindingsRepository } from '../db/data-asset-bindings.repo';
import { getDataAssetColumnsRepository } from '../db/data-asset-columns.repo';
import { dataAssets, dataAssetBindings, dataAssetColumns, StoredDataAsset, StoredDataAssetBinding } from './data-assets';
import { connections, ConnectionProfile } from './connections';
import { syncDataQualityIssueForRule } from './governance-issues';
import { measureRuleOverDb } from '../services/dq-db';
import { decryptCredentials } from '../services/connection-secrets';
import {
  evaluateRule,
  rollupAssetHealth,
  suggestTemplates,
  describeRule,
  RULE_TEMPLATES,
  RuleType,
  RuleParameters,
  RuleRunResult,
  DescribeContext,
} from '../services/dq-engine';
import { countMeasuredRulesByAsset } from '../lib/asset-health';

export interface DataQualityRule {
  id: string;
  orgId: string;
  dataAssetId: string;
  // Optional: when set, the rule targets a specific column within the
  // asset. When null/undefined, it targets the asset as a whole (legacy
  // behaviour). New rules should always target a column.
  columnId?: string;
  columnName?: string; // denormalised for display; set from the column record at creation time
  dimension: 'COMPLETENESS' | 'ACCURACY' | 'TIMELINESS' | 'CONSISTENCY' | 'UNIQUENESS' | 'VALIDITY';
  name: string;
  description: string;
  threshold: number;
  currentScore: number;
  weight: number;
  status: 'PASSING' | 'FAILING' | 'WARNING' | 'NOT_MEASURED';
  lastMeasured: string | null;
  // Typed-rule extensions. Older rules (without these) still work as
  // manual "set a score" rows; new rules created from templates carry a
  // concrete ruleType + params and can be executed by the DQ engine.
  ruleType?: RuleType;
  parameters?: RuleParameters;
  lastRun?: RuleRunResult;
  // Stable id of the OOTB template this rule was created from (e.g.
  // 'not-null', 'regex-email'). Empty / undefined when the rule was
  // hand-built via the CUSTOM template or migrated from legacy data.
  // Used to hide already-used templates from the templates list.
  templateId?: string;
  // Schedule — when set, a backend tick auto-runs this rule on the
  // chosen cadence and updates `nextRunAt`. 'NEVER' (or undefined) is
  // a manual-only rule.
  scheduleFrequency?: 'NEVER' | 'HOURLY' | 'DAILY' | 'WEEKLY';
  nextRunAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

const VALID_RULE_TYPES: RuleType[] = [
  'NOT_NULL', 'UNIQUE', 'REGEX_MATCH', 'IN_SET', 'NUMERIC_RANGE', 'LENGTH_RANGE', 'CUSTOM',
];

const VALID_SCHEDULE_FREQUENCIES = ['NEVER', 'HOURLY', 'DAILY', 'WEEKLY'] as const;
type ScheduleFrequency = typeof VALID_SCHEDULE_FREQUENCIES[number];

/**
 * Roll the `nextRunAt` timestamp forward by one cadence interval. Returns
 * an ISO string. NEVER yields null (meaning "do not auto-run").
 *
 * Cadences are deliberately wall-clock simple: from `from`, advance by
 * one hour / day / week. No timezone arithmetic.
 */
function computeNextRunAt(freq: ScheduleFrequency, from: string | Date): string | null {
  if (freq === 'NEVER') return null;
  const fromDate = typeof from === 'string' ? new Date(from) : from;
  const ms =
    freq === 'HOURLY' ? 60 * 60 * 1000 :
    freq === 'DAILY' ? 24 * 60 * 60 * 1000 :
    freq === 'WEEKLY' ? 7 * 24 * 60 * 60 * 1000 :
    0;
  return new Date(fromDate.getTime() + ms).toISOString();
}

/** Resolve an asset's primary binding from a pre-loaded binding list —
 *  a store-agnostic mirror of data-assets' getPrimaryBinding so this
 *  route can work off a Postgres snapshot instead of the module array. */
function primaryBindingFrom(bindings: StoredDataAssetBinding[], assetId: string): StoredDataAssetBinding | undefined {
  const own = bindings.filter((b) => b.dataAssetId === assetId);
  return own.find((b) => b.isPrimary) || own[0];
}

/**
 * Build the DescribeContext for a rule by looking up its Data Asset and the
 * source connection in the supplied (already-loaded) snapshots. Returns an
 * empty context when the asset / connection can't be resolved so
 * placeholders are used in the rendered definition. Kept synchronous — the
 * caller loads the stores once and passes them in, so a per-rule enrich
 * loop doesn't fan out into N round-trips.
 */
function contextForRule(
  rule: DataQualityRule,
  assets: StoredDataAsset[],
  conns: ConnectionProfile[],
  bindings: StoredDataAssetBinding[],
): DescribeContext {
  const asset = assets.find((a) => a.id === rule.dataAssetId);
  if (!asset) return {};
  // Prefer the asset's primary binding. Fall back to the legacy shadow
  // fields (`asset.sourceConnectionId` etc.) so pre-binding rows still
  // resolve correctly until they're migrated.
  const binding = primaryBindingFrom(bindings, asset.id);
  const connId = binding?.connectionId || asset.sourceConnectionId;
  const conn = connId ? conns.find((c) => c.id === connId) : undefined;
  return {
    connectionType: conn?.connectionType,
    storageType: conn?.config?.storageType,
    dbType: conn?.config?.dbType,
    sourceAsset: binding?.sourceAsset || asset.sourceAsset,
    sourceColumn: binding?.sourceColumn || asset.sourceColumn,
    originalFileName: conn?.config?.originalFileName,
  };
}

export const dataQualityRules: DataQualityRule[] = loadStore<DataQualityRule>('dataQualityRules');
registerStore('dataQualityRules', dataQualityRules);

// Repositories — read Postgres when DATABASE_URL is set, else the JSON
// arrays. This route owns dataQualityRules (CRUD + scheduler) and reads
// dataAssets / connections / bindings as foreign context.
const dataQualityRulesRepo = getDataQualityRulesRepository(dataQualityRules);
const dataAssetsRepo = getDataAssetsRepository(dataAssets);
const connectionsRepo = getConnectionsRepository(connections);
const dataAssetBindingsRepo = getDataAssetBindingsRepository(dataAssetBindings);
const dataAssetColumnsRepo = getDataAssetColumnsRepository(dataAssetColumns);
const DEV_ORG_ID = '00000000-0000-0000-0000-000000000010';

const QUALITY_DIMENSIONS = ['COMPLETENESS', 'ACCURACY', 'TIMELINESS', 'CONSISTENCY', 'UNIQUENESS', 'VALIDITY'];

function computeStatus(currentScore: number, threshold: number): DataQualityRule['status'] {
  if (currentScore >= threshold) return 'PASSING';
  if (currentScore >= threshold - 10) return 'WARNING';
  return 'FAILING';
}

/**
 * Measured (real, non-simulated) DQ rule count per asset id, across all
 * rules. Effective asset health is 0 unless an asset has ≥1 measured rule,
 * so display surfaces (dashboard, gaps, lists, AI context) call this to
 * derive the health they show. Reads through the repo so it's correct in
 * both Postgres and JSON modes.
 */
export async function measuredRuleCountsByAsset(): Promise<Map<string, number>> {
  const rules = await dataQualityRulesRepo.list();
  return countMeasuredRulesByAsset(rules);
}

const router = Router();

/** DELETE /api/v1/data-quality/all — delete all rules */
router.delete('/all', async (_req: Request, res: Response) => {
  const all = await dataQualityRulesRepo.list();
  const count = all.length;
  for (const rule of all) await dataQualityRulesRepo.delete(rule.id);
  auditService.log(DEV_ORG_ID, null, 'DataQualityRule', '*', 'DELETE_ALL', null, { count });
  logger.info({ count }, 'Deleted all data quality rules');
  res.json({ success: true, deleted: count });
});

/** GET /api/v1/data-quality — list all (support ?orgId= and ?dataAssetId= filters), enrich with asset name */
router.get('/', async (req: Request, res: Response) => {
  const { dataAssetId } = req.query;
  const [allRules, allAssets, allConns, allBindings] = await Promise.all([
    dataQualityRulesRepo.list(), dataAssetsRepo.list(), connectionsRepo.list(), dataAssetBindingsRepo.list(),
  ]);
  let filtered = scopeListForRequest(req, allRules);
  if (dataAssetId) filtered = filtered.filter((r) => r.dataAssetId === dataAssetId);

  const enriched = filtered.map((rule) => {
    const asset = allAssets.find((a) => a.id === rule.dataAssetId);
    const definition = rule.ruleType
      ? describeRule(rule.ruleType, rule.parameters || {}, contextForRule(rule, allAssets, allConns, allBindings))
      : null;
    return {
      ...rule,
      dataAssetName: asset?.name || '',
      definition,
    };
  });

  res.json({ success: true, data: enriched });
});

/** GET /api/v1/data-quality/summary — overall quality stats */
router.get('/summary', async (req: Request, res: Response) => {
  const allRules = await dataQualityRulesRepo.list();
  const filtered = scopeListForRequest(req, allRules);

  const totalRules = filtered.length;
  const passingCount = filtered.filter((r) => r.status === 'PASSING').length;
  const warningCount = filtered.filter((r) => r.status === 'WARNING').length;
  const failingCount = filtered.filter((r) => r.status === 'FAILING').length;
  const notMeasuredCount = filtered.filter((r) => r.status === 'NOT_MEASURED').length;

  // Avg score per dimension
  const dimensionStats: Record<string, { total: number; count: number; avg: number }> = {};
  for (const dim of QUALITY_DIMENSIONS) {
    const dimRules = filtered.filter((r) => r.dimension === dim);
    const total = dimRules.reduce((sum, r) => sum + r.currentScore, 0);
    const count = dimRules.length;
    dimensionStats[dim] = { total, count, avg: count > 0 ? Math.round(total / count) : 0 };
  }

  const avgScore = totalRules > 0
    ? Math.round(filtered.reduce((sum, r) => sum + r.currentScore, 0) / totalRules)
    : 0;

  res.json({
    success: true,
    data: {
      totalRules,
      passingCount,
      warningCount,
      failingCount,
      notMeasuredCount,
      avgScore,
      dimensionStats,
    },
  });
});

/** GET /api/v1/data-quality/by-asset/:assetId — all rules for a data asset */
router.get('/by-asset/:assetId', async (req: Request, res: Response) => {
  const { assetId } = req.params;
  const [allRules, allAssets, allConns, allBindings] = await Promise.all([
    dataQualityRulesRepo.list(), dataAssetsRepo.list(), connectionsRepo.list(), dataAssetBindingsRepo.list(),
  ]);
  const rules = allRules.filter((r) => r.dataAssetId === assetId);

  const enriched = rules.map((rule) => {
    const asset = allAssets.find((a) => a.id === rule.dataAssetId);
    const definition = rule.ruleType
      ? describeRule(rule.ruleType, rule.parameters || {}, contextForRule(rule, allAssets, allConns, allBindings))
      : null;
    return { ...rule, dataAssetName: asset?.name || '', definition };
  });

  res.json({ success: true, data: enriched });
});

/** POST /api/v1/data-quality/compute-health/:assetId — compute weighted health score */
router.post('/compute-health/:assetId', async (req: Request, res: Response) => {
  const { assetId } = req.params;
  const asset = await dataAssetsRepo.get(String(assetId));
  if (!asset) { res.status(404).json({ success: false, error: 'Data asset not found' }); return; }

  const allRules = await dataQualityRulesRepo.list();
  const rules = allRules.filter((r) => r.dataAssetId === assetId);
  if (rules.length === 0) {
    res.json({ success: true, data: { assetId, healthScore: asset.healthScore, rulesCount: 0, message: 'No rules defined for this asset' } });
    return;
  }

  // Roll up from MEASURED rules only — simulated runs carry a fabricated
  // pass rate and must not become the asset's real, app-wide healthScore.
  const rollup = rollupAssetHealth(rules);
  if (rollup.health !== null) {
    await dataAssetsRepo.update(asset.id, { healthScore: rollup.health, updatedAt: new Date().toISOString() });
  }

  res.json({
    success: true,
    data: {
      assetId,
      // When no measured rule exists, health is left as-is (connector
      // freshness / manual) — flagged 'estimated' so the UI can label it.
      healthScore: rollup.health ?? asset.healthScore,
      rulesCount: rules.length,
      measuredRuleCount: rollup.measuredCount,
      simulatedRuleCount: rollup.simulatedCount,
      estimated: rollup.health === null,
      ...(rollup.health === null
        ? { message: 'Health left unchanged — no measured (non-simulated) rule to base it on.' }
        : {}),
    },
  });
});

/**
 * GET /api/v1/data-quality/templates?column=<name>&assetId=<id>
 *
 * Returns the OOTB rule template catalog, split into `suggested` (templates
 * whose column-name heuristic matches the requested column) and `generic`
 * (applicable to any column). When `assetId` is provided each template
 * also carries a `definition` showing the concrete SQL / JS / pseudocode
 * that would run against the asset's bound source.
 *
 * IMPORTANT: must be declared before `GET /:id` — otherwise Express
 * matches this request against the `:id` route and returns a 404.
 */
router.get('/templates', async (req: Request, res: Response) => {
  const column = typeof req.query.column === 'string' ? req.query.column : undefined;
  const assetId = typeof req.query.assetId === 'string' ? req.query.assetId : undefined;
  const { suggested, generic } = suggestTemplates(column);

  // Resolve the describe context once if the caller provided an assetId.
  // Prefer the asset's primary binding (new model); fall back to the
  // legacy shadow fields for un-migrated rows.
  let ctx: DescribeContext = {};
  if (assetId) {
    const asset = await dataAssetsRepo.get(String(assetId));
    if (asset) {
      const [allConns, allBindings] = await Promise.all([
        connectionsRepo.list(), dataAssetBindingsRepo.list(),
      ]);
      const binding = primaryBindingFrom(allBindings, asset.id);
      const connId = binding?.connectionId || asset.sourceConnectionId;
      const conn = connId ? allConns.find((c) => c.id === connId) : undefined;
      ctx = {
        connectionType: conn?.connectionType,
        storageType: conn?.config?.storageType,
        dbType: conn?.config?.dbType,
        sourceAsset: binding?.sourceAsset || asset.sourceAsset,
        sourceColumn: binding?.sourceColumn || asset.sourceColumn,
        originalFileName: conn?.config?.originalFileName,
      };
    }
  }

  const project = (t: typeof RULE_TEMPLATES[number]) => ({
    id: t.id,
    ruleType: t.ruleType,
    dimension: t.dimension,
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    definition: describeRule(t.ruleType, t.parameters, ctx),
  });
  res.json({
    success: true,
    data: {
      suggested: suggested.map(project),
      generic: generic.map(project),
    },
  });
});

/** POST /api/v1/data-quality/run-all/:assetId — run every typed rule for an asset */
router.post('/run-all/:assetId', async (req: Request, res: Response) => {
  const { assetId } = req.params;
  const asset = await dataAssetsRepo.get(String(assetId));
  if (!asset) { res.status(404).json({ success: false, error: 'Data asset not found' }); return; }

  const allRules = await dataQualityRulesRepo.list();
  const assetRules = allRules.filter((r) => r.dataAssetId === assetId && r.ruleType);
  if (assetRules.length === 0) {
    res.json({ success: true, data: { ran: 0, results: [], assetHealth: asset.healthScore ?? 0 } });
    return;
  }

  const results: { ruleId: string; name: string; passRate: number; simulated: boolean; status: string }[] = [];
  let assetHealth = asset.healthScore ?? 0;
  for (const rule of assetRules) {
    const out = await runRuleNow(rule);
    if (out) {
      assetHealth = out.assetHealth;
      results.push({
        ruleId: rule.id,
        name: rule.name,
        passRate: out.engineResult.passRate,
        simulated: out.engineResult.simulated,
        status: rule.status,
      });
    }
  }

  res.json({
    success: true,
    data: {
      ran: results.length,
      results,
      assetHealth,
    },
  });
});

/** GET /api/v1/data-quality/:id */
router.get('/:id', async (req: Request, res: Response) => {
  const rule = await dataQualityRulesRepo.get(String(req.params.id));
  if (!rule) { res.status(404).json({ success: false, error: 'Quality rule not found' }); return; }
  if (!assertOrgAccess(req, res, rule.orgId, 'Quality rule not found')) return;
  res.json({ success: true, data: rule });
});

/** POST /api/v1/data-quality — create rule */
router.post('/', async (req: Request, res: Response) => {
  const { dataAssetId, columnId, dimension, name, description, threshold, currentScore, weight, orgId,
    ruleType, parameters, templateId, scheduleFrequency } = req.body;

  if (!dataAssetId || !name) {
    res.status(400).json({ success: false, error: 'dataAssetId and name are required' });
    return;
  }

  const validDimension = dimension && QUALITY_DIMENSIONS.includes(dimension) ? dimension : 'COMPLETENESS';
  const validThreshold = typeof threshold === 'number' ? Math.max(0, Math.min(100, threshold)) : 80;
  const validScore = typeof currentScore === 'number' ? Math.max(0, Math.min(100, currentScore)) : 0;
  const validWeight = typeof weight === 'number' ? Math.max(1, Math.min(10, weight)) : 5;
  const validRuleType: RuleType | undefined = ruleType && VALID_RULE_TYPES.includes(ruleType) ? ruleType : undefined;
  const validSchedule = VALID_SCHEDULE_FREQUENCIES.includes(scheduleFrequency) ? scheduleFrequency : 'NEVER';

  const status = validScore > 0 ? computeStatus(validScore, validThreshold) : 'NOT_MEASURED';

  // If no explicit orgId, inherit from the owning asset so rules always
  // live in the same tenant as the asset they measure.
  const ownerAsset = await dataAssetsRepo.get(dataAssetId);
  const resolvedOrgId = orgId || ownerAsset?.orgId || DEV_ORG_ID;

  // Resolve column name for display convenience (Postgres or JSON).
  let columnName: string | undefined;
  if (columnId) {
    const col = await dataAssetColumnsRepo.get(String(columnId));
    if (col) columnName = col.columnName;
  }

  const now = new Date().toISOString();
  const rule: DataQualityRule = {
    id: uuid(),
    orgId: resolvedOrgId,
    dataAssetId,
    ...(columnId ? { columnId } : {}),
    ...(columnName ? { columnName } : {}),
    dimension: validDimension,
    name,
    description: description || '',
    threshold: validThreshold,
    currentScore: validScore,
    weight: validWeight,
    status,
    lastMeasured: validScore > 0 ? now : null,
    ...(validRuleType ? { ruleType: validRuleType } : {}),
    ...(parameters && typeof parameters === 'object' ? { parameters } : {}),
    ...(typeof templateId === 'string' && templateId ? { templateId } : {}),
    scheduleFrequency: validSchedule,
    nextRunAt: validSchedule === 'NEVER' ? null : computeNextRunAt(validSchedule, now),
    createdAt: now,
    updatedAt: now,
  };

  await dataQualityRulesRepo.create(rule);
  auditService.log(rule.orgId, null, 'DataQualityRule', rule.id, 'CREATE', null, rule);
  res.status(201).json({ success: true, data: rule });
});

/** PUT /api/v1/data-quality/:id — update rule */
router.put('/:id', async (req: Request, res: Response) => {
  const rule = await dataQualityRulesRepo.get(String(req.params.id));
  if (!rule) { res.status(404).json({ success: false, error: 'Quality rule not found' }); return; }

  const { dataAssetId, columnId, dimension, name, description, threshold, currentScore, weight,
    ruleType, parameters, templateId, scheduleFrequency } = req.body;

  if (dataAssetId !== undefined) rule.dataAssetId = dataAssetId;
  // Re-target the rule to a specific column (or clear it back to asset-level).
  // Keep the denormalized columnName in sync so display + the connector plan
  // stay correct.
  if (columnId !== undefined) {
    if (columnId) {
      const col = await dataAssetColumnsRepo.get(String(columnId));
      rule.columnId = columnId;
      rule.columnName = col?.columnName;
    } else {
      rule.columnId = undefined;
      rule.columnName = undefined;
    }
  }
  if (dimension !== undefined && QUALITY_DIMENSIONS.includes(dimension)) rule.dimension = dimension;
  if (name !== undefined) rule.name = name;
  if (description !== undefined) rule.description = description;
  if (threshold !== undefined && typeof threshold === 'number') rule.threshold = Math.max(0, Math.min(100, threshold));
  if (weight !== undefined && typeof weight === 'number') rule.weight = Math.max(1, Math.min(10, weight));
  if (ruleType !== undefined && VALID_RULE_TYPES.includes(ruleType)) rule.ruleType = ruleType;
  if (parameters !== undefined && typeof parameters === 'object' && parameters !== null) rule.parameters = parameters;
  if (templateId !== undefined) rule.templateId = templateId || undefined;
  if (scheduleFrequency !== undefined && VALID_SCHEDULE_FREQUENCIES.includes(scheduleFrequency)) {
    rule.scheduleFrequency = scheduleFrequency;
    // Re-derive nextRunAt from "now" so the cadence starts fresh on
    // change. NEVER clears the schedule entirely.
    rule.nextRunAt = scheduleFrequency === 'NEVER' ? null : computeNextRunAt(scheduleFrequency, new Date());
  }

  if (currentScore !== undefined && typeof currentScore === 'number') {
    rule.currentScore = Math.max(0, Math.min(100, currentScore));
    rule.lastMeasured = new Date().toISOString();
    // Auto-compute status when score is updated
    rule.status = computeStatus(rule.currentScore, rule.threshold);
  }

  // Also recompute status if threshold changed but score didn't
  if (threshold !== undefined && currentScore === undefined && rule.currentScore > 0) {
    rule.status = computeStatus(rule.currentScore, rule.threshold);
  }

  rule.updatedAt = new Date().toISOString();
  await dataQualityRulesRepo.update(rule.id, {
    dataAssetId: rule.dataAssetId,
    columnId: rule.columnId,
    columnName: rule.columnName,
    dimension: rule.dimension,
    name: rule.name,
    description: rule.description,
    threshold: rule.threshold,
    currentScore: rule.currentScore,
    weight: rule.weight,
    status: rule.status,
    lastMeasured: rule.lastMeasured,
    ruleType: rule.ruleType,
    parameters: rule.parameters,
    templateId: rule.templateId,
    scheduleFrequency: rule.scheduleFrequency,
    nextRunAt: rule.nextRunAt,
    updatedAt: rule.updatedAt,
  });
  auditService.log(rule.orgId, null, 'DataQualityRule', rule.id, 'UPDATE', null, rule);
  res.json({ success: true, data: rule });
});

/** DELETE /api/v1/data-quality/:id */
router.delete('/:id', async (req: Request, res: Response) => {
  const removed = await dataQualityRulesRepo.get(String(req.params.id));
  if (!removed) { res.status(404).json({ success: false, error: 'Quality rule not found' }); return; }
  auditService.log(DEV_ORG_ID, null, 'DataQualityRule', removed.id, 'DELETE', removed, null);
  await dataQualityRulesRepo.delete(removed.id);
  res.status(204).send();
});

/**
 * POST /api/v1/data-quality/:id/run
 *
 * Execute the rule against its Data Asset's source. For assets imported
 * from a FILE_STORAGE/LOCAL connection column we read the uploaded file
 * and compute real pass/fail numbers; every other connection type returns
 * a clearly-labelled simulated result.
 */
router.post('/:id/run', async (req: Request, res: Response) => {
  const rule = await dataQualityRulesRepo.get(String(req.params.id));
  if (!rule) { res.status(404).json({ success: false, error: 'Quality rule not found' }); return; }
  if (!rule.ruleType) {
    res.status(400).json({ success: false, error: 'This rule has no ruleType — it was created as a manual score rather than a typed DQ rule.' });
    return;
  }

  const result = await runRuleNow(rule);
  if (!result) { res.status(404).json({ success: false, error: 'Linked data asset not found' }); return; }
  res.json({ success: true, data: result.engineResult });
});

/**
 * Execute a single rule against its asset, persist the result, advance
 * the schedule cursor if any, recompute the asset health score, and
 * audit the run. Used by both the manual /run route and the scheduler
 * tick so the side effects stay in one place.
 *
 * Returns null if the linked asset can't be found (orphaned rule).
 */
async function runRuleNow(rule: DataQualityRule): Promise<{ engineResult: RuleRunResult; assetHealth: number; assetHealthEstimated: boolean } | null> {
  const asset = await dataAssetsRepo.get(rule.dataAssetId);
  if (!asset) return null;

  // Resolve the connection from the asset's primary binding (bindings are the
  // source of truth), falling back to the legacy shadow field for un-migrated
  // rows.
  const binding = primaryBindingFrom(await dataAssetBindingsRepo.list(), asset.id);
  const connId = binding?.connectionId || asset.sourceConnectionId;
  const conn = connId ? await connectionsRepo.get(connId) : undefined;

  // Resolve the PHYSICAL column this rule measures. A column-targeted rule
  // (rule.columnId, the model going forward) reads that column's own
  // sourceColumn pointer — so each rule measures its own column instead of
  // every rule collapsing onto the single asset-level sourceColumn. Fall back,
  // in order, to the rule's denormalized columnName, then the binding/asset
  // single column, for legacy asset-level rules.
  let sourceColumn: string | undefined;
  if (rule.columnId) {
    const col = await dataAssetColumnsRepo.get(rule.columnId);
    sourceColumn = col?.sourceColumn || col?.columnName;
  }
  if (!sourceColumn) sourceColumn = rule.columnName || binding?.sourceColumn || asset.sourceColumn;

  // Real measurement over a direct-connect database: turn the rule into one
  // aggregate query and run it through the live driver layer (measured result
  // → feeds real asset health). Only the pushdown-safe rule types on a
  // configured supported engine qualify; a live-execution failure falls back
  // to the file / simulated path rather than corrupting health with a zero.
  let result: RuleRunResult | null = null;
  if (conn?.connectionType === 'DATABASE') {
    try {
      const cfg = conn.config as Record<string, unknown>;
      // Decrypt at-rest credentials before the live driver authenticates.
      const creds = await decryptCredentials(conn.credentials);
      result = await measureRuleOverDb(rule.ruleType!, rule.parameters || {}, {
        dbType: cfg?.dbType as string | undefined,
        host: cfg?.host as string | undefined,
        port: cfg?.port != null ? Number(cfg.port) : undefined,
        database: cfg?.database as string | undefined,
        schema: cfg?.schema as string | undefined,
        username: creds?.username,
        password: creds?.password,
        table: binding?.sourceAsset || asset.name,
        column: sourceColumn,
      });
    } catch (err) {
      logger.warn({ err, ruleId: rule.id }, 'Live DQ measurement failed; falling back to simulated');
    }
  }
  if (!result) {
    result = evaluateRule(rule.ruleType!, rule.parameters || {}, {
      connectionType: conn?.connectionType,
      storageType: conn?.config?.storageType,
      localFilePath: conn?.config?.localFilePath,
      sourceColumn,
      originalFileName: conn?.config?.originalFileName,
      assetId: asset.id,
      ruleId: rule.id,
    });
  }

  const outcome = await applyRuleResult(rule, result);
  logger.info({ ruleId: rule.id, simulated: result.simulated, passRate: result.passRate, totalRows: result.totalRows, assetHealthScore: outcome.assetHealth, assetHealthEstimated: outcome.assetHealthEstimated }, 'DQ rule run');
  return { engineResult: result, assetHealth: outcome.assetHealth, assetHealthEstimated: outcome.assetHealthEstimated };
}

/**
 * Persist a rule's run result and cascade its side effects: advance the
 * schedule cursor, recompute the owning asset's health from MEASURED rules
 * only (a simulated result never drives it — see rollupAssetHealth), audit
 * the run, and sync the governance issue. Shared by the local engine
 * (runRuleNow) and the connector-pushed path (recordConnectorRuleResults)
 * so both record identically. Safe when the asset is missing.
 */
async function applyRuleResult(
  rule: DataQualityRule,
  result: RuleRunResult,
): Promise<{ assetHealth: number; assetHealthEstimated: boolean }> {
  rule.lastRun = result;
  rule.currentScore = result.passRate;
  rule.lastMeasured = result.ranAt;
  rule.status = computeStatus(result.passRate, rule.threshold);
  rule.updatedAt = result.ranAt;
  if (rule.scheduleFrequency && rule.scheduleFrequency !== 'NEVER') {
    rule.nextRunAt = computeNextRunAt(rule.scheduleFrequency as ScheduleFrequency, result.ranAt);
  }
  await dataQualityRulesRepo.update(rule.id, {
    lastRun: rule.lastRun,
    currentScore: rule.currentScore,
    lastMeasured: rule.lastMeasured,
    status: rule.status,
    updatedAt: rule.updatedAt,
    nextRunAt: rule.nextRunAt,
  });

  const asset = await dataAssetsRepo.get(rule.dataAssetId);
  let assetHealth = 0;
  let assetHealthEstimated = true;
  if (asset) {
    const assetRules = (await dataQualityRulesRepo.list()).filter((r) => r.dataAssetId === asset.id);
    const rollup = rollupAssetHealth(assetRules);
    assetHealth = rollup.health ?? asset.healthScore;
    assetHealthEstimated = rollup.health === null;
    if (rollup.health !== null && asset.healthScore !== rollup.health) {
      await dataAssetsRepo.update(asset.id, { healthScore: rollup.health, updatedAt: result.ranAt });
    }
  }

  auditService.log(rule.orgId, null, 'DataQualityRule', rule.id, 'RUN', null, {
    simulated: result.simulated,
    passRate: result.passRate,
    totalRows: result.totalRows,
    assetHealthScore: assetHealth,
    assetHealthEstimated,
  });

  // Sync a governance issue for the rule's current state. Idempotent, and
  // wrapped so a governance hiccup doesn't take the DQ engine down.
  try { await syncDataQualityIssueForRule(rule); }
  catch (err) { logger.error({ err, ruleId: rule.id }, 'Failed to sync governance issue for DQ rule'); }

  return { assetHealth, assetHealthEstimated };
}

// ── Connector-side (on-prem) rule execution ──────────────────────────────
//
// The edge connector runs rules inside the customer network and pushes back
// aggregate pass/fail counts — a measured result (simulated: false) that
// feeds real asset health, without any row values leaving the host. These
// rule types push down to a single aggregate query cleanly across every
// bundled adapter; REGEX_MATCH (no portable engine support — SQL Server has
// no native regex) and CUSTOM (arbitrary code) stay on the file/dbt path.
export const CONNECTOR_SUPPORTED_RULE_TYPES: RuleType[] =
  ['NOT_NULL', 'UNIQUE', 'IN_SET', 'NUMERIC_RANGE', 'LENGTH_RANGE'];

export interface ConnectorRulePlanEntry {
  ruleId: string;
  /** Discovered asset name (schema.table) the connector matches to a source. */
  table: string;
  column: string;
  ruleType: RuleType;
  parameters: RuleParameters;
  /** The asset's system, so the connector can pick the source that owns it. */
  systemId: string | null;
}

/** The executable-rule plan for the assets a given connector discovered:
 *  supported, typed, column-targeted rules only. */
export async function listConnectorRulePlan(connectorId: string): Promise<ConnectorRulePlanEntry[]> {
  const assets = (await dataAssetsRepo.list())
    .filter((a) => (a as { lastSyncedByConnectorId?: string }).lastSyncedByConnectorId === connectorId);
  const byId = new Map(assets.map((a) => [a.id, a]));
  const supported = new Set(CONNECTOR_SUPPORTED_RULE_TYPES);
  const rules = (await dataQualityRulesRepo.list()).filter(
    (r) => byId.has(r.dataAssetId) && r.ruleType && supported.has(r.ruleType) && !!r.columnName,
  );
  // Resolve the real physical table/column from the binding + column rows, not
  // the business-facing asset/column names. The connector runs SQL, so it needs
  // the source table (binding.sourceAsset) and physical column
  // (DataAssetColumn.sourceColumn) — which differ from the business names when
  // an asset is a renamed concept over a physical table.
  const bindings = await dataAssetBindingsRepo.list();
  const columns = await dataAssetColumnsRepo.list();
  const colById = new Map(columns.map((c) => [c.id, c]));
  return rules.map((r) => {
    const a = byId.get(r.dataAssetId)!;
    const binding = primaryBindingFrom(bindings, a.id);
    const col = r.columnId ? colById.get(r.columnId) : undefined;
    return {
      ruleId: r.id,
      table: binding?.sourceAsset || a.name,
      column: col?.sourceColumn || r.columnName!,
      ruleType: r.ruleType!,
      parameters: r.parameters || {},
      systemId: (a as { systemId?: string }).systemId || null,
    };
  });
}

export interface ConnectorRuleResult {
  ruleId: string;
  totalRows: number;
  passCount: number;
  passRate?: number;
  ranAt?: string;
}

/** Record measured results the connector pushed for its own rules. Each
 *  becomes a non-simulated RuleRunResult that feeds real asset health. A
 *  result whose rule isn't on one of THIS connector's assets is skipped —
 *  a connector can only move health for the data it owns. */
export async function recordConnectorRuleResults(
  connector: { id: string; orgId: string },
  results: ConnectorRuleResult[],
): Promise<{ applied: number; skipped: number }> {
  const ownedAssetIds = new Set(
    (await dataAssetsRepo.list())
      .filter((a) => (a as { lastSyncedByConnectorId?: string }).lastSyncedByConnectorId === connector.id)
      .map((a) => a.id),
  );
  const ruleById = new Map((await dataQualityRulesRepo.list()).map((r) => [r.id, r]));

  let applied = 0;
  let skipped = 0;
  for (const r of results) {
    const rule = ruleById.get(r.ruleId);
    if (!rule || !ownedAssetIds.has(rule.dataAssetId)) { skipped++; continue; }

    const totalRows = Math.max(0, Math.floor(Number(r.totalRows) || 0));
    const passCount = Math.max(0, Math.min(totalRows, Math.floor(Number(r.passCount) || 0)));
    const passRate = typeof r.passRate === 'number'
      ? Math.max(0, Math.min(100, Math.round(r.passRate)))
      : (totalRows > 0 ? Math.round((passCount / totalRows) * 100) : 100);
    const ranAt = typeof r.ranAt === 'string' ? r.ranAt : new Date().toISOString();

    const result: RuleRunResult = {
      ranAt, simulated: false, totalRows, passCount,
      failCount: totalRows - passCount, passRate, failureSamples: [],
      message: 'Measured on-prem by the connector.',
    };
    await applyRuleResult(rule, result);
    applied++;
  }
  return { applied, skipped };
}

// ── Scheduler ────────────────────────────────────────────────────────────
//
// Tick once a minute. Runs any scheduled rule whose `nextRunAt` is in
// the past (or null/undefined for a freshly-scheduled rule that hasn't
// rolled forward yet). Skips legacy / typeless rules. The setInterval
// is unref'd so it doesn't keep test processes alive when the only
// thing pinning the event loop is the scheduler.
const SCHEDULER_TICK_MS = 60 * 1000;
async function tickScheduler(): Promise<void> {
  const now = new Date();
  const rules = await dataQualityRulesRepo.list();
  for (const rule of rules) {
    if (!rule.ruleType) continue;
    if (!rule.scheduleFrequency || rule.scheduleFrequency === 'NEVER') continue;
    const due = !rule.nextRunAt || new Date(rule.nextRunAt) <= now;
    if (!due) continue;
    try { await runRuleNow(rule); }
    catch (err) {
      logger.error({ err, ruleId: rule.id }, 'Scheduled DQ rule run failed');
    }
  }
}
startBackgroundSweep(() => { void tickScheduler(); }, SCHEDULER_TICK_MS, { leaderOnly: true });

export default router;
