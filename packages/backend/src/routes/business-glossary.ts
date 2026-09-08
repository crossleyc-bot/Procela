import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { loadStore, saveStore, registerStore } from '../lib/persistence';
import { getCachedOrgList } from '../lib/org-scope';
import { scopeListForRequest, assertOrgAccess } from '../lib/tenant-scope';
import { parseCsv } from '../lib/csv';
import { auditService } from '../services/audit.service';
import logger from '../lib/logger';
import { people } from './people';
import { dataDomains } from './data-domains';
import { getGlossaryTermsRepository } from '../db/glossary-terms.repo';
import { getPeopleRepository } from '../db/people.repo';
import { getDataDomainsRepository } from '../db/data-domains.repo';

export interface StoredGlossaryTerm {
  id: string;
  orgId: string;
  term: string;
  definition: string;
  context: string;
  synonyms: string[];
  domainId: string | null;
  ownerPersonId: string | null;
  status: 'DRAFT' | 'PROPOSED' | 'APPROVED' | 'DEPRECATED';
  category: 'BUSINESS' | 'TECHNICAL' | 'REGULATORY' | 'METRIC' | 'GENERAL';
  exampleValues: string;
  businessRules: string;
  sourceOfTruth: string;
  // Data-sync tracking — set by the sync engine when this row was created or
  // updated from a SyncConnection source. Soft reference; absent when unsynced.
  syncConnectionId?: string | null;
  syncStatus?: string | null;
  createdAt: string;
  updatedAt: string;
}

export const glossaryTerms: StoredGlossaryTerm[] = loadStore<StoredGlossaryTerm>('glossaryTerms');
registerStore('glossaryTerms', glossaryTerms);
const glossaryTermsRepo = getGlossaryTermsRepository(glossaryTerms);

// Foreign stores — build their repos lazily so nothing reads the `people` /
// `dataDomains` bindings at module-init (cycle-safety, matching the 9b
// conversions).
let _peopleRepo: ReturnType<typeof getPeopleRepository> | null = null;
const peopleRepo = () => (_peopleRepo ??= getPeopleRepository(people));
let _dataDomainsRepo: ReturnType<typeof getDataDomainsRepository> | null = null;
const dataDomainsRepo = () => (_dataDomainsRepo ??= getDataDomainsRepository(dataDomains));

const VALID_STATUSES = ['DRAFT', 'PROPOSED', 'APPROVED', 'DEPRECATED'] as const;
const VALID_CATEGORIES = ['BUSINESS', 'TECHNICAL', 'REGULATORY', 'METRIC', 'GENERAL'] as const;

function enrichTerm(
  term: StoredGlossaryTerm,
  allPeople: typeof people,
  allDomains: typeof dataDomains,
) {
  const owner = term.ownerPersonId ? allPeople.find((p) => p.id === term.ownerPersonId) : null;
  const domain = term.domainId ? allDomains.find((d) => d.id === term.domainId) : null;
  return {
    ...term,
    ownerName: owner?.name || null,
    domainName: domain?.name || null,
  };
}

const SEED_TERMS = [
  { term: 'Data Asset', definition: 'A collection of data elements that has business value and is managed as a unit. Examples include a customer database, a financial report dataset, or an API feed.', category: 'BUSINESS' as const },
  { term: 'Data Domain', definition: 'A logical grouping of related data assets organized by business function. Domains define ownership boundaries and governance scope.', category: 'BUSINESS' as const },
  { term: 'Data Steward', definition: 'The person responsible for the day-to-day management, quality, and standards compliance of data within a domain or for specific data assets.', category: 'BUSINESS' as const },
  { term: 'Data Owner', definition: 'The business leader who is accountable for a data domain or asset. They set policy, approve access, and own outcomes. Stewards execute on their behalf.', category: 'BUSINESS' as const },
  { term: 'Data Quality', definition: 'The degree to which data meets the requirements of its intended use, measured across dimensions like accuracy, completeness, timeliness, consistency, and validity.', category: 'TECHNICAL' as const },
  { term: 'Governance Tier', definition: 'A maturity classification for data assets: Bronze (minimal governance), Silver (managed with defined ownership), Gold (fully governed, certified, audit-ready).', category: 'BUSINESS' as const },
  { term: 'Health Score', definition: 'A 0-100 composite rating of a data asset\'s quality, computed from weighted quality rule results across multiple dimensions.', category: 'METRIC' as const },
  { term: 'PII', definition: 'Personally Identifiable Information. Any data that can identify a specific individual, such as name, email, SSN, or phone number. Subject to privacy regulations.', category: 'REGULATORY' as const },
  { term: 'Data Classification', definition: 'A label indicating the sensitivity level of data: Public, Internal, Confidential, or Restricted. Determines handling requirements and access controls.', category: 'REGULATORY' as const },
  { term: 'Master Data', definition: 'The core business entities that are shared across multiple systems and processes — customers, products, employees, locations. Requires golden-record governance.', category: 'TECHNICAL' as const },
];

