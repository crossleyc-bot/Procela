import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { loadStore, saveStore, registerStore } from '../lib/persistence';
import { scopeListForRequest, assertOrgAccess } from '../lib/tenant-scope';
import { effectiveHealthScore } from '../lib/asset-health';
import { auditService } from '../services/audit.service';
import logger from '../lib/logger';
import { asyncHandler } from '../middleware/asyncHandler';
import type { AuthenticatedRequest } from '../middleware/auth';
import { processNodes } from './process-catalog';
import { dataAssets } from './data-assets';
import { people } from './people';
import { governancePolicies } from './governance-policies';
import { attachments } from './attachments';
import { getMappingsRepository } from '../db/mappings.repo';
import { getProcessNodesRepository } from '../db/process-nodes.repo';
import { getDataAssetsRepository } from '../db/data-assets.repo';
import { getPeopleRepository } from '../db/people.repo';
import { getGovernancePoliciesRepository } from '../db/governance-policies.repo';
import { getAttachmentsRepository } from '../db/attachments.repo';

// ── Types ──

// A mapping row connects a process activity to one of three target
// kinds — a Data Asset (operational I/O), a Policy / Governance
// Document (charter, standard, policy that the activity produces
// or consumes), or an Attachment (an uploaded file or URL bound
// to the same activity node). Exactly one of dataAssetId /
// policyId / attachmentId must be set; the others are undefined.
// Existing rows in storage only carry dataAssetId — they keep
// working unchanged.
export interface StoredMapping {
  id: string;
  orgId: string;
  processStepId: string;
  dataAssetId?: string;
  policyId?: string;
  attachmentId?: string;
  linkType: string;
  notes: string;
  aiSuggested: boolean;
  userOverridden: boolean;
  criticality?: 'REQUIRED' | 'OPTIONAL';
  dataFormat?: string;
  sla?: string;
  qualityRequirement?: string;
  /** Name of the expected input/output placeholder this mapping
   *  fulfills (taken verbatim from the parsed "In: a, b. Out: x." text
   *  on the process node). When set, the UI binds this mapping to the
   *  specific placeholder so the visible label can differ from the
   *  linked entity's name — e.g. "Business strategy" placeholder
   *  fulfilled by an attachment called "Q4 Strategy Plan.pdf". Falls
   *  back to fuzzy name matching when undefined. */
  fulfillsExpected?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export const mappings: StoredMapping[] = loadStore<StoredMapping>('mappings');
registerStore('mappings', mappings);

const mappingsRepo = getMappingsRepository(mappings);

// Lazy accessors for the foreign stores enrichment reads. In Postgres mode
// the in-memory arrays are empty and the Prisma repos are the source of
// truth, so enrichment lists through them once per request (see
// buildEnrichContext) and looks up by id from the resulting Maps.
let _processNodesRepo: ReturnType<typeof getProcessNodesRepository> | null = null;
const processNodesRepo = () => (_processNodesRepo ??= getProcessNodesRepository(processNodes));
let _dataAssetsRepo: ReturnType<typeof getDataAssetsRepository> | null = null;
const dataAssetsRepo = () => (_dataAssetsRepo ??= getDataAssetsRepository(dataAssets));
let _peopleRepo: ReturnType<typeof getPeopleRepository> | null = null;
const peopleRepo = () => (_peopleRepo ??= getPeopleRepository(people));
let _governancePoliciesRepo: ReturnType<typeof getGovernancePoliciesRepository> | null = null;
const governancePoliciesRepo = () => (_governancePoliciesRepo ??= getGovernancePoliciesRepository(governancePolicies));
let _attachmentsRepo: ReturnType<typeof getAttachmentsRepository> | null = null;
const attachmentsRepo = () => (_attachmentsRepo ??= getAttachmentsRepository(attachments));

const DEV_ORG_ID = '00000000-0000-0000-0000-000000000010';

const VALID_LINK_TYPES = ['consumes', 'produces', 'transforms', 'references'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The mappings.createdBy column is a Postgres `uuid`. Persist the
// authenticated user's id when it's a real uuid, otherwise '' — the
// repository maps a falsy value to NULL. Writing a non-uuid literal
// (the old 'dev-user' sentinel) makes the Postgres INSERT reject with
// "invalid input syntax for type uuid". On an un-wrapped async handler
// that rejection is swallowed by the global unhandledRejection safety
// net and the response is never sent, so the request hangs until the
// gateway times out (504). Both halves are fixed here: a valid actor
// id, and asyncHandler wrapping so any future write rejection returns a
// clean 500 instead of hanging.
function actorId(req: Request): string {
  const sub = (req as AuthenticatedRequest).user?.sub;
  return sub && UUID_RE.test(sub) ? sub : '';
}

// ── Helpers ──

// Pre-listed lookup Maps built once per handler and threaded through
// enrichMapping, so a response enriching N mappings issues a fixed set of
// list() calls instead of one find() per store per row.
interface EnrichContext {
  nodesById: Map<string, typeof processNodes[number]>;
  assetsById: Map<string, typeof dataAssets[number]>;
  peopleById: Map<string, typeof people[number]>;
  policiesById: Map<string, typeof governancePolicies[number]>;
  attachmentsById: Map<string, typeof attachments[number]>;
  /** Measured (non-simulated) DQ rule count per asset id — drives the
   *  effective (measured-or-0) health a mapping row reports for its asset. */
  measuredHealthByAsset: Map<string, number>;
}

async function buildEnrichContext(): Promise<EnrichContext> {
  const [nodes, assets, ppl, policies, atts, measuredHealthByAsset] = await Promise.all([
    processNodesRepo().list(),
    dataAssetsRepo().list(),
    peopleRepo().list(),
    governancePoliciesRepo().list(),
    attachmentsRepo().list(),
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (require('./data-quality') as typeof import('./data-quality')).measuredRuleCountsByAsset(),
  ]);
  return {
    nodesById: new Map(nodes.map((n) => [n.id, n])),
    assetsById: new Map(assets.map((a) => [a.id, a])),
    peopleById: new Map(ppl.map((p) => [p.id, p])),
    policiesById: new Map(policies.map((p) => [p.id, p])),
    attachmentsById: new Map(atts.map((a) => [a.id, a])),
    measuredHealthByAsset,
  };
}

function findStepInfo(stepId: string, ctx: EnrichContext) {
  const node = ctx.nodesById.get(stepId);
  if (!node) return null;

  // Build ancestry path
  const path: string[] = [node.name];
  let current = node;
  while (current.parentId) {
    const parent = ctx.nodesById.get(current.parentId);
    if (!parent) break;
    path.unshift(parent.name);
    current = parent;
  }

  return {
    stepId: node.id,
    stepName: node.name,
    level: node.level,
    activityId: node.activityId,
    path: path.join(' > '),
  };
}

function findAssetInfo(assetId: string | undefined, ctx: EnrichContext) {
  if (!assetId) return null;
  const asset = ctx.assetsById.get(assetId);
  if (!asset) return null;
  const owner = asset.owner ? ctx.peopleById.get(asset.owner) : null;
  const stewardIds = asset.stewardIds || [];
  const stewardName = stewardIds
    .map((sid) => ctx.peopleById.get(sid)?.name)
    .filter(Boolean)
    .join(', ') || null;
  return {
    assetId: asset.id,
    assetName: asset.name,
    assetDescription: asset.description,
    governanceTier: asset.governanceTier,
    healthScore: effectiveHealthScore(asset.healthScore, ctx.measuredHealthByAsset.get(asset.id) || 0),
    ownerName: owner?.name || null,
    stewardName,
  };
}

function findPolicyInfo(policyId: string | undefined, ctx: EnrichContext) {
  if (!policyId) return null;
  const policy = ctx.policiesById.get(policyId);
  if (!policy) return null;
  return {
    policyId: policy.id,
    policyName: policy.name,
    policyCode: policy.code,
    documentType: policy.documentType,
    status: policy.status,
  };
}

function findAttachmentInfo(attachmentId: string | undefined, ctx: EnrichContext) {
  if (!attachmentId) return null;
  const att = ctx.attachmentsById.get(attachmentId);
  if (!att) return null;
  return {
    attachmentId: att.id,
    name: att.name,
    type: att.type,
    fileName: att.fileName,
    url: att.url,
    mimeType: att.mimeType,
    fileSize: att.fileSize,
  };
}

function enrichMapping(m: StoredMapping, ctx: EnrichContext) {
  return {
    ...m,
    stepInfo: findStepInfo(m.processStepId, ctx),
    assetInfo: findAssetInfo(m.dataAssetId, ctx),
    policyInfo: findPolicyInfo(m.policyId, ctx),
    attachmentInfo: findAttachmentInfo(m.attachmentId, ctx),
  };
}

const router = Router();

/** DELETE /api/v1/mappings/all — delete all mappings. */
router.delete('/all', asyncHandler(async (_req: Request, res: Response) => {
  const ids = (await mappingsRepo.list()).map((m) => m.id);
  const count = ids.length;
  for (const id of ids) {
    await mappingsRepo.delete(id);
  }
  auditService.log(DEV_ORG_ID, null, 'Mapping', '*', 'DELETE_ALL', null, { count });
  logger.info({ count }, 'Deleted all mappings');
  res.json({ success: true, deleted: count });
}));

/** GET /api/v1/mappings */
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const filtered = scopeListForRequest(req, await mappingsRepo.list());
  const ctx = await buildEnrichContext();
  const enriched = filtered.map((m) => enrichMapping(m, ctx));
  res.json({ success: true, data: enriched });
}));

