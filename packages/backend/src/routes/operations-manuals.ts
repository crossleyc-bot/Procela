import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { auditService } from '../services/audit.service';
import { loadStore, saveStore, registerStore } from '../lib/persistence';
import { scopeListForRequest, assertOrgAccess } from '../lib/tenant-scope';
import logger from '../lib/logger';
import { getOperationsManualsRepository } from '../db/operations-manuals.repo';
import { AuthenticatedRequest } from '../middleware/auth';
import { enforceAssignment, ownerOnCreate } from '../lib/assignment';

// ── Types ──

export interface StoredOperationsManual {
  id: string;
  orgId: string;
  roleType: string;
  label: string;
  purpose: string;
  daily: string[];
  weekly: string[];
  monthly: string[];
  quarterly: string[];
  escalation: string[];
  customContent: string;
  isCustom: boolean;
  // Layer-2 assignment anchor: the person who owns this manual. Nullable —
  // seeded standard manuals are org-wide reference content with no owner.
  ownerPersonId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const operationsManuals: StoredOperationsManual[] = loadStore<StoredOperationsManual>('operationsManuals');
registerStore('operationsManuals', operationsManuals);

const operationsManualsRepo = getOperationsManualsRepository(operationsManuals);

// ── Standard DAMA role templates ──

const STANDARD_MANUALS: Array<Omit<StoredOperationsManual, 'id' | 'orgId' | 'ownerPersonId' | 'createdAt' | 'updatedAt'>> = [
  {
    roleType: 'CDO',
    label: 'Chief Data Officer',
    purpose: 'Set strategy, own outcomes, secure resources, and represent data governance at the executive level.',
    daily: [
      'Review critical data quality alerts and high-severity incidents',
      'Scan open escalations in your queue',
    ],
    weekly: [
      'Meet with Data Governance Lead to review program health',
      'Review pending policy decisions and approvals',
      'Track progress against quarterly governance OKRs',
    ],
    monthly: [
      'Chair Data Governance Council meeting',
      'Report program metrics to executive leadership',
      'Review maturity dashboard and identify investment priorities',
      'Approve policy exceptions that meet escalation criteria',
    ],
    quarterly: [
      'Present governance scorecard to the board or executive committee',
      'Review and ratify governance strategy and roadmap',
      'Approve annual policy updates',
      'Sponsor cross-functional governance initiatives',
    ],
    escalation: [
      'Unresolved policy violations with regulatory implications → CEO and legal counsel',
      'Governance funding or resourcing gaps → CFO and executive committee',
      'Board-level concerns (regulator, audit, major incident) → Board risk committee',
    ],
    customContent: '',
    isCustom: false,
  },
  {
    roleType: 'DATA_GOVERNANCE_LEAD',
    label: 'Data Governance Lead',
    purpose: 'Run the governance program day to day — drive execution, measure progress, coach stewards.',
    daily: [
      'Triage new governance issues and assign owners',
      'Monitor steward activity and task completion',
      'Respond to steward questions and unblock work',
    ],
    weekly: [
      'Review stewardship team metrics',
      'Facilitate committee pre-reads and agendas',
      'Check policy review pipeline for upcoming reviews',
      'Update governance dashboard',
    ],
    monthly: [
      'Chair Data Governance Committee meeting',
      'Publish monthly governance report to the Council',
      'Coach underperforming stewardship teams',
      'Review program risks and mitigation plans',
    ],
    quarterly: [
      'Lead quarterly governance maturity review',
      'Refresh the governance roadmap with the CDO',
      'Evaluate steward performance and recognize contributors',
      'Plan the next quarter\'s governance initiatives',
    ],
    escalation: [
      'Policy violations or repeated quality failures → CDO',
      'Cross-domain decisions that can\'t be resolved → Governance Committee',
      'Resource or prioritization conflicts → CDO and affected business leads',
    ],
    customContent: '',
    isCustom: false,
  },
  {
    roleType: 'DATA_OWNER',
    label: 'Data Owner',
    purpose: 'Accountable for a data domain — set direction, approve changes, and own outcomes.',
    daily: [
      'Review critical quality alerts for your domain',
      'Approve urgent data access or usage requests',
    ],
    weekly: [
      'Sync with your Data Stewards on open issues',
      'Review domain health metrics',
      'Prioritize incoming governance requests',
    ],
    monthly: [
      'Attend the Governance Committee',
      'Review domain policies and their effectiveness',
      'Approve or deny policy exceptions within your domain',
      'Report domain metrics: quality, coverage, issues resolved',
    ],
    quarterly: [
      'Validate domain scope and boundaries',
      'Review steward assignments and propose changes',
      'Update domain roadmap and initiatives',
      'Present domain status to the Council',
    ],
    escalation: [
      'Cross-domain conflicts → Governance Committee',
      'Material domain risk → Governance Lead and CDO',
      'Regulatory concerns → Compliance and CDO',
    ],
    customContent: '',
    isCustom: false,
  },
  {
    roleType: 'BUSINESS_DATA_STEWARD',
    label: 'Business Data Steward',
    purpose: 'Day-to-day management of data quality, definitions, and issue resolution within your domain.',
    daily: [
      'Review data quality alerts for your assets',
      'Respond to questions from data consumers',
      'Progress open governance tasks',
    ],
    weekly: [
      'Attend stewardship team sync',
      'Review business glossary updates and approve new terms',
      'Close resolved issues and document outcomes',
      'Coordinate with Technical Stewards on remediation',
    ],
    monthly: [
      'Report domain quality trends to the Data Owner',
      'Validate metadata completeness and accuracy',
      'Review data asset classifications',
      'Update SOP documentation based on lessons learned',
    ],
    quarterly: [
      'Lead a quarterly data quality deep-dive for your domain',
      'Review and update data retention practices',
      'Participate in maturity assessment for your domain',
      'Propose new quality rules or controls',
    ],
    escalation: [
      'Quality issues that cross domains → Governance Committee',
      'Policy exceptions needed → Data Owner',
      'Resource constraints blocking remediation → Governance Lead',
    ],
    customContent: '',
    isCustom: false,
  },
  {
    roleType: 'TECHNICAL_DATA_STEWARD',
    label: 'Technical Data Steward',
    purpose: 'Technical implementation of governance — lineage, infrastructure, automation, and system-level quality.',
    daily: [
      'Monitor automated quality checks and pipelines',
      'Triage technical incidents affecting data availability',
      'Support business stewards with technical questions',
    ],
    weekly: [
      'Review data lineage updates and verify accuracy',
      'Audit access logs and flag anomalies',
      'Collaborate with Data Engineers on remediation',
      'Review system-level metrics (latency, uptime, error rates)',
    ],
    monthly: [
      'Report technical posture to the Data Owner',
      'Review infrastructure roadmap impact on governance',
      'Validate classification tags and data masking rules',
      'Update technical documentation',
    ],
    quarterly: [
      'Review data architecture alignment with governance policies',
      'Participate in security and privacy audits',
      'Plan technical debt reduction initiatives',
      'Evaluate new tools or automation opportunities',
    ],
    escalation: [
      'Infrastructure failures affecting governance → CDO and infrastructure lead',
      'Security or privacy concerns → CISO and privacy officer',
      'Tooling gaps blocking the program → Governance Lead',
    ],
    customContent: '',
    isCustom: false,
  },
  {
    roleType: 'DATA_QUALITY_ANALYST',
    label: 'Data Quality Analyst',
    purpose: 'Measure, report, and drive improvements in data quality across domains.',
    daily: [
      'Review overnight quality rule results',
      'Investigate quality incidents and document root causes',
    ],
    weekly: [
      'Publish weekly quality dashboard',
      'Coordinate remediation with stewards',
      'Refine quality rules based on false positives',
    ],
    monthly: [
      'Present monthly quality report to the Committee',
      'Audit critical data assets for quality drift',
      'Propose new quality rules based on trends',
    ],
    quarterly: [
      'Benchmark quality against industry standards',
      'Review and refresh quality KPIs',
      'Conduct deep-dive analysis on chronic quality issues',
    ],
    escalation: [
      'Systemic quality failures → Governance Committee',
      'Regulatory-impacting quality issues → CDO and Compliance',
    ],
    customContent: '',
    isCustom: false,
  },
  {
    roleType: 'DATA_ARCHITECT',
    label: 'Data Architect',
    purpose: 'Ensure data architecture aligns with governance principles and supports long-term scalability.',
    daily: [
      'Review architecture review board submissions',
      'Answer technical questions from stewards and engineers',
    ],
    weekly: [
      'Attend architecture review board',
      'Review lineage and integration changes',
      'Validate new data model designs',
    ],
    monthly: [
      'Report architecture alignment metrics',
      'Review and update reference architectures',
      'Assess impact of new technology adoption on governance',
    ],
    quarterly: [
      'Present architecture roadmap to the Committee',
      'Review and refresh data standards',
      'Lead cross-team architecture alignment sessions',
    ],
    escalation: [
      'Architecture decisions affecting multiple domains → Governance Committee',
      'Misalignment with governance principles → CDO',
    ],
    customContent: '',
    isCustom: false,
  },
];

// ── Router ──

const router = Router();

/** GET /api/v1/operations-manuals — list with ?orgId= filter */
router.get('/', async (req: Request, res: Response) => {
  const filtered = scopeListForRequest(req, await operationsManualsRepo.list());
  res.json({ success: true, data: filtered });
});

/** GET /api/v1/operations-manuals/:id — single manual */
router.get('/:id', async (req: Request, res: Response) => {
  const manual = await operationsManualsRepo.get(String(req.params.id));
  if (!manual) { res.status(404).json({ success: false, error: 'Operations manual not found' }); return; }
  if (!assertOrgAccess(req, res, manual.orgId, 'Operations manual not found')) return;
  res.json({ success: true, data: manual });
});

/** POST /api/v1/operations-manuals — create */
router.post('/', async (req: Request, res: Response) => {
  const { orgId, label, roleType, purpose, daily, weekly, monthly, quarterly, escalation, customContent, isCustom, ownerPersonId } = req.body;
  if (!orgId) { res.status(400).json({ success: false, error: 'orgId is required' }); return; }
  if (!label) { res.status(400).json({ success: false, error: 'label is required' }); return; }

  const now = new Date().toISOString();
  const manual: StoredOperationsManual = {
    id: uuid(),
    orgId,
    roleType: roleType || 'CUSTOM',
    label,
    purpose: purpose || '',
    daily: Array.isArray(daily) ? daily : [],
    weekly: Array.isArray(weekly) ? weekly : [],
    monthly: Array.isArray(monthly) ? monthly : [],
    quarterly: Array.isArray(quarterly) ? quarterly : [],
    escalation: Array.isArray(escalation) ? escalation : [],
    customContent: customContent || '',
    isCustom: isCustom !== undefined ? isCustom : true,
    // Layer-2: a CONTRIBUTOR who doesn't name an owner owns what they
    // create, so they can subsequently edit it.
    ownerPersonId: ownerOnCreate((req as AuthenticatedRequest).user, ownerPersonId),
    createdAt: now,
    updatedAt: now,
  };

  await operationsManualsRepo.create(manual);
  auditService.log(manual.orgId, null, 'OperationsManual', manual.id, 'CREATE', null, manual);
  logger.info({ manualId: manual.id, label: manual.label }, 'Created operations manual');
  res.status(201).json({ success: true, data: manual });
});

/** PUT /api/v1/operations-manuals/:id — update any fields */
router.put('/:id', async (req: Request, res: Response) => {
  const manual = await operationsManualsRepo.get(String(req.params.id));
  if (!manual) { res.status(404).json({ success: false, error: 'Operations manual not found' }); return; }

  // Layer-2: a CONTRIBUTOR may only edit manuals assigned to them.
  const putAssignErr = enforceAssignment((req as AuthenticatedRequest).user, manual);
  if (putAssignErr) { res.status(putAssignErr.statusCode).json({ success: false, error: putAssignErr.message }); return; }

  const before = { ...manual };
  const { label, roleType, purpose, daily, weekly, monthly, quarterly, escalation, customContent, isCustom, ownerPersonId } = req.body;

  if (label !== undefined) manual.label = label;
  if (roleType !== undefined) manual.roleType = roleType;
  if (purpose !== undefined) manual.purpose = purpose;
  if (daily !== undefined) manual.daily = Array.isArray(daily) ? daily : [];
  if (weekly !== undefined) manual.weekly = Array.isArray(weekly) ? weekly : [];
  if (monthly !== undefined) manual.monthly = Array.isArray(monthly) ? monthly : [];
  if (quarterly !== undefined) manual.quarterly = Array.isArray(quarterly) ? quarterly : [];
  if (escalation !== undefined) manual.escalation = Array.isArray(escalation) ? escalation : [];
  if (customContent !== undefined) manual.customContent = customContent;
  if (isCustom !== undefined) manual.isCustom = isCustom;
  if (ownerPersonId !== undefined) manual.ownerPersonId = ownerPersonId;

  manual.updatedAt = new Date().toISOString();
  await operationsManualsRepo.update(manual.id, manual);
  auditService.log(manual.orgId, null, 'OperationsManual', manual.id, 'UPDATE', before, manual);
  logger.info({ manualId: manual.id, label: manual.label }, 'Updated operations manual');
  res.json({ success: true, data: manual });
});

/** DELETE /api/v1/operations-manuals/:id */
router.delete('/:id', async (req: Request, res: Response) => {
  const removed = await operationsManualsRepo.get(String(req.params.id));
  if (!removed) { res.status(404).json({ success: false, error: 'Operations manual not found' }); return; }

  // Layer-2: a CONTRIBUTOR may only delete manuals assigned to them.
  const delAssignErr = enforceAssignment((req as AuthenticatedRequest).user, removed);
  if (delAssignErr) { res.status(delAssignErr.statusCode).json({ success: false, error: delAssignErr.message }); return; }

  auditService.log(removed.orgId, null, 'OperationsManual', removed.id, 'DELETE', removed, null);
  await operationsManualsRepo.delete(removed.id);
  logger.info({ manualId: removed.id, label: removed.label }, 'Deleted operations manual');
  res.status(204).send();
});

/** POST /api/v1/operations-manuals/seed — seed standard DAMA role manuals for an org (skip existing) */
router.post('/seed', async (req: Request, res: Response) => {
  const { orgId } = req.body;
  if (!orgId) { res.status(400).json({ success: false, error: 'orgId is required' }); return; }

  const now = new Date().toISOString();
  const created: StoredOperationsManual[] = [];
  const skipped: string[] = [];

  // Fetch the org's manuals once; STANDARD_MANUALS carry distinct
  // roleTypes so no intra-batch duplicate can slip past this pre-fetch.
  const existingForOrg = await operationsManualsRepo.list({ orgId });

  for (const tmpl of STANDARD_MANUALS) {
    const exists = existingForOrg.some((m) => m.roleType === tmpl.roleType);
    if (exists) { skipped.push(tmpl.label); continue; }

    const manual: StoredOperationsManual = {
      id: uuid(),
      orgId,
      ...tmpl,
      // Seeded standard manuals are org-wide reference content, not owned
      // by (nor layer-2-editable by) whoever triggered the seed.
      ownerPersonId: null,
      createdAt: now,
      updatedAt: now,
    };
    await operationsManualsRepo.create(manual);
    created.push(manual);
    auditService.log(manual.orgId, null, 'OperationsManual', manual.id, 'CREATE', null, manual);
  }

  logger.info({ orgId, created: created.length, skipped: skipped.length }, 'Seeded standard operations manuals');

  res.json({
    success: true,
    data: { created, skipped },
  });
});

export default router;