const INDUSTRY_TERMS: Record<string, Array<{ term: string; definition: string; category: string }>> = {
  'Utilities (Electric, Gas, Water)': [
    { term: 'Meter Data', definition: 'Usage readings collected from electric, gas, or water meters at customer premises. Includes interval data, register reads, and demand measurements.', category: 'BUSINESS' },
    { term: 'Service Point', definition: 'A specific location where a utility service is delivered to a customer. Tied to a meter, an address, and an account.', category: 'BUSINESS' },
    { term: 'Rate Schedule', definition: 'A tariff structure that defines how usage is priced for a class of customers. Includes tiers, time-of-use periods, and demand charges.', category: 'BUSINESS' },
    { term: 'Outage', definition: 'An unplanned interruption in utility service. Tracked by location, duration, affected customers, and root cause.', category: 'BUSINESS' },
    { term: 'AMI', definition: 'Advanced Metering Infrastructure. The network of smart meters, communication systems, and data management software that enables two-way communication between the utility and customer meters.', category: 'TECHNICAL' },
    { term: 'SCADA', definition: 'Supervisory Control and Data Acquisition. Industrial control systems used to monitor and control utility infrastructure in real time.', category: 'TECHNICAL' },
    { term: 'GIS Asset', definition: 'A geographic information system record representing physical infrastructure — poles, transformers, pipes, valves — with spatial coordinates and attributes.', category: 'TECHNICAL' },
    { term: 'NERC CIP', definition: 'North American Electric Reliability Corporation Critical Infrastructure Protection standards. Mandatory cybersecurity requirements for bulk electric system operators.', category: 'REGULATORY' },
  ],
  'Healthcare': [
    { term: 'Patient', definition: 'An individual receiving or registered to receive medical services. The central entity in clinical and administrative workflows.', category: 'BUSINESS' },
    { term: 'Encounter', definition: 'A single interaction between a patient and a healthcare provider. Includes office visits, inpatient stays, telehealth sessions, and emergency visits.', category: 'BUSINESS' },
    { term: 'Diagnosis Code (ICD)', definition: 'A standardized code from the International Classification of Diseases used to classify conditions, symptoms, and procedures for billing and clinical tracking.', category: 'TECHNICAL' },
    { term: 'Procedure Code (CPT)', definition: 'Current Procedural Terminology code that describes medical, surgical, and diagnostic services for billing and utilization review.', category: 'TECHNICAL' },
    { term: 'PHI', definition: 'Protected Health Information. Any individually identifiable health information subject to HIPAA privacy and security rules.', category: 'REGULATORY' },
    { term: 'HIPAA', definition: 'Health Insurance Portability and Accountability Act. Federal law governing the privacy, security, and electronic exchange of health information.', category: 'REGULATORY' },
    { term: 'EHR', definition: 'Electronic Health Record. A digital version of a patient\'s medical history maintained by the provider, including diagnoses, medications, lab results, and care plans.', category: 'TECHNICAL' },
    { term: 'Claim', definition: 'A request for payment submitted to an insurer for healthcare services rendered. Contains diagnosis codes, procedure codes, and provider information.', category: 'BUSINESS' },
  ],
  'Financial Services': [
    { term: 'Account', definition: 'A financial arrangement between a customer and an institution — checking, savings, loan, investment, or credit. The core entity for transactions and balances.', category: 'BUSINESS' },
    { term: 'Transaction', definition: 'A single financial event — deposit, withdrawal, transfer, payment, or trade — recorded with amount, date, parties, and reference codes.', category: 'BUSINESS' },
    { term: 'KYC', definition: 'Know Your Customer. The regulatory process of verifying the identity, suitability, and risk profile of clients before and during a business relationship.', category: 'REGULATORY' },
    { term: 'AML', definition: 'Anti-Money Laundering. Regulations and procedures to detect, prevent, and report activities related to money laundering and terrorist financing.', category: 'REGULATORY' },
    { term: 'Basel III', definition: 'International banking regulation framework governing capital adequacy, stress testing, and liquidity risk management.', category: 'REGULATORY' },
    { term: 'NAV', definition: 'Net Asset Value. The per-share value of a fund, calculated as total assets minus liabilities divided by shares outstanding.', category: 'METRIC' },
    { term: 'Credit Score', definition: 'A numerical rating representing a borrower\'s creditworthiness, derived from payment history, outstanding debt, credit history length, and other factors.', category: 'METRIC' },
    { term: 'Position', definition: 'The quantity and value of a specific security or instrument held in a portfolio at a given point in time.', category: 'BUSINESS' },
  ],
  'Manufacturing': [
    { term: 'BOM', definition: 'Bill of Materials. A structured list of all components, sub-assemblies, and raw materials required to manufacture a finished product, with quantities.', category: 'BUSINESS' },
    { term: 'Work Order', definition: 'An authorization to manufacture a specific quantity of a product. Tracks materials consumed, labor hours, machine usage, and completion status.', category: 'BUSINESS' },
    { term: 'SKU', definition: 'Stock Keeping Unit. A unique identifier for a distinct product, including size, color, and packaging variations. Used for inventory tracking.', category: 'BUSINESS' },
    { term: 'OEE', definition: 'Overall Equipment Effectiveness. A metric combining availability, performance, and quality to measure manufacturing productivity. Target is typically 85%+.', category: 'METRIC' },
    { term: 'Lot Number', definition: 'A unique identifier assigned to a batch of product manufactured under the same conditions. Enables traceability for quality and recall purposes.', category: 'BUSINESS' },
    { term: 'MES', definition: 'Manufacturing Execution System. Software that monitors, tracks, and controls manufacturing processes on the shop floor in real time.', category: 'TECHNICAL' },
    { term: 'Yield', definition: 'The ratio of acceptable output to total output in a manufacturing process. Measures production efficiency and quality performance.', category: 'METRIC' },
    { term: 'ISO 9001', definition: 'International quality management system standard. Defines requirements for consistent product quality and continuous improvement.', category: 'REGULATORY' },
  ],
  'Oil & Gas': [
    { term: 'Well', definition: 'A drilled hole for extracting oil or gas from underground reservoirs. Tracked by location, depth, production rates, and operating status.', category: 'BUSINESS' },
    { term: 'Reservoir', definition: 'A subsurface formation containing recoverable hydrocarbons. Characterized by porosity, permeability, pressure, and estimated reserves.', category: 'BUSINESS' },
    { term: 'Production Volume', definition: 'The quantity of oil, gas, or condensate extracted from a well or field over a period, measured in barrels (oil) or cubic feet (gas).', category: 'METRIC' },
    { term: 'HSE', definition: 'Health, Safety, and Environment. The operational discipline governing worker safety, environmental protection, and regulatory compliance in oil and gas operations.', category: 'REGULATORY' },
    { term: 'Lease', definition: 'A legal agreement granting the right to explore and produce hydrocarbons from a specific land area. Defines royalty obligations and term conditions.', category: 'BUSINESS' },
    { term: 'Pipeline', definition: 'Infrastructure for transporting oil, gas, or refined products from production sites to processing facilities or end markets.', category: 'BUSINESS' },
    { term: 'SCADA', definition: 'Supervisory Control and Data Acquisition. Systems that monitor and control remote field equipment — pumps, valves, compressors — across oil and gas operations.', category: 'TECHNICAL' },
    { term: 'API Gravity', definition: 'American Petroleum Institute measure of crude oil density. Higher API means lighter oil. Affects pricing, refining options, and transportation.', category: 'TECHNICAL' },
  ],
  'Defense & Shipbuilding': [
    { term: 'Hull Number', definition: 'A unique identifier assigned to a vessel during construction. Used to track all engineering, procurement, and construction activity.', category: 'BUSINESS' },
    { term: 'Technical Data Package', definition: 'The complete set of engineering drawings, specifications, and documentation required to manufacture, test, and maintain a defense system.', category: 'TECHNICAL' },
    { term: 'ITAR', definition: 'International Traffic in Arms Regulations. Federal controls on the export and import of defense articles, services, and technical data.', category: 'REGULATORY' },
    { term: 'CUI', definition: 'Controlled Unclassified Information. Government information that requires safeguarding per federal regulations, though not classified.', category: 'REGULATORY' },
    { term: 'CMMC', definition: 'Cybersecurity Maturity Model Certification. DoD framework requiring defense contractors to meet specific cybersecurity practices and processes.', category: 'REGULATORY' },
    { term: 'WBS', definition: 'Work Breakdown Structure. A hierarchical decomposition of project scope into manageable deliverables, used for planning, scheduling, and cost control.', category: 'BUSINESS' },
    { term: 'Earned Value', definition: 'A project management metric comparing planned work to completed work and actual costs. Key measures: CPI (Cost Performance Index) and SPI (Schedule Performance Index).', category: 'METRIC' },
    { term: 'Configuration Item', definition: 'A hardware or software component under configuration management. Changes require formal review, approval, and documentation.', category: 'TECHNICAL' },
  ],
  'Transportation & Logistics': [
    { term: 'Shipment', definition: 'A consignment of goods being transported from origin to destination. Tracked by carrier, route, weight, dimensions, and delivery status.', category: 'BUSINESS' },
    { term: 'Bill of Lading', definition: 'A legal document issued by a carrier acknowledging receipt of cargo. Serves as a contract of carriage, receipt of goods, and document of title.', category: 'BUSINESS' },
    { term: 'Freight Class', definition: 'A standardized classification (NMFC) based on density, handling, stowability, and liability that determines shipping rates for LTL freight.', category: 'BUSINESS' },
    { term: 'ETA', definition: 'Estimated Time of Arrival. A predicted arrival time for a shipment or vehicle, calculated from current location, speed, route, and conditions.', category: 'METRIC' },
    { term: 'Dwell Time', definition: 'The time cargo or a vehicle spends waiting at a facility — port, warehouse, or terminal — before the next movement. A key efficiency metric.', category: 'METRIC' },
    { term: 'Intermodal', definition: 'Transportation using two or more modes (truck, rail, ship, air) without handling the cargo itself when changing modes, using standardized containers.', category: 'TECHNICAL' },
    { term: 'FMCSA', definition: 'Federal Motor Carrier Safety Administration. Regulates commercial motor vehicle safety — driver qualifications, hours of service, vehicle maintenance.', category: 'REGULATORY' },
    { term: 'Last Mile', definition: 'The final leg of delivery from a distribution hub to the end customer. Typically the most expensive and complex part of the supply chain.', category: 'BUSINESS' },
  ],
  'State & Local Government': [
    { term: 'Constituent', definition: 'A resident, business, or organization within the government\'s jurisdiction that receives services or interacts with government agencies.', category: 'BUSINESS' },
    { term: 'Permit', definition: 'An official authorization for a specific activity — building construction, business operation, special event — with conditions and an expiration.', category: 'BUSINESS' },
    { term: 'Case', definition: 'A request for government service — code enforcement, social services, public safety — tracked from intake through resolution.', category: 'BUSINESS' },
    { term: 'Parcel', definition: 'A legally defined piece of real property identified by a unique parcel number. Used for taxation, zoning, and land use planning.', category: 'BUSINESS' },
    { term: 'FOIA', definition: 'Freedom of Information Act. Legislation giving the public the right to request access to government records, with defined exemptions.', category: 'REGULATORY' },
    { term: 'Fund', definition: 'A self-balancing set of accounts used by governments to track revenues and expenditures for specific purposes. General fund, enterprise fund, capital projects fund.', category: 'BUSINESS' },
    { term: 'Open Data', definition: 'Government data published in machine-readable formats for public access and use, consistent with open data policies and transparency requirements.', category: 'TECHNICAL' },
    { term: 'ADA Compliance', definition: 'Americans with Disabilities Act compliance. Requirements for accessibility in government services, facilities, and digital content.', category: 'REGULATORY' },
  ],
};