/** GET /api/v1/mappings/by-step/:stepId */
router.get('/by-step/:stepId', asyncHandler(async (req: Request, res: Response) => {
  const filtered = (await mappingsRepo.list()).filter((m) => m.processStepId === req.params.stepId);
  const ctx = await buildEnrichContext();
  res.json({ success: true, data: filtered.map((m) => enrichMapping(m, ctx)) });
}));

/** GET /api/v1/mappings/by-asset/:assetId */
router.get('/by-asset/:assetId', asyncHandler(async (req: Request, res: Response) => {
  const filtered = (await mappingsRepo.list()).filter((m) => m.dataAssetId === req.params.assetId);
  const ctx = await buildEnrichContext();
  res.json({ success: true, data: filtered.map((m) => enrichMapping(m, ctx)) });
}));

/** POST /api/v1/mappings */
router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const { processStepId, dataAssetId, policyId, attachmentId, linkType, notes, aiSuggested, orgId,
    criticality, dataFormat, sla, qualityRequirement, fulfillsExpected } = req.body;

  if (!processStepId) {
    res.status(400).json({ success: false, error: 'processStepId is required' });
    return;
  }
  // Exactly one target kind must be provided. Three nullable
  // fields beat one polymorphic "targetType + targetId" because
  // existing rows already speak dataAssetId.
  const targets = [dataAssetId, policyId, attachmentId].filter((t) => typeof t === 'string' && t);
  if (targets.length === 0) {
    res.status(400).json({ success: false, error: 'One of dataAssetId, policyId, or attachmentId is required' });
    return;
  }
  if (targets.length > 1) {
    res.status(400).json({ success: false, error: 'A mapping row can target only one of dataAssetId / policyId / attachmentId, not multiple' });
    return;
  }
  if (linkType && !VALID_LINK_TYPES.includes(linkType)) {
    res.status(400).json({ success: false, error: `linkType must be one of: ${VALID_LINK_TYPES.join(', ')}` });
    return;
  }

  const now = new Date().toISOString();
  const mapping: StoredMapping = {
    id: uuid(),
    orgId: orgId || DEV_ORG_ID,
    processStepId,
    ...(dataAssetId ? { dataAssetId } : {}),
    ...(policyId ? { policyId } : {}),
    ...(attachmentId ? { attachmentId } : {}),
    linkType: linkType || 'references',
    notes: notes || '',
    aiSuggested: aiSuggested === true,
    userOverridden: false,
    ...(criticality ? { criticality } : {}),
    ...(dataFormat ? { dataFormat } : {}),
    ...(sla ? { sla } : {}),
    ...(qualityRequirement ? { qualityRequirement } : {}),
    ...(typeof fulfillsExpected === 'string' && fulfillsExpected.trim()
      ? { fulfillsExpected: fulfillsExpected.trim() } : {}),
    createdBy: actorId(req),
    createdAt: now,
    updatedAt: now,
  };
  await mappingsRepo.create(mapping);
  res.status(201).json({ success: true, data: enrichMapping(mapping, await buildEnrichContext()) });
}));