const router = Router();

/** GET /api/v1/business-glossary — list with filters */
router.get('/', async (req: Request, res: Response) => {
  const { status, category, domainId, search } = req.query;
  const [allTerms, allPeople, allDomains] = await Promise.all([
    glossaryTermsRepo.list(),
    peopleRepo().list(),
    dataDomainsRepo().list(),
  ]);
  let filtered = scopeListForRequest(req, allTerms);

  if (status && typeof status === 'string') {
    filtered = filtered.filter((t) => t.status === status);
  }
  if (category && typeof category === 'string') {
    filtered = filtered.filter((t) => t.category === category);
  }
  if (domainId && typeof domainId === 'string') {
    filtered = filtered.filter((t) => t.domainId === domainId);
  }
  if (search && typeof search === 'string') {
    const q = search.toLowerCase();
    filtered = filtered.filter((t) =>
      t.term.toLowerCase().includes(q) ||
      t.definition.toLowerCase().includes(q) ||
      t.context.toLowerCase().includes(q) ||
      t.synonyms.some((s) => s.toLowerCase().includes(q)),
    );
  }

  const enriched = filtered.map((t) => enrichTerm(t, allPeople, allDomains));
  res.json({ success: true, data: enriched });
});

/** GET /api/v1/business-glossary/summary — aggregate stats */
router.get('/summary', async (req: Request, res: Response) => {
  const filtered = scopeListForRequest(req, await glossaryTermsRepo.list());

  const total = filtered.length;
  const approved = filtered.filter((t) => t.status === 'APPROVED').length;
  const draft = filtered.filter((t) => t.status === 'DRAFT').length;
  const proposed = filtered.filter((t) => t.status === 'PROPOSED').length;
  const deprecated = filtered.filter((t) => t.status === 'DEPRECATED').length;

  const byCategory: Record<string, number> = {};
  const byDomain: Record<string, number> = {};

  for (const t of filtered) {
    byCategory[t.category] = (byCategory[t.category] || 0) + 1;
    if (t.domainId) {
      byDomain[t.domainId] = (byDomain[t.domainId] || 0) + 1;
    }
  }

  res.json({
    success: true,
    data: { total, approved, draft, proposed, deprecated, byCategory, byDomain },
  });
});

/** GET /api/v1/business-glossary/:id — single term */
router.get('/:id', async (req: Request, res: Response) => {
  const [term, allPeople, allDomains] = await Promise.all([
    glossaryTermsRepo.get(String(req.params.id)),
    peopleRepo().list(),
    dataDomainsRepo().list(),
  ]);
  if (!term) {
    res.status(404).json({ success: false, error: 'Glossary term not found' });
    return;
  }
  if (!assertOrgAccess(req, res, term.orgId, 'Glossary term not found')) return;
  res.json({ success: true, data: enrichTerm(term, allPeople, allDomains) });
});

/** POST /api/v1/business-glossary — create */
router.post('/', async (req: Request, res: Response) => {
  const {
    term, orgId, definition, context, synonyms,
    domainId, ownerPersonId, status, category,
    exampleValues, businessRules, sourceOfTruth,
  } = req.body;

  if (!term || typeof term !== 'string') {
    res.status(400).json({ success: false, error: 'term is required' });
    return;
  }
  if (!orgId || typeof orgId !== 'string') {
    res.status(400).json({ success: false, error: 'orgId is required' });
    return;
  }

  const duplicate = (await glossaryTermsRepo.list()).find(
    (t) => t.orgId === orgId && t.term.trim().toLowerCase() === term.trim().toLowerCase(),
  );
  if (duplicate) {
    res.status(409).json({ success: false, error: `A glossary term "${term}" already exists in this organization` });
    return;
  }

  const now = new Date().toISOString();
  const newTerm: StoredGlossaryTerm = {
    id: uuid(),
    orgId,
    term: term.trim(),
    definition: definition || '',
    context: context || '',
    synonyms: Array.isArray(synonyms) ? synonyms : [],
    domainId: domainId || null,
    ownerPersonId: ownerPersonId || null,
    status: status && (VALID_STATUSES as readonly string[]).includes(status) ? status : 'DRAFT',
    category: category && (VALID_CATEGORIES as readonly string[]).includes(category) ? category : 'BUSINESS',
    exampleValues: exampleValues || '',
    businessRules: businessRules || '',
    sourceOfTruth: sourceOfTruth || '',
    createdAt: now,
    updatedAt: now,
  };

  await glossaryTermsRepo.create(newTerm);
  auditService.log('system', orgId, 'GlossaryTerm', newTerm.id, 'CREATE', null, newTerm);
  logger.info({ id: newTerm.id, term: newTerm.term }, 'Created glossary term');
  const [allPeople, allDomains] = await Promise.all([peopleRepo().list(), dataDomainsRepo().list()]);
  res.status(201).json({ success: true, data: enrichTerm(newTerm, allPeople, allDomains) });
});