/** PUT /api/v1/mappings/:id */
router.put('/:id', asyncHandler(async (req: Request, res: Response) => {
  const mapping = (await mappingsRepo.list()).find((m) => m.id === req.params.id);
  if (!mapping) {
    res.status(404).json({ success: false, error: 'Mapping not found' });
    return;
  }
  if (!assertOrgAccess(req, res, mapping.orgId, 'Mapping not found')) return;

  const { processStepId, dataAssetId, linkType, notes, aiSuggested, userOverridden,
    criticality, dataFormat, sla, qualityRequirement, fulfillsExpected } = req.body;
  if (processStepId !== undefined) mapping.processStepId = processStepId;
  if (dataAssetId !== undefined) mapping.dataAssetId = dataAssetId;
  if (linkType !== undefined) {
    if (!VALID_LINK_TYPES.includes(linkType)) {
      res.status(400).json({ success: false, error: `linkType must be one of: ${VALID_LINK_TYPES.join(', ')}` });
      return;
    }
    mapping.linkType = linkType;
  }
  if (notes !== undefined) mapping.notes = notes;
  if (aiSuggested !== undefined) mapping.aiSuggested = aiSuggested === true;
  if (userOverridden !== undefined) mapping.userOverridden = userOverridden === true;
  if (criticality !== undefined) mapping.criticality = criticality || undefined;
  if (dataFormat !== undefined) mapping.dataFormat = dataFormat || undefined;
  if (sla !== undefined) mapping.sla = sla || undefined;
  if (qualityRequirement !== undefined) mapping.qualityRequirement = qualityRequirement || undefined;
  if (fulfillsExpected !== undefined) {
    // Empty string / null clears the tag so a mapping can be detached
    // from a placeholder and fall back to fuzzy-match behaviour.
    const v = typeof fulfillsExpected === 'string' ? fulfillsExpected.trim() : '';
    mapping.fulfillsExpected = v || undefined;
  }
  mapping.updatedAt = new Date().toISOString();
  await mappingsRepo.update(mapping.id, mapping);
  res.json({ success: true, data: enrichMapping(mapping, await buildEnrichContext()) });
}));

/** DELETE /api/v1/mappings/:id */
router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  const mapping = (await mappingsRepo.list()).find((m) => m.id === req.params.id);
  if (!mapping) {
    res.status(404).json({ success: false, error: 'Mapping not found' });
    return;
  }
  if (!assertOrgAccess(req, res, mapping.orgId, 'Mapping not found')) return;
  await mappingsRepo.delete(mapping.id);
  res.status(204).send();
}));

export default router;