/** PUT /api/v1/business-glossary/:id — update */
router.put('/:id', async (req: Request, res: Response) => {
  const existing = await glossaryTermsRepo.get(String(req.params.id));
  if (!existing) {
    res.status(404).json({ success: false, error: 'Glossary term not found' });
    return;
  }

  const before = { ...existing };
  const {
    term, definition, context, synonyms,
    domainId, ownerPersonId, status, category,
    exampleValues, businessRules, sourceOfTruth,
  } = req.body;

  if (term !== undefined && term.trim().toLowerCase() !== existing.term.trim().toLowerCase()) {
    const duplicate = (await glossaryTermsRepo.list()).find(
      (t) => t.id !== existing.id
        && t.orgId === existing.orgId
        && t.term.trim().toLowerCase() === term.trim().toLowerCase(),
    );
    if (duplicate) {
      res.status(409).json({ success: false, error: `A glossary term "${term}" already exists in this organization` });
      return;
    }
  }
  if (term !== undefined) existing.term = term;
  if (definition !== undefined) existing.definition = definition;
  if (context !== undefined) existing.context = context;
  if (synonyms !== undefined && Array.isArray(synonyms)) existing.synonyms = synonyms;
  if (domainId !== undefined) existing.domainId = domainId || null;
  if (ownerPersonId !== undefined) existing.ownerPersonId = ownerPersonId || null;
  if (status !== undefined && (VALID_STATUSES as readonly string[]).includes(status)) existing.status = status;
  if (category !== undefined && (VALID_CATEGORIES as readonly string[]).includes(category)) existing.category = category;
  if (exampleValues !== undefined) existing.exampleValues = exampleValues;
  if (businessRules !== undefined) existing.businessRules = businessRules;
  if (sourceOfTruth !== undefined) existing.sourceOfTruth = sourceOfTruth;

  existing.updatedAt = new Date().toISOString();
  await glossaryTermsRepo.update(existing.id, existing);
  auditService.log('system', existing.orgId, 'GlossaryTerm', existing.id, 'UPDATE', before, existing);
  logger.info({ id: existing.id, term: existing.term }, 'Updated glossary term');
  const [allPeople, allDomains] = await Promise.all([peopleRepo().list(), dataDomainsRepo().list()]);
  res.json({ success: true, data: enrichTerm(existing, allPeople, allDomains) });
});

/** DELETE /api/v1/business-glossary/:id — delete */
router.delete('/:id', async (req: Request, res: Response) => {
  const removed = await glossaryTermsRepo.get(String(req.params.id));
  if (!removed) {
    res.status(404).json({ success: false, error: 'Glossary term not found' });
    return;
  }
  await glossaryTermsRepo.delete(removed.id);
  auditService.log('system', removed.orgId, 'GlossaryTerm', removed.id, 'DELETE', removed, null);
  logger.info({ id: removed.id, term: removed.term }, 'Deleted glossary term');
  res.status(204).send();
});

/** POST /api/v1/business-glossary/seed — create or preview starter terms for an org */
router.post('/seed', async (req: Request, res: Response) => {
  const { orgId, preview, selectedTerms } = req.body;
  if (!orgId || typeof orgId !== 'string') {
    res.status(400).json({ success: false, error: 'orgId is required' });
    return;
  }

  const now = new Date().toISOString();
  const created: StoredGlossaryTerm[] = [];

  // Look up the org's industry to include industry-specific terms
  const org = getCachedOrgList().find((o) => o.id === orgId) as any;
  const industry = org?.industry || '';
  const industryTerms = Object.entries(INDUSTRY_TERMS).find(
    ([key]) => industry.toLowerCase().includes(key.toLowerCase()) || key.toLowerCase().includes(industry.toLowerCase()),
  );
  const allSeeds = [...SEED_TERMS, ...(industryTerms ? industryTerms[1] : [])];

  // Filter out terms that already exist
  const existingNames = new Set(
    (await glossaryTermsRepo.list()).filter((t) => t.orgId === orgId).map((t) => t.term.trim().toLowerCase()),
  );
  const available = allSeeds.filter((s) => !existingNames.has(s.term.trim().toLowerCase()));

  // Preview mode: return available terms without creating
  if (preview) {
    res.json({
      success: true,
      preview: true,
      terms: available.map((s) => ({ term: s.term, definition: s.definition, category: s.category })),
      industry: industryTerms ? industryTerms[0] : null,
    });
    return;
  }

  // If selectedTerms provided, only create those
  const toCreate = selectedTerms && Array.isArray(selectedTerms)
    ? available.filter((s) => selectedTerms.includes(s.term))
    : available;

  for (const seed of toCreate) {
    const newTerm: StoredGlossaryTerm = {
      id: uuid(),
      orgId,
      term: seed.term,
      definition: seed.definition,
      context: '',
      synonyms: [],
      domainId: null,
      ownerPersonId: null,
      status: 'DRAFT',
      category: seed.category as StoredGlossaryTerm['category'],
      exampleValues: '',
      businessRules: '',
      sourceOfTruth: '',
      createdAt: now,
      updatedAt: now,
    };

    await glossaryTermsRepo.create(newTerm);
    created.push(newTerm);
  }

  if (created.length > 0) {
    auditService.log('system', orgId, 'GlossaryTerm', '*', 'SEED', null, { count: created.length, industry });
    logger.info({ orgId, count: created.length, industry }, 'Seeded glossary terms');
  }

  const [allPeople, allDomains] = await Promise.all([peopleRepo().list(), dataDomainsRepo().list()]);
  res.status(201).json({
    success: true,
    data: created.map((t) => enrichTerm(t, allPeople, allDomains)),
    seeded: created.length,
    industry: industryTerms ? industryTerms[0] : null,
  });
});

/**
 * PATCH /api/v1/business-glossary/bulk
 *
 * Body: { ids: string[], updates: { status?, category?, ownerPersonId?, domainId? } }
 *
 * Applies the same partial update to every term in `ids`. Unknown ids are
 * skipped. Invalid status/category values are ignored field-by-field.
 */
router.patch('/bulk', async (req: Request, res: Response) => {
  const { ids, updates } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ success: false, error: 'ids must be a non-empty array' });
    return;
  }
  if (!updates || typeof updates !== 'object') {
    res.status(400).json({ success: false, error: 'updates object is required' });
    return;
  }

  const now = new Date().toISOString();
  let updated = 0;
  const skipped: string[] = [];

  for (const id of ids) {
    const t = await glossaryTermsRepo.get(String(id));
    if (!t) { skipped.push(id); continue; }
    const before = { ...t };
    if (updates.status !== undefined && (VALID_STATUSES as readonly string[]).includes(updates.status)) t.status = updates.status;
    if (updates.category !== undefined && (VALID_CATEGORIES as readonly string[]).includes(updates.category)) t.category = updates.category;
    if (updates.ownerPersonId !== undefined) t.ownerPersonId = updates.ownerPersonId || null;
    if (updates.domainId !== undefined) t.domainId = updates.domainId || null;
    t.updatedAt = now;
    await glossaryTermsRepo.update(t.id, t);
    auditService.log('system', t.orgId, 'GlossaryTerm', t.id, 'BULK_UPDATE', before, t);
    updated++;
  }

  logger.info({ updated, skipped: skipped.length }, 'Bulk-updated glossary terms');
  res.json({ success: true, updated, skipped });
});

/**
 * POST /api/v1/business-glossary/bulk-delete
 *
 * Body: { ids: string[] }
 *
 * Removes every term whose id is in `ids`. Unknown ids are silently skipped.
 */
router.post('/bulk-delete', async (req: Request, res: Response) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ success: false, error: 'ids must be a non-empty array' });
    return;
  }
  const idSet = new Set(ids);
  const removed = (await glossaryTermsRepo.list()).filter((t) => idSet.has(t.id));
  for (const r of removed) {
    auditService.log('system', r.orgId, 'GlossaryTerm', r.id, 'DELETE', r, null);
    await glossaryTermsRepo.delete(r.id);
  }
  logger.info({ count: removed.length }, 'Bulk-deleted glossary terms');
  res.json({ success: true, deleted: removed.length });
});

/**
 * POST /api/v1/business-glossary/import
 * Import glossary terms from CSV or a JSON array. orgId is required.
 *
 * JSON: { orgId, terms: [{ term, definition?, category?, status?, synonyms?, ... }] }
 * CSV:  { orgId, csv: "Term,Definition,Category,Status\nClient,A purchaser,BUSINESS,DRAFT" }
 *
 * Duplicates (same term name in same org, case-insensitive) are skipped.
 * Returns { created, skipped, message } so the UI can flag partial imports.
 */
router.post('/import', async (req: Request, res: Response) => {
  try {
    const { orgId, terms: termList, csv } = req.body;

    if (!orgId) {
      res.status(400).json({ success: false, error: 'Organization is required for import' });
      return;
    }

    type ImportRow = {
      term: string;
      definition?: string;
      category?: string;
      status?: string;
      synonyms?: string[] | string;
      context?: string;
      sourceOfTruth?: string;
      exampleValues?: string;
      businessRules?: string;
    };
    let rows: ImportRow[] = [];

    if (csv && typeof csv === 'string') {
      const parsed = parseCsv(csv);
      if (parsed.length < 2) {
        res.status(400).json({ success: false, error: 'CSV must have a header row and at least one data row' });
        return;
      }
      const header = parsed[0].map((h) => h.trim().toLowerCase());
      const idx = (...names: string[]) => header.findIndex((h) => names.includes(h));
      const termIdx = idx('term', 'name');
      const defIdx = idx('definition');
      const catIdx = idx('category');
      const statusIdx = idx('status');
      const synIdx = idx('synonyms');
      const ctxIdx = idx('context');
      const sotIdx = idx('source of truth', 'sourceoftruth', 'source_of_truth');

      if (termIdx === -1) {
        res.status(400).json({ success: false, error: 'CSV must have a "Term" column' });
        return;
      }

      for (let i = 1; i < parsed.length; i++) {
        const cols = parsed[i].map((c) => c.trim());
        if (!cols[termIdx]) continue;
        rows.push({
          term: cols[termIdx],
          definition: defIdx >= 0 ? cols[defIdx] : undefined,
          category: catIdx >= 0 ? cols[catIdx] : undefined,
          status: statusIdx >= 0 ? cols[statusIdx] : undefined,
          synonyms: synIdx >= 0 && cols[synIdx] ? cols[synIdx].split(/[;|]/).map((s) => s.trim()).filter(Boolean) : undefined,
          context: ctxIdx >= 0 ? cols[ctxIdx] : undefined,
          sourceOfTruth: sotIdx >= 0 ? cols[sotIdx] : undefined,
        });
      }
    } else if (Array.isArray(termList)) {
      rows = termList;
    } else {
      res.status(400).json({ success: false, error: 'Provide a "terms" array or "csv" string' });
      return;
    }

    if (rows.length === 0) {
      res.status(400).json({ success: false, error: 'No terms to import' });
      return;
    }

    const created: StoredGlossaryTerm[] = [];
    const skipped: string[] = [];
    const now = new Date().toISOString();

    // Prefetch existing terms once; append created rows as we go so
    // duplicates *within* the same import batch are still caught.
    const existingTerms = await glossaryTermsRepo.list();

    for (const row of rows) {
      if (!row.term || !row.term.trim()) continue;
      const dup = existingTerms.find(
        (t) => t.orgId === orgId && t.term.trim().toLowerCase() === row.term.trim().toLowerCase(),
      );
      if (dup) { skipped.push(row.term); continue; }

      const status = (row.status && (VALID_STATUSES as readonly string[]).includes(row.status.toUpperCase()))
        ? row.status.toUpperCase() as StoredGlossaryTerm['status']
        : 'DRAFT';
      const category = (row.category && (VALID_CATEGORIES as readonly string[]).includes(row.category.toUpperCase()))
        ? row.category.toUpperCase() as StoredGlossaryTerm['category']
        : 'BUSINESS';

      const newTerm: StoredGlossaryTerm = {
        id: uuid(),
        orgId,
        term: row.term.trim(),
        definition: row.definition || '',
        context: row.context || '',
        synonyms: Array.isArray(row.synonyms) ? row.synonyms : [],
        domainId: null,
        ownerPersonId: null,
        status,
        category,
        exampleValues: row.exampleValues || '',
        businessRules: row.businessRules || '',
        sourceOfTruth: row.sourceOfTruth || '',
        createdAt: now,
        updatedAt: now,
      };
      await glossaryTermsRepo.create(newTerm);
      created.push(newTerm);
      existingTerms.push(newTerm);
    }

    if (created.length > 0) {
      auditService.log('system', orgId, 'GlossaryTerm', '*', 'IMPORT', null, { count: created.length, skipped: skipped.length });
    }
    logger.info({ created: created.length, skipped: skipped.length, orgId }, 'Imported glossary terms');
    const [allPeople, allDomains] = await Promise.all([peopleRepo().list(), dataDomainsRepo().list()]);
    res.status(201).json({
      success: true,
      data: created.map((t) => enrichTerm(t, allPeople, allDomains)),
      skipped: skipped.length,
      message: skipped.length > 0 ? `Imported ${created.length} terms; skipped ${skipped.length} duplicate${skipped.length !== 1 ? 's' : ''}.` : `Imported ${created.length} terms.`,
    });
  } catch (err: any) {
    logger.error({ err }, 'Glossary import failed');
    res.status(500).json({ success: false, error: err?.message || 'Import failed' });
  }
});

export default router;
