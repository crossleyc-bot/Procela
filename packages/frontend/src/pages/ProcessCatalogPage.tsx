import { useEffect, useState, useCallback, useMemo, lazy, Suspense } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { apiClient } from '../api/client';
import { errorMessage } from '../lib/errorToast';
import PageHeader from '../components/PageHeader';
import CreateScopeNotice from '../components/CreateScopeNotice';
import Card from '../components/Card';
import { useOrgContext } from '../stores/orgContext';
import { useValueStreamScope } from '../hooks/useValueStreamScope';
import { useOrgNameLookup } from '../hooks/useOrgNameLookup';
import { usePolling } from '../hooks/usePolling';
import { usePermissions } from '../hooks/usePermissions';
import { useAiEnabled } from '../stores/aiConfigStore';
import ConfirmDialog from '../components/ConfirmDialog';
import BulkActionBar, { BulkActionButton } from '../components/BulkActionBar';
import IconButton from '../components/IconButton';
import HelpPopover from '../components/HelpPopover';
import DomainLensToggle from '../components/DomainLensToggle';
import DomainLensActiveBanner from '../components/DomainLensActiveBanner';
import PersonPicker from '../components/PersonPicker';
import { GOVERNANCE_ROLES } from '../types';
import { useDomainLensStore, useDomainLens, passesLens } from '../stores/domainLensStore';
import { useComplianceStore, BUILTIN_COMPLIANCE_FRAMEWORKS } from '../stores/complianceStore';
import { processDomain } from '../lib/entityDomain';
import { useToastStore } from '../stores/toastStore';
import { useAuthStore } from '../stores/authStore';
import ExportMenu from '../components/ExportMenu';
import { ExportPayload } from '../lib/export';
import { SkeletonRows } from '../components/Skeleton';
import TreeNode from './process-catalog/TreeNode';
import type { AddMappingTarget } from './process-catalog/IOPanel';
// Lazy: only renders when the user clicks "History" on a node.
const VersionHistoryModal = lazy(() => import('../components/VersionHistoryModal'));

// ── Types ──

export type NodeLevel = 'VALUE_STREAM' | 'DOMAIN' | 'CAPABILITY' | 'PROCESS' | 'SUBPROCESS' | 'ACTIVITY' | 'TASK' | 'EXECUTION';

export interface ProcessNode {
  id: string;
  parentId: string | null;
  level: NodeLevel;
  name: string;
  description: string;
  activityId: string | null;
  status: string;
  orderIndex: number;
  orgIds: string[];
  ownerId: string | null;
  version?: number;
  purpose?: string;
  businessOutcome?: string;
  stakeholders?: string;
  complianceTags?: string[];
  inputsOutputs?: string;
  responsibleRole?: string;
  responsiblePersonId?: string | null;
  statusJustification?: string;
  frequency?: string;
  riskLevel?: string;
  automationLevel?: string;
  estimatedDuration?: string;
  requiredSkillIds?: string[];
  /** First-class link to the systems this step (or higher-level node)
   *  runs on. Captures step→system independently of the data-asset
   *  mappings, so a step on a system without a mapped asset is still
   *  surfaced. */
  systemIds?: string[];
  domain?: 'GOVERNANCE' | 'OPERATIONAL';
  // BCM: business-continuity tier + RTO/RPO in hours
  criticalityTier?: 'TIER_1' | 'TIER_2' | 'TIER_3' | 'TIER_4';
  rtoHours?: number;
  rpoHours?: number;
  // Measurable success signals — free-text so operators can express
  // "P95 4h" or "99.9% monthly" without a schema war
  successMeasure?: string;
  slaTarget?: string;
  // What initiates the activity (SCHEDULED / EVENT / UPSTREAM / MANUAL /
  // EXTERNAL_REQUEST) and its processing volume / throughput (free-text).
  trigger?: string;
  volume?: string;
  // Forward-looking governance review date (ISO date string) and free-text
  // notes on how the activity's risk (riskLevel) is mitigated.
  nextReviewDate?: string;
  riskMitigation?: string;
  // Governance controls this activity implements or is subject to
  controlIds?: string[];
  // Change-management review workflow (only meaningful when the
  // org's statusMode is 'review'). Populated by the backend on
  // DRAFT → PENDING_REVIEW → (ACTIVE | DRAFT) transitions.
  submittedBy?: string;
  submittedAt?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewComment?: string;
  children?: ProcessNode[];
}

export interface FlowRelationship {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  type: string;
}

export interface TagEntry {
  id: string;
  orgId: string;
  entityType: string;
  entityId: string;
  tag: string;
  createdAt: string;
}

// ── Level Configuration ──

export const LEVEL_CONFIG: Record<NodeLevel, { color: string; bg: string; label: string; plural: string; required: boolean; icon: string; hint: string }> = {
  VALUE_STREAM: { color: '#0f4f46', bg: '#d1f0eb', label: 'Value Stream', plural: 'Value Streams', required: true, icon: '\u2B95', hint: 'End-to-end flow delivering value to a customer or stakeholder' },
  DOMAIN:       { color: '#5b21b6', bg: '#ede9fe', label: 'Domain', plural: 'Domains', required: false, icon: '\u25CE', hint: 'A business domain grouping related capabilities' },
  CAPABILITY:   { color: '#1e40af', bg: '#dbeafe', label: 'Capability', plural: 'Capabilities', required: false, icon: '\u2B50', hint: 'A business capability that the organization performs' },
  PROCESS:      { color: '#92400e', bg: '#fef3c7', label: 'Process', plural: 'Processes', required: true, icon: '\u2699', hint: 'A defined set of activities achieving a specific outcome' },
  SUBPROCESS:   { color: '#9d174d', bg: '#fce7f3', label: 'Sub-Process', plural: 'Sub-Processes', required: false, icon: '\u21B3', hint: 'A grouping of related activities within a process' },
  ACTIVITY:     { color: '#065f46', bg: '#d1fae5', label: 'Activity', plural: 'Activities', required: true, icon: '\u25B6', hint: 'A specific unit of work with inputs and outputs' },
  TASK:         { color: '#64748b', bg: '#f1f5f9', label: 'Task', plural: 'Tasks', required: false, icon: '\u2022', hint: 'A detailed task within an activity' },
  EXECUTION:    { color: '#475569', bg: '#e2e8f0', label: 'System/Execution', plural: 'Systems/Executions', required: false, icon: '\u2318', hint: 'System or automation that executes a task' },
};

import { getStatusColor } from '@/lib/statusBadge';

const ALL_STATUSES = ['DRAFT', 'PENDING_REVIEW', 'PROPOSED', 'UNDER_REVIEW', 'APPROVED', 'ACTIVE', 'DEPRECATED'];
export const statusColors = Object.fromEntries(ALL_STATUSES.map((s) => [s, getStatusColor(s)]));

export const SIMPLE_TRANSITIONS: Record<string, string[]> = {
  DRAFT:      ['ACTIVE'],
  ACTIVE:     ['DRAFT', 'DEPRECATED'],
  DEPRECATED: ['DRAFT'],
};
// Review mode — one review gate between DRAFT and ACTIVE. Sized for
// enterprise change control that wants an approver check without the
// four-state ceremony of `advanced`.
export const REVIEW_TRANSITIONS: Record<string, string[]> = {
  DRAFT:          ['PENDING_REVIEW'],
  PENDING_REVIEW: ['ACTIVE', 'DRAFT'],
  ACTIVE:         ['DRAFT', 'DEPRECATED'],
  DEPRECATED:     ['DRAFT'],
};
export const ADVANCED_TRANSITIONS: Record<string, string[]> = {
  DRAFT:        ['PROPOSED'],
  PROPOSED:     ['UNDER_REVIEW', 'DRAFT'],
  UNDER_REVIEW: ['APPROVED', 'DRAFT'],
  APPROVED:     ['ACTIVE', 'DRAFT'],
  ACTIVE:       ['DRAFT', 'DEPRECATED'],
  DEPRECATED:   ['DRAFT'],
};
// Simple mode has no approval gate, so demoting an Active item to Draft
// just to edit it and promoting it straight back is empty ceremony — it
// buys no review and only flickers the item out of "Active" while you
// type. So Active stays editable inline here; only Deprecated (retired)
// is locked, and reopening it to Draft is the deliberate revive step.
// The governed modes keep Active locked — there the reopen-to-Draft
// round-trip is the point, because it forces the change back through the
// review gate before it can be Active again.
export const SIMPLE_LOCKED = new Set(['DEPRECATED']);
export const REVIEW_LOCKED = new Set(['PENDING_REVIEW', 'ACTIVE', 'DEPRECATED']);
export const ADVANCED_LOCKED = new Set(['UNDER_REVIEW', 'APPROVED', 'ACTIVE', 'DEPRECATED']);

// The built-in compliance-framework set. Retained as the fallback the
// org-configurable list defaults to (see stores/complianceStore.ts); the
// activity Compliance picker now reads the tenant's active list via
// useComplianceFrameworks() rather than this constant directly.
export const COMPLIANCE_OPTIONS = [...BUILTIN_COMPLIANCE_FRAMEWORKS];

export const FREQUENCY_OPTIONS = [
  'Continuous', 'Real-time', 'Hourly', 'Daily', 'Weekly', 'Monthly', 'Quarterly', 'Annually', 'On-demand', 'Event-driven',
];

export const RISK_OPTIONS = ['High', 'Medium', 'Low'];

// What initiates an activity. Free-text under the hood (like Frequency /
// Risk) with a suggested set so common triggers stay consistent.
export const TRIGGER_OPTIONS = ['Scheduled', 'Event-driven', 'Upstream completion', 'Manual', 'External request'];

export const AUTOMATION_OPTIONS = ['Manual', 'Semi-automated', 'Fully automated'];

// Buckets for Est. Duration on activities. A fixed list keeps reports
// comparable across activities (and across organisations) instead of
// the previous free-text mix of "2 hrs", "couple hours", "120 minutes",
// "half a day"… If a node already has a legacy free-text value the
// use-site appends it to the options so it stays selectable until
// edited.
export const DURATION_OPTIONS = [
  '< 5 minutes',
  '5–15 minutes',
  '15–30 minutes',
  '30 minutes – 1 hour',
  '1–2 hours',
  '2–4 hours',
  '4–8 hours',
  '1 day',
  '1–2 days',
  '2–5 days',
  '1–2 weeks',
  '2–4 weeks',
  '1–3 months',
  '3+ months',
];

export const ROLE_OPTIONS = [
  'Process Owner', 'Process Manager', 'Business Analyst', 'Data Analyst',
  'System Administrator', 'End User', 'Supervisor', 'Technician',
  'Customer Service Rep', 'Finance Analyst', 'Compliance Officer',
  'Operations Manager', 'IT Support', 'Quality Analyst', 'Other',
];

export interface PersonRef { id: string; name: string; }
export interface DataAssetRef { id: string; name: string; orgId?: string }
export interface SystemRef { id: string; name: string; systemType?: string; }
export interface PolicyRef { id: string; name: string; code: string; documentType: string; orgId?: string }
export interface MappingInfo {
  id: string;
  processStepId: string;
  // Exactly one of these three is set per mapping row. dataAssetId
  // is the operational case (asset I/O); policyId is the governance
  // case (charter / policy / standard the activity produces or
  // consumes); attachmentId is an uploaded file or URL bound to
  // the activity.
  dataAssetId?: string;
  policyId?: string;
  attachmentId?: string;
  linkType: string;
  criticality?: string;
  dataFormat?: string;
  sla?: string;
  qualityRequirement?: string;
  /** When set, this mapping was created by clicking "Link…" next to a
   *  specific expected input/output placeholder (parsed from the node's
   *  free-text inputsOutputs field). The expected row uses this as a
   *  durable association so the visible label can stay e.g. "Business
   *  strategy" while the linked entity is "Q4 Strategy Plan.pdf",
   *  bypassing the fuzzy substring match. */
  fulfillsExpected?: string;
  assetInfo: { assetId: string; assetName: string; ownerName: string | null; stewardName: string | null; governanceTier: string; healthScore: number } | null;
  policyInfo: { policyId: string; policyName: string; policyCode: string; documentType: string; status: string } | null;
  attachmentInfo: { attachmentId: string; name: string; type: 'FILE' | 'URL'; fileName?: string; url?: string; mimeType?: string; fileSize?: number } | null;
}

export const inputStyle: React.CSSProperties = {
  border: '1px solid var(--color-border)', borderRadius: 4,
  padding: '4px 8px', fontSize: 13, background: 'var(--color-surface)',
};

export const btnIcon: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer',
  padding: '2px 6px', fontSize: 12, color: 'var(--color-text-muted)', borderRadius: 4,
};

export const btnAdd: React.CSSProperties = {
  background: 'none', border: '1px dashed var(--color-border)',
  borderRadius: 4, padding: '3px 8px', fontSize: 11,
  color: 'var(--color-primary)', cursor: 'pointer',
};

// ── Helpers ──

export function countByLevel(node: ProcessNode, level: NodeLevel): number {
  let count = node.level === level ? 1 : 0;
  for (const child of node.children || []) count += countByLevel(child, level);
  return count;
}

/** Return a display copy of the tree with the given levels hidden. A hidden
 *  node isn't just dropped — its (recursively filtered) children are promoted
 *  up into its place, so hiding an intermediate level (e.g. Sub-Process) lets
 *  its Activities show directly under the Process rather than disappearing
 *  with their parent. Node ids are preserved, so expand/edit/select still work
 *  against the underlying catalog. */
export function pruneHiddenLevels(nodes: ProcessNode[], hidden: Set<NodeLevel>): ProcessNode[] {
  if (hidden.size === 0) return nodes;
  const out: ProcessNode[] = [];
  for (const n of nodes) {
    const kids = pruneHiddenLevels(n.children || [], hidden);
    if (hidden.has(n.level)) out.push(...kids);
    else out.push({ ...n, children: kids });
  }
  return out;
}

export function hasRequiredPath(node: ProcessNode): { complete: boolean; missing: string[]; hasProcess: boolean; hasActivity: boolean } {
  if (node.level !== 'VALUE_STREAM') return { complete: true, missing: [], hasProcess: true, hasActivity: true };
  const missing: string[] = [];
  const hasProcess = countByLevel(node, 'PROCESS') > 0;
  const hasActivity = countByLevel(node, 'ACTIVITY') > 0;
  if (!hasProcess) missing.push('Process');
  if (!hasActivity) missing.push('Activity');
  return { complete: missing.length === 0, missing, hasProcess, hasActivity };
}

export function getRequiredNextLevel(node: ProcessNode): NodeLevel | null {
  if (node.level === 'VALUE_STREAM' && countByLevel(node, 'PROCESS') === 0) return 'PROCESS';
  if (node.level === 'PROCESS' && countByLevel(node, 'ACTIVITY') === 0) return 'ACTIVITY';
  if (node.level === 'VALUE_STREAM' && countByLevel(node, 'ACTIVITY') === 0) return null; // need to go deeper
  return null;
}

function collectIssues(tree: ProcessNode[]): Array<{ nodeId: string; nodeName: string; level: NodeLevel; issue: string }> {
  const issues: Array<{ nodeId: string; nodeName: string; level: NodeLevel; issue: string }> = [];
  function walk(nodes: ProcessNode[]) {
    for (const node of nodes) {
      if (node.level === 'VALUE_STREAM') {
        const cp = hasRequiredPath(node);
        if (!cp.hasProcess) issues.push({ nodeId: node.id, nodeName: node.name, level: node.level, issue: 'Missing Process' });
        else if (!cp.hasActivity) issues.push({ nodeId: node.id, nodeName: node.name, level: node.level, issue: 'Missing Activity' });
      }
      if (node.level === 'PROCESS' && countByLevel(node, 'ACTIVITY') === 0) {
        issues.push({ nodeId: node.id, nodeName: node.name, level: node.level, issue: 'Missing Activity' });
      }
      if (node.children) walk(node.children);
    }
  }
  walk(tree);
  return issues;
}

function findNodeInTree(nodes: ProcessNode[], id: string): ProcessNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children) {
      const found = findNodeInTree(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

// ── Add Node Form ──

function AddNodeForm({ validChildren, onAdd, onCancel }: {
  validChildren: NodeLevel[];
  onAdd: (name: string, description: string, level: NodeLevel) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [level, setLevel] = useState<NodeLevel>(validChildren[0]);
  const config = LEVEL_CONFIG[level];

  return (
    <div style={{ background: config.bg, border: `1px solid ${config.color}33`, borderRadius: 6, padding: 12, margin: '6px 0' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        {validChildren.length > 1 ? (
          <select aria-label="Level" style={{ ...inputStyle, width: 'auto', fontWeight: 500 }} value={level} onChange={(e) => setLevel(e.target.value as NodeLevel)}>
            {validChildren.map((l) => (
              <option key={l} value={l}>
                {LEVEL_CONFIG[l].icon} {LEVEL_CONFIG[l].label}{LEVEL_CONFIG[l].required ? ' *' : ''}
              </option>
            ))}
          </select>
        ) : (
          <span style={{ fontSize: 12, fontWeight: 600, color: config.color }}>
            {config.icon} Add {config.label}
          </span>
        )}
        <input autoFocus aria-label={`${config.label} name`} style={{ ...inputStyle, flex: 1 }} placeholder={`${config.label} name...`} value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) onAdd(name.trim(), description.trim(), level); if (e.key === 'Escape') onCancel(); }}
        />
      </div>
      <div style={{ fontSize: 11, color: config.color, marginBottom: 6, opacity: 0.8 }}>
        {config.hint}
      </div>
      <input aria-label="Description" style={{ ...inputStyle, width: '100%', marginBottom: 8 }} placeholder="Description (optional)" value={description}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) onAdd(name.trim(), description.trim(), level); if (e.key === 'Escape') onCancel(); }}
      />
      <div style={{ display: 'flex', gap: 6 }}>
        <button style={{ ...btnAdd, background: config.color, color: '#fff', border: 'none', padding: '4px 12px' }}
          onClick={() => { if (name.trim()) onAdd(name.trim(), description.trim(), level); }} disabled={!name.trim()}>
          Add {config.label}
        </button>
        <button style={{ ...btnAdd, padding: '4px 12px' }} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ── Main Component ──

export default function ProcessCatalogPage() {
  const navigate = useNavigate();
  const { activeOrgId, activeOrgName, activeOrgType, canCreateValueStreams, setActiveOrg } = useOrgContext();
  // Block "create value stream" entry points when the active org is a
  // multi-division company (e.g. Tidewater Utilities → Electric /
  // Water). The wizard already enforces this; the manual create
  // surfaces on this page enforce it too so users can't sidestep the
  // guard via the "+ Add value stream" header button or the empty
  // state. Read-only surfaces (Visualize, Compare, Export) stay
  // available.
  const { divisions: subtreeDivisions, companyWithDivisions } = useValueStreamScope();
  const canCreateHere = canCreateValueStreams && !companyWithDivisions;
  // Governance value streams are exempt from the multi-division
  // block — corporate governance (policies, decision rights, the
  // overall data-governance program) is intentionally one
  // enterprise-wide program, so a multi-division company can
  // still create it at the parent. BUT it must ONLY be at the
  // company level: a division can't own its own governance
  // program (it wouldn't be enterprise-wide by definition), and
  // an earlier fix already hides ancestor-owned governance from
  // a division's Process Catalog, so exposing the "Generate
  // governance processes" wand at the division level would let a
  // user create a governance VS whose rows the same catalog then
  // hides — confusing and inconsistent. Guard on activeOrgType.
  const canCreateGovernanceHere =
    canCreateValueStreams && activeOrgType === 'company';
  // Used by addMapping to detect cross-division links — when an
  // activity's value-stream org and the data asset's owner org are
  // on different vertical axes (e.g. Tidewater Water activity ↔
  // Tidewater Electric asset), pop a confirm before linking.
  const { getOrgName, isOrgInScope } = useOrgNameLookup();
  const { canWrite, canContribute } = usePermissions();
  const aiEnabled = useAiEnabled();
  const addToast = useToastStore((s) => s.addToast);
  const currentUser = useAuthStore((s) => s.user);
  const [tree, setTree] = useState<ProcessNode[]>([]);
  const [stats, setStats] = useState<Record<string, any>>({});
  const [validChildrenMap, setValidChildrenMap] = useState<Record<string, string[]>>({});
  const [flows, setFlows] = useState<FlowRelationship[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Flat activity list for the DependenciesPanel picker — every
  // activity node with the name of its owning value stream, so a
  // predecessor picker can show "Outage triage (Outage Management)"
  // without the panel having to walk the tree itself. Rebuilt on tree
  // change, which happens once per fetch.
  const activitiesFlat = useMemo(() => {
    const out: Array<{ id: string; name: string; valueStreamName: string }> = [];
    const walk = (nodes: ProcessNode[], valueStreamName: string) => {
      for (const n of nodes) {
        const vs = n.level === 'VALUE_STREAM' ? n.name : valueStreamName;
        if (n.level === 'ACTIVITY') out.push({ id: n.id, name: n.name, valueStreamName: vs });
        if (n.children?.length) walk(n.children, vs);
      }
    };
    walk(tree, '');
    return out;
  }, [tree]);
  // Notifications (and the Source-panel link on the Governance Documents
  // page) deep-link the user to a specific catalog node via ?node=<id>
  // (accepted synonym: ?activity=<id>). The effect below honours that:
  // walks the tree to find the ancestor chain, expands them all, then
  // on the next paint scrolls the row into view and flashes a brief
  // highlight so the user's eye lands on it. Falls back silently if
  // the node isn't in the current scope.
  const location = useLocation();
  useEffect(() => {
    if (!tree.length) return;
    const params = new URLSearchParams(location.search);
    const targetId = params.get('node') || params.get('activity');
    if (!targetId) return;
    function findAncestorIds(nodes: ProcessNode[], id: string, path: string[] = []): string[] | null {
      for (const n of nodes) {
        if (n.id === id) return path;
        if (n.children?.length) {
          const sub = findAncestorIds(n.children, id, [...path, n.id]);
          if (sub) return sub;
        }
      }
      return null;
    }
    const ancestors = findAncestorIds(tree, targetId);
    if (!ancestors) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const id of ancestors) next.add(id);
      next.add(targetId);
      return next;
    });
    // Defer the scroll + flash to the next paint so the freshly-expanded
    // rows are actually in the DOM by then.
    const handle = setTimeout(() => {
      const el = document.querySelector(`[data-node-id="${CSS.escape(targetId)}"]`) as HTMLElement | null;
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (typeof el.animate === 'function') {
        el.animate(
          [
            { backgroundColor: '#fef3c7', boxShadow: '0 0 0 3px #fde68a inset' },
            { backgroundColor: 'transparent', boxShadow: '0 0 0 0 transparent inset' },
          ],
          { duration: 1800, easing: 'ease-out' },
        );
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [tree, location.search]);

  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkStatusOpen, setBulkStatusOpen] = useState(false);
  const [bulkStatusValue, setBulkStatusValue] = useState('');
  const [bulkOwnerOpen, setBulkOwnerOpen] = useState(false);
  const [bulkOwnerValue, setBulkOwnerValue] = useState('');
  const [allTags, setAllTags] = useState<TagEntry[]>([]);
  const [peopleList, setPeopleList] = useState<PersonRef[]>([]);
  const [assetsList, setAssetsList] = useState<DataAssetRef[]>([]);
  const [policiesList, setPoliciesList] = useState<PolicyRef[]>([]);
  const [systemsList, setSystemsList] = useState<SystemRef[]>([]);
  // Governance controls for the Activity-level Controls picker.
  // Keeps id, code, and name — enough for the multi-select dropdown
  // and the chip labels.
  const [controlsList, setControlsList] = useState<Array<{ id: string; code: string; name: string; policyId: string }>>([]);
  const [mappingsByStep, setMappingsByStep] = useState<Record<string, MappingInfo[]>>({});
  // Per-node attachment counts, fetched in one bulk call so every node's
  // "Attach (n)" badge is populated up front (no fetch-per-node).
  const [attachmentCountByNode, setAttachmentCountByNode] = useState<Record<string, number>>({});
  // Skill-coverage map — keyed by nodeId. Populated for activity
  // nodes whose responsible person is missing one or more required
  // skills. Drives the warning chip rendered next to the Required
  // Skills picker on each node panel.
  const [skillCoverageByNode, setSkillCoverageByNode] = useState<Record<string, { personId: string; missingSkillNames: string[] }>>({});
  // When the user picks an asset whose owner org is on a different
  // vertical axis from the process node's value-stream org (e.g.
  // a Water activity reaching for an Electric asset, sibling
  // divisions), addMapping defers the POST and surfaces a
  // ConfirmDialog. Holds the link details until the user
  // confirms or cancels.
  const [pendingCrossLink, setPendingCrossLink] = useState<
    | { nodeId: string; target: AddMappingTarget; linkType: string; nodeName: string; assetName: string; assetOrgName: string; nodeOrgName: string }
    | null
  >(null);
  const [historyNodeId, setHistoryNodeId] = useState<string | null>(null);
  const [statusMode, setStatusMode] = useState<'simple' | 'review' | 'advanced'>('simple');
  const [showLevelGuide, setShowLevelGuide] = useState(false);
  // Simple / Advanced view mode — Simple is the default for newcomers
  // and hides the rarely-used per-level fields (Compliance, Frequency,
  // Risk Level, Automation, Est. Duration) plus the rarely-used node
  // levels in the legend. Toggle persists across visits.
  const [viewMode, setViewMode] = useState<'simple' | 'advanced'>(() => {
    try {
      return (localStorage.getItem('procela:catalog-view-mode') as 'simple' | 'advanced') || 'simple';
    } catch { return 'simple'; }
  });
  const setViewModePersist = (m: 'simple' | 'advanced') => {
    setViewMode(m);
    try { localStorage.setItem('procela:catalog-view-mode', m); } catch { /* noop */ }
  };

  // Agent execution state
  interface AgentExecutionInfo { id: string; agentId: string; agentName: string; activityId: string; status: string; output: string; error: string | null; reviewStatus: string; reviewedBy: string | null; completedAt: string | null; durationMs: number | null; createdAt: string; promotedDocumentId?: string | null; }
  interface DamaRoleInfo { agentId: string; agentName: string | null; roleType: string; }
  // Schedules are stored per-activity for the agent panel's list view.
  interface AgentScheduleInfo {
    id: string; orgId: string; agentId: string; agentName: string;
    activityId: string; activityName: string; roleType: string;
    frequency: 'ONCE' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY';
    status: 'ACTIVE' | 'PAUSED' | 'COMPLETED';
    startAt: string; nextRunAt: string; lastRunAt: string | null; runCount: number;
    createdAt: string; updatedAt: string;
  }
  const [agentExecByActivity, setAgentExecByActivity] = useState<Record<string, AgentExecutionInfo>>({});
  const [damaAgentRoles, setDamaAgentRoles] = useState<DamaRoleInfo[]>([]);
  const [schedulesByActivity, setSchedulesByActivity] = useState<Record<string, AgentScheduleInfo[]>>({});
  const [runningActivity, setRunningActivity] = useState<string | null>(null);
  // Agents available to run governance work — one entry per agent (an agent
  // may hold several DAMA roles; we only need it listed once in the picker).
  const agentRoleOptions = useMemo(
    () => Array.from(new Map(damaAgentRoles.map((r) => [r.agentId, r])).values()),
    [damaAgentRoles],
  );

  // Governance role assignments in this org — drives the role-gated
  // person pickers below. governanceHolderIds is the union (any
  // governance role) and powers Owner/Stakeholders on governance VS /
  // Process. holdersByRoleLabel is per-role and powers the Responsible
  // Person picker on activities.
  interface RoleAssignment { personId: string; roleType: string; }
  const [roleAssignments, setRoleAssignments] = useState<RoleAssignment[]>([]);

  const fetchData = useCallback(async () => {
    try {
      const qp = activeOrgId ? `?orgId=${activeOrgId}` : '';
      const [catalogRes, flowsRes, tagsRes, peopleRes, assetsRes, policiesRes, systemsRes, mappingsRes, rolesRes, coverageRes, controlsRes, attachCountsRes] = await Promise.all([
        apiClient.get<{ success: boolean; tree: ProcessNode[]; stats: any; validChildren: Record<string, string[]> }>(`/process-catalog${qp}`),
        apiClient.get<{ success: boolean; data: FlowRelationship[] }>('/process-catalog/flows'),
        apiClient.get<{ success: boolean; data: TagEntry[] }>(`/tags?entityType=ProcessNode${activeOrgId ? `&orgId=${activeOrgId}` : ''}`),
        apiClient.get<{ success: boolean; data: PersonRef[] }>('/people'),
        apiClient.get<{ success: boolean; data: DataAssetRef[] }>(`/data-assets${qp}`),
        // Pulled for the IOPanel governance-document picker so a
        // governance activity can be linked to the charter / policy
        // it produces or consumes.
        apiClient.get<{ success: boolean; data: PolicyRef[] }>(`/governance-policies${qp}`),
        apiClient.get<{ success: boolean; data: SystemRef[] }>(`/systems${qp}`),
        apiClient.get<{ success: boolean; data: MappingInfo[] }>(`/mappings${qp}`),
        apiClient.get<{ success: boolean; data: RoleAssignment[] }>(`/dama-roles${qp}`),
        activeOrgId
          ? apiClient.get<{ success: boolean; data: { byNode: Record<string, { personId: string; missingSkillNames: string[] }> } }>(`/skills/coverage?orgId=${encodeURIComponent(activeOrgId)}`).catch(() => ({ data: { byNode: {} } }))
          : Promise.resolve({ data: { byNode: {} } }),
        // Governance controls for the Activity-level Controls picker.
        // Catch so a controls-endpoint fault doesn't take down the whole
        // catalog — the picker just renders as empty.
        apiClient.get<{ success: boolean; data: Array<{ id: string; code: string; name: string; policyId: string }> }>(`/governance-controls${qp}`).catch(() => ({ data: [] })),
        // Bulk per-node attachment counts (one round-trip for the whole
        // tree). Catch so a counts fault just leaves badges blank.
        apiClient.get<{ success: boolean; data: Record<string, number> }>(`/attachments/counts?entityType=ProcessNode${activeOrgId ? `&orgId=${activeOrgId}` : ''}`).catch(() => ({ data: {} as Record<string, number> })),
      ]);
      setSkillCoverageByNode(coverageRes.data?.byNode || {});
      setAttachmentCountByNode(attachCountsRes.data || {});
      const byStep: Record<string, MappingInfo[]> = {};
      for (const m of (mappingsRes.data || [])) {
        if (!byStep[m.processStepId]) byStep[m.processStepId] = [];
        byStep[m.processStepId].push(m);
      }
      setMappingsByStep(byStep);
      setTree(catalogRes.tree || []);
      setStats(catalogRes.stats || {});
      setValidChildrenMap(catalogRes.validChildren || {});
      setFlows(flowsRes.data || []);
      setAllTags(tagsRes.data || []);
      setPeopleList((peopleRes.data || []).map((p) => ({ id: p.id, name: p.name })));
      setAssetsList((assetsRes.data || []).map((a) => ({ id: a.id, name: a.name, orgId: a.orgId })));
      setPoliciesList((policiesRes.data || []).map((p) => ({ id: p.id, name: p.name, code: p.code, documentType: p.documentType, orgId: p.orgId })));
      setSystemsList((systemsRes.data || []).map((s) => ({ id: s.id, name: s.name, systemType: s.systemType })));
      setControlsList((controlsRes.data || []).map((c) => ({ id: c.id, code: c.code, name: c.name, policyId: c.policyId })));
      setRoleAssignments((rolesRes.data || []).map((r) => ({ personId: r.personId, roleType: r.roleType })));
      // Fetch agent executions, DAMA roles, and schedules for agent-assigned activities
      try {
        const [execsRes, rolesRes, schedRes] = await Promise.all([
          apiClient.get<{ success: boolean; data: AgentExecutionInfo[] }>(`/agent-executions${qp}`),
          apiClient.get<{ success: boolean; data: DamaRoleInfo[] }>(`/dama-roles${qp}`),
          apiClient.get<{ success: boolean; data: AgentScheduleInfo[] }>(`/agent-schedules${qp}`),
        ]);
        // Group schedules by activityId so the panel can list them inline.
        const byActSched: Record<string, AgentScheduleInfo[]> = {};
        for (const s of (schedRes.data || [])) {
          (byActSched[s.activityId] = byActSched[s.activityId] || []).push(s);
        }
        setSchedulesByActivity(byActSched);
        // Build lookup: activityId -> latest execution
        const byActivity: Record<string, AgentExecutionInfo> = {};
        for (const ex of (execsRes.data || [])) {
          if (!byActivity[ex.activityId] || new Date(ex.createdAt) > new Date(byActivity[ex.activityId].createdAt)) {
            byActivity[ex.activityId] = ex;
          }
        }
        setAgentExecByActivity(byActivity);
        setDamaAgentRoles((rolesRes.data || []).filter((r) => r.agentId).map((r) => ({ agentId: r.agentId!, agentName: r.agentName, roleType: r.roleType })));
      } catch { /* agent execution data is optional */ }
      // Resolve org's statusMode
      if (activeOrgId) {
        try {
          const orgRes = await apiClient.get<{ success: boolean; data: { statusMode?: string } }>(`/organizations/${activeOrgId}`);
          setStatusMode((orgRes.data?.statusMode as 'simple' | 'review' | 'advanced') || 'simple');
        } catch { /* */ }
      }
    } catch { /* */ }
    finally { setLoading(false); }
  }, [activeOrgId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Resolve the tenant's active compliance-framework list so the activity
  // Compliance picker (in TreeNode) offers the org-configured set rather than
  // the hardcoded built-in constant. Fetched here once per org rather than in
  // each TreeNode, which renders per node.
  useEffect(() => { void useComplianceStore.getState().fetch(activeOrgId); }, [activeOrgId]);

  usePolling(fetchData, 30000);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  };

  const expandAll = () => {
    const allIds = new Set<string>();
    function collect(nodes: ProcessNode[]) {
      for (const n of nodes) { allIds.add(n.id); if (n.children) collect(n.children); }
    }
    collect(tree);
    setExpanded(allIds);
  };

  const addNode = async (parentId: string | null, name: string, description: string, level: NodeLevel) => {
    await apiClient.post('/process-catalog/nodes', { parentId, level, name, description, orgIds: activeOrgId ? [activeOrgId] : undefined });
    addToast('success', `${level.replace('_', ' ')} "${name}" created`);
    setAddingTo(null);
    fetchData();
  };

  const updateNode = async (id: string, data: Record<string, any>) => {
    // Look up current version from tree for optimistic locking
    const node = findNodeInTree(tree, id);
    const payload = node?.version !== undefined ? { ...data, version: node.version } : data;
    try {
      await apiClient.put(`/process-catalog/nodes/${id}`, payload);
      addToast('success', 'Saved');
      fetchData();
    } catch (err) {
      const e = err as { response?: { status?: number } };
      if (e?.response?.status === 409) {
        addToast('error', 'Modified by another user — refreshing');
        fetchData();
      } else {
        addToast('error', 'Failed to save');
        throw err;
      }
    }
  };

  const deleteNode = async (id: string) => {
    await apiClient.delete(`/process-catalog/nodes/${id}`);
    addToast('success', 'Process node deleted');
    fetchData();
  };

  const cloneNode = async (id: string) => {
    const node = findNodeInTree(tree, id);
    const name = prompt(`Clone "${node?.name || 'Value Stream'}" as:`, `${node?.name || 'Value Stream'} (copy)`);
    if (!name) return;
    try {
      const res = await apiClient.post<{ success: boolean; data: ProcessNode[]; message?: string }>(`/process-catalog/nodes/${id}/clone`, { name });
      addToast('success', res.message || 'Value stream cloned');
      fetchData();
    } catch {
      addToast('error', 'Failed to clone value stream');
    }
  };

  // Performs the actual link POST. Split out from addMapping so the
  // cross-division confirm path can call it directly after the
  // user accepts. Polymorphic on target kind — exactly one of
  // dataAssetId / policyId / attachmentId is sent.
  const submitMapping = async (nodeId: string, target: AddMappingTarget, linkType: string) => {
    try {
      const body: Record<string, any> = {
        processStepId: nodeId,
        linkType,
        notes: '',
        aiSuggested: false,
        ...(activeOrgId ? { orgId: activeOrgId } : {}),
        ...(target.fulfillsExpected ? { fulfillsExpected: target.fulfillsExpected } : {}),
      };
      if (target.kind === 'asset') body.dataAssetId = target.id;
      else if (target.kind === 'policy') body.policyId = target.id;
      else if (target.kind === 'attachment') body.attachmentId = target.id;
      await apiClient.post('/mappings', body);
      fetchData();
    } catch { /* */ }
  };

  // Entry point used by IOPanel. Runs the cross-division guard
  // before POSTing — if the target's owner org is on a different
  // vertical axis from any of the process node's orgIds (i.e.
  // sibling divisions), pop a confirm. Same-axis (parent <->
  // child, or identical) links go through silently. The guard
  // covers data-asset and policy targets; attachments are scoped
  // to the node directly so there's no cross-org concern.
  const addMapping = async (nodeId: string, target: AddMappingTarget, linkType: string) => {
    const node = findNodeInTree(tree, nodeId);
    const nodeOrgIds = node?.orgIds ?? [];
    let targetOrgId: string | undefined;
    let targetName = '';
    if (target.kind === 'asset') {
      const asset = assetsList.find((a) => a.id === target.id);
      targetOrgId = asset?.orgId;
      targetName = asset?.name || 'the asset';
    } else if (target.kind === 'policy') {
      const policy = policiesList.find((p) => p.id === target.id);
      targetOrgId = policy?.orgId;
      targetName = policy?.name || 'the document';
    }
    const onSameAxis = target.kind === 'attachment' || nodeOrgIds.length === 0 || !targetOrgId
      ? true
      : nodeOrgIds.some((nodeOrg) => isOrgInScope(targetOrgId, nodeOrg));
    if (!onSameAxis) {
      const nodeOrgName = getOrgName(nodeOrgIds[0]);
      const targetOrgName = getOrgName(targetOrgId);
      setPendingCrossLink({
        nodeId,
        target,
        linkType,
        nodeName: node?.name || 'this activity',
        assetName: targetName,
        assetOrgName: targetOrgName || 'a different division',
        nodeOrgName: nodeOrgName || 'this division',
      });
      return;
    }
    await submitMapping(nodeId, target, linkType);
  };

  const removeMapping = async (mappingId: string) => {
    try {
      await apiClient.delete(`/mappings/${mappingId}`);
      fetchData();
    } catch { /* */ }
  };

  // Recreates a mapping from a snapshot. Used as the Undo handler on
  // the toast that pops when a user unlinks an input/output — costs
  // nothing on the intentional click, saves a misclick. Bypasses the
  // cross-division guard (addMapping) because the user just had this
  // exact link and is restoring it; nothing to confirm.
  const restoreMapping = async (m: MappingInfo) => {
    try {
      const body: Record<string, any> = {
        processStepId: m.processStepId,
        linkType: m.linkType,
        notes: '',
        aiSuggested: false,
        ...(activeOrgId ? { orgId: activeOrgId } : {}),
        ...(m.dataAssetId ? { dataAssetId: m.dataAssetId } : {}),
        ...(m.policyId ? { policyId: m.policyId } : {}),
        ...(m.attachmentId ? { attachmentId: m.attachmentId } : {}),
        ...(m.fulfillsExpected ? { fulfillsExpected: m.fulfillsExpected } : {}),
        ...(m.criticality ? { criticality: m.criticality } : {}),
        ...(m.dataFormat ? { dataFormat: m.dataFormat } : {}),
        ...(m.sla ? { sla: m.sla } : {}),
        ...(m.qualityRequirement ? { qualityRequirement: m.qualityRequirement } : {}),
      };
      await apiClient.post('/mappings', body);
      fetchData();
    } catch { /* */ }
  };

  // ── Agent execution handler ──
  // The agent actually performs the governance activity: the backend assembles
  // the activity's context, runs it through the agent's instructions via Claude,
  // and returns a draft for review. The caller picks which assigned agent runs.
  const handleRunAgent = async (activityId: string, activityName: string, agentRole: { agentId: string; agentName: string | null; roleType: string }) => {
    setRunningActivity(activityId);
    try {
      const res = await apiClient.post<{ success: boolean; data: AgentExecutionInfo }>('/agent-executions', {
        orgId: activeOrgId,
        agentId: agentRole.agentId,
        activityId,
        activityName,
        roleType: agentRole.roleType,
      });
      if (res.data?.status === 'FAILED') {
        addToast('error', res.data.error || 'Agent run failed');
      } else {
        addToast('success', `${agentRole.agentName || 'Agent'} produced a draft — review it below`);
      }
      fetchData();
    } catch (err) {
      addToast('error', errorMessage(err, 'Execution failed'));
    } finally {
      setRunningActivity(null);
    }
  };

  // Approve / reject / reset the human review of an agent's draft.
  const handleReviewExecution = async (executionId: string, reviewStatus: 'APPROVED' | 'REJECTED' | 'PENDING') => {
    try {
      await apiClient.patch(`/agent-executions/${executionId}/review`, { reviewStatus, reviewedBy: currentUser?.name });
      addToast('success', reviewStatus === 'PENDING' ? 'Review reset' : `Draft ${reviewStatus.toLowerCase()}`);
      fetchData();
    } catch (err) {
      addToast('error', errorMessage(err, 'Failed to update review'));
    }
  };

  // Promote an approved agent draft to a real Governance Document and
  // attach it as an OUTPUT mapping of the activity. The backend does
  // all three (create doc, create mapping, mark execution APPROVED with
  // a promotedDocumentId back-link) in one call.
  const handlePromoteExecution = async (
    executionId: string,
    payload: { name: string; documentType: string; description?: string },
  ) => {
    try {
      await apiClient.post(`/agent-executions/${executionId}/promote`, {
        name: payload.name,
        documentType: payload.documentType,
        description: payload.description,
        reviewedBy: currentUser?.name,
      });
      addToast('success', 'Draft promoted to Governance Document');
      fetchData();
      return true;
    } catch (err) {
      addToast('error', errorMessage(err, 'Failed to promote draft'));
      return false;
    }
  };

  // ── Agent schedules ──
  const handleCreateSchedule = async (payload: {
    activityId: string; agentId: string; roleType: string;
    frequency: 'ONCE' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY';
    startAt: string;
  }): Promise<boolean> => {
    if (!activeOrgId) { addToast('error', 'Select an organization from the header first.'); return false; }
    try {
      await apiClient.post('/agent-schedules', {
        orgId: activeOrgId,
        agentId: payload.agentId,
        activityId: payload.activityId,
        roleType: payload.roleType,
        frequency: payload.frequency,
        startAt: payload.startAt,
      });
      addToast('success', payload.frequency === 'ONCE' ? 'One-time schedule created' : `${payload.frequency.toLowerCase()} schedule created`);
      fetchData();
      return true;
    } catch (err) {
      addToast('error', errorMessage(err, 'Failed to create schedule'));
      return false;
    }
  };
  const handleToggleSchedule = async (scheduleId: string, nextStatus: 'ACTIVE' | 'PAUSED'): Promise<void> => {
    try {
      await apiClient.patch(`/agent-schedules/${scheduleId}`, { status: nextStatus });
      addToast('success', nextStatus === 'PAUSED' ? 'Schedule paused' : 'Schedule resumed');
      fetchData();
    } catch (err) {
      addToast('error', errorMessage(err, 'Failed to update schedule'));
    }
  };
  const handleDeleteSchedule = async (scheduleId: string): Promise<void> => {
    try {
      await apiClient.delete(`/agent-schedules/${scheduleId}`);
      addToast('success', 'Schedule removed');
      fetchData();
    } catch (err) {
      addToast('error', errorMessage(err, 'Failed to remove schedule'));
    }
  };

  // ── Bulk select handlers ──
  const collectAllNodeIds = (nodes: ProcessNode[]): string[] => {
    const ids: string[] = [];
    function walk(arr: ProcessNode[]) {
      for (const n of arr) { ids.push(n.id); if (n.children) walk(n.children); }
    }
    walk(nodes);
    return ids;
  };
  const toggleNodeSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const allNodeIds = collectAllNodeIds(tree);
  const toggleSelectAllNodes = () => {
    if (selectedIds.size === allNodeIds.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(allNodeIds));
  };
  const handleBulkDeleteNodes = async () => {
    if (selectedIds.size === 0) return;
    // Delete sequentially. The backend cascades children, so a parent
    // delete may make later sibling/child deletes 404 — swallow those.
    let failures = 0;
    for (const id of Array.from(selectedIds)) {
      try { await apiClient.delete(`/process-catalog/nodes/${id}`); }
      catch { failures++; }
    }
    setSelectedIds(new Set());
    fetchData();
    if (failures > 0) {
      // Most failures are "already deleted by cascade" so demote to info.
      // eslint-disable-next-line no-console
      console.info(`${failures} delete(s) skipped — likely already removed by cascade.`);
    }
  };

  const handleBulkStatus = async () => {
    if (selectedIds.size === 0 || !bulkStatusValue) return;
    try {
      await Promise.all(Array.from(selectedIds).map((id) =>
        apiClient.put(`/process-catalog/nodes/${id}`, { status: bulkStatusValue }).catch(() => {})
      ));
      addToast('success', `Set ${selectedIds.size} node${selectedIds.size === 1 ? '' : 's'} to ${bulkStatusValue}`);
      setBulkStatusOpen(false);
      setBulkStatusValue('');
      setSelectedIds(new Set());
      fetchData();
    } catch { addToast('error', 'Bulk status change failed'); }
  };

  const handleBulkOwner = async () => {
    if (selectedIds.size === 0 || !bulkOwnerValue) return;
    try {
      await Promise.all(Array.from(selectedIds).map((id) =>
        apiClient.put(`/process-catalog/nodes/${id}`, { ownerId: bulkOwnerValue }).catch(() => {})
      ));
      const name = peopleList.find((p) => p.id === bulkOwnerValue)?.name || '';
      addToast('success', `Set ${name} as owner of ${selectedIds.size} node${selectedIds.size === 1 ? '' : 's'}`);
      setBulkOwnerOpen(false);
      setBulkOwnerValue('');
      setSelectedIds(new Set());
      fetchData();
    } catch { addToast('error', 'Bulk owner assignment failed'); }
  };

  const reorderNode = async (nodeId: string, direction: 'up' | 'down') => {
    // Find the node and its siblings in the tree
    function findSiblings(nodes: ProcessNode[]): ProcessNode[] | null {
      for (const n of nodes) {
        if (n.id === nodeId) return nodes;
        if (n.children) {
          const found = findSiblings(n.children);
          if (found) return found;
        }
      }
      return null;
    }
    const siblings = findSiblings(tree);
    if (!siblings) return;
    const idx = siblings.findIndex((n) => n.id === nodeId);
    if (idx < 0) return;
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= siblings.length) return;
    const current = siblings[idx];
    const swap = siblings[swapIdx];
    // Swap orderIndex values (include version for optimistic locking)
    try {
      await Promise.all([
        apiClient.put(`/process-catalog/nodes/${current.id}`, {
          orderIndex: swap.orderIndex,
          ...(current.version !== undefined ? { version: current.version } : {}),
        }),
        apiClient.put(`/process-catalog/nodes/${swap.id}`, {
          orderIndex: current.orderIndex,
          ...(swap.version !== undefined ? { version: swap.version } : {}),
        }),
      ]);
      fetchData();
    } catch (err) {
      const e = err as { response?: { status?: number } };
      if (e?.response?.status === 409) {
        alert('This item was modified by another user. The page will refresh.');
        fetchData();
      } else {
        throw err;
      }
    }
  };

  const showHistory = (nodeId: string) => { setHistoryNodeId(nodeId); };

  const addTag = async (nodeId: string, tag: string) => {
    try {
      await apiClient.post('/tags', { entityType: 'ProcessNode', entityId: nodeId, tag, orgId: activeOrgId });
      fetchData();
    } catch { /* duplicate or error */ }
  };

  const removeTag = async (tagId: string) => {
    try {
      await apiClient.delete(`/tags/${tagId}`);
      fetchData();
    } catch { /* */ }
  };

  const byLevel = stats.byLevel || {};
  const totalNodes = stats.total || 0;
  // Domain lens — value streams carry a governance/operational domain;
  // filtering at the root hides whole subtrees. Page-scoped (key
  // 'process-catalog'), and force-reset to All on entry so the catalog
  // always opens showing everything — without touching any other
  // page's lens (the bug this replaces). Switching it here only affects
  // this page.
  const domainLens = useDomainLens('process-catalog', 'ALL');
  const setLens = useDomainLensStore((s) => s.setLens);
  useEffect(() => {
    setLens('process-catalog', 'ALL');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const lensedTree = useMemo(
    () => tree.filter((vs) => passesLens(domainLens, processDomain(vs))),
    [tree, domainLens],
  );

  // Per-user level visibility. Users can hide whole hierarchy levels (e.g.
  // collapse the catalog to just Value Streams → Activities by hiding
  // Sub-Process) from the Legend chips; hidden levels have their children
  // promoted up so nothing is orphaned. View-only — never touches the data.
  const [hiddenLevels, setHiddenLevels] = useState<Set<NodeLevel>>(new Set());
  const toggleLevel = (level: NodeLevel) => setHiddenLevels((prev) => {
    const next = new Set(prev);
    next.has(level) ? next.delete(level) : next.add(level);
    return next;
  });
  const visibleTree = useMemo(
    () => pruneHiddenLevels(lensedTree, hiddenLevels),
    [lensedTree, hiddenLevels],
  );

  // Build the role-eligibility maps. Activity.responsibleRole is stored
  // as a label string (e.g. "Business Data Steward"); dama-roles uses
  // the roleType code ("BUSINESS_DATA_STEWARD"). Walk GOVERNANCE_ROLES
  // once to map label → roleType, then group personIds by both.
  const { governanceHolderIds, holdersByRoleLabel } = useMemo(() => {
    const roleTypeByLabel = new Map<string, string>();
    for (const r of GOVERNANCE_ROLES) roleTypeByLabel.set(r.label, r.roleType);
    const govHolders = new Set<string>();
    const byLabel = new Map<string, Set<string>>();
    const personsByRoleType = new Map<string, Set<string>>();
    for (const a of roleAssignments) {
      govHolders.add(a.personId);
      if (!personsByRoleType.has(a.roleType)) personsByRoleType.set(a.roleType, new Set());
      personsByRoleType.get(a.roleType)!.add(a.personId);
    }
    for (const r of GOVERNANCE_ROLES) {
      byLabel.set(r.label, personsByRoleType.get(r.roleType) || new Set());
    }
    return { governanceHolderIds: govHolders, holdersByRoleLabel: byLabel };
  }, [roleAssignments]);

  const issues = collectIssues(lensedTree);

  const buildProcessExport = (): ExportPayload => {
    const rows: string[][] = [];
    const walk = (nodes: ProcessNode[], ancestors: string[]) => {
      for (const node of nodes) {
        const path = [...ancestors, node.name];
        const cols: string[] = [];
        const levelIdx = ['VALUE_STREAM', 'PROCESS', 'SUBPROCESS', 'ACTIVITY', 'TASK'].indexOf(node.level);
        for (let i = 0; i < 5; i++) cols.push(i === levelIdx ? node.name : (i < levelIdx ? (path[i] || '') : ''));
        cols.push(node.level, node.status, node.description || '', node.responsibleRole || '', node.frequency || '');
        rows.push(cols);
        if (node.children?.length) walk(node.children, path);
      }
    };
    walk(tree, []);
    addToast('success', `Exported ${rows.length} process nodes`);
    return {
      filenameBase: 'process-hierarchy',
      sheetName: 'Process Hierarchy',
      headers: ['Value Stream', 'Process', 'Sub-Process', 'Activity', 'Task', 'Level', 'Status', 'Description', 'Responsible Role', 'Frequency'],
      rows,
    };
  };

  return (
    <div>
      {/* Header */}
      <PageHeader
        title="Process Catalog"
        subtitle={<>Define your business processes. Required path: <strong>Value Stream</strong> → <strong>Process</strong> → <strong>Activity</strong></>}
        meta={
          <>
            <DomainLensToggle pageKey="process-catalog" />
            {/* Simple ↔ Advanced view toggle — Simple hides Compliance,
                Frequency, Risk Level, Automation and Est. Duration from
                the per-node panel and downplays rare levels in the
                legend. Default is Simple for first-time users. */}
            <div role="tablist" aria-label="View detail" style={{
              display: 'inline-flex', border: '1px solid var(--color-border)',
              borderRadius: 999, overflow: 'hidden', background: 'var(--color-surface)',
            }}>
              {(['simple', 'advanced'] as const).map((m) => {
                const active = viewMode === m;
                return (
                  <button
                    key={m}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setViewModePersist(m)}
                    title={m === 'simple' ? 'Hide rarely-used fields and levels' : 'Show every field and level'}
                    style={{
                      padding: '4px 12px', fontSize: 11,
                      fontWeight: active ? 600 : 400, border: 'none', cursor: 'pointer',
                      background: active ? 'var(--color-primary)' : 'transparent',
                      color: active ? '#fff' : 'var(--color-text)',
                    }}
                  >
                    {m === 'simple' ? 'Simple' : 'Advanced'}
                  </button>
                );
              })}
            </div>
            {/* Read-only indicator for the org's status lifecycle mode.
                The actual toggle lives in Settings — pinning it here
                would confuse users into thinking it's page-local. */}
            <span
              title={`Status lifecycle for ${statusMode === 'advanced' ? 'this org is Advanced (6 statuses: Draft → Proposed → Under Review → Approved → Active → Deprecated)' : 'this org is Simple (3 statuses: Draft → Active → Deprecated)'}. Change in Settings → Process & Asset Lifecycle.`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '4px 10px', borderRadius: 999,
                fontSize: 11, fontWeight: 500,
                background: 'var(--color-bg)', color: 'var(--color-text-muted)',
                border: '1px solid var(--color-border)',
              }}
            >
              Lifecycle: <strong style={{ color: 'var(--color-text)', fontWeight: 600 }}>{statusMode === 'advanced' ? 'Advanced' : 'Simple'}</strong>
              <button
                type="button"
                onClick={() => navigate('/settings')}
                title="Change lifecycle mode in Settings"
                style={{
                  padding: 0, marginLeft: 2, background: 'transparent',
                  border: 'none', cursor: 'pointer',
                  color: 'var(--color-primary)', fontSize: 11, fontWeight: 500,
                }}
              >
                Change
              </button>
            </span>
          </>
        }
        actions={
          canCreateValueStreams ? (
            <>
              {totalNodes > 0 && (
                <IconButton icon="eye" label="Visualize"
                  onClick={() => navigate('/processes/visualization')} />
              )}
              {(byLevel.VALUE_STREAM || 0) >= 2 && (
                <IconButton icon="refresh" label="Compare value streams"
                  onClick={() => navigate('/processes/compare')} />
              )}
              {canWrite && canCreateHere && aiEnabled && (
                <IconButton icon="wand"
                  label="Generate from industry template"
                  onClick={() => navigate('/processes/wizard')} />
              )}
              {canWrite && canCreateGovernanceHere && (
                <IconButton icon="users"
                  variant="secondary"
                  label={
                    tree.some((n) => n.name.includes('Governance') || n.name.includes('Data Management'))
                      ? 'Governance processes already exist'
                      : 'Generate governance processes'
                  }
                  disabled={tree.some((n) => n.name.includes('Governance') || n.name.includes('Data Management'))}
                  onClick={() => navigate('/processes/wizard?mode=governance')}
                />
              )}
              {totalNodes > 0 && (
                <ExportMenu build={buildProcessExport} label="Export process hierarchy" />
              )}
              {canContribute && canCreateHere && (
                <IconButton icon="plus" label="Add value stream" variant="primary"
                  onClick={() => setAddingTo('__root__')} />
              )}
            </>
          ) : totalNodes > 0 ? (
            <>
              <IconButton icon="eye" label="Visualize"
                onClick={() => navigate('/processes/visualization')} />
              {(byLevel.VALUE_STREAM || 0) >= 2 && (
                <IconButton icon="refresh" label="Compare value streams"
                  onClick={() => navigate('/processes/compare')} />
              )}
            </>
          ) : undefined
        }
      >
        <HelpPopover id="process-catalog-overview" title="Process hierarchy">
          The required path is Value Stream → Process → Activity. Optional
          levels (Domain, Capability, Sub-Process, Task) sit between for
          detail when you need it. A Value Stream can't go ACTIVE until at
          least one Process and one Activity exist underneath.
        </HelpPopover>
      </PageHeader>

      {/* Org restriction notice */}
      {!activeOrgId && (
        <div style={{ background: '#fef3c7', border: '1px solid #f59e0b33', borderRadius: 'var(--radius-md)', padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#92400e' }}>
          Select a <strong>company or division</strong> from the "Working in" dropdown above to create and manage value streams.
        </div>
      )}
      {activeOrgId && !canCreateValueStreams && <CreateScopeNotice noun="value streams" />}
      {activeOrgId && canCreateValueStreams && companyWithDivisions && (
        <div style={{ background: '#fef3c7', border: '1px solid #f59e0b33', borderRadius: 'var(--radius-md)', padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#92400e' }}>
          <div>
            <strong>{activeOrgName}</strong> has {subtreeDivisions.length === 1 ? 'a division' : `${subtreeDivisions.length} divisions`}. <strong>Operational</strong> value streams almost always live at the division level so each division gets its own process catalog. <strong>Governance</strong> processes are the exception — they stay corporate (one enterprise-wide program), so the <em>Generate governance processes</em> wand still works here.
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            <span style={{ fontSize: 12, alignSelf: 'center', marginRight: 2 }}>Switch to:</span>
            {subtreeDivisions.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => setActiveOrg(d.id, d.name, 'division')}
                style={{
                  padding: '4px 10px', fontSize: 12, fontWeight: 500,
                  background: '#fff', color: '#92400e',
                  border: '1px solid #f59e0b', borderRadius: 999, cursor: 'pointer',
                }}
              >
                {d.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Legend */}
      {totalNodes > 0 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          {Object.entries(LEVEL_CONFIG).map(([level, config]) => {
            const count = byLevel[level] || 0;
            if (count === 0 && !config.required) return null;
            const hidden = hiddenLevels.has(level as NodeLevel);
            // Chips with rows in the tree double as show/hide toggles for that
            // level; empty (count 0) required chips stay non-interactive.
            const interactive = count > 0;
            return (
              <button
                key={level}
                type="button"
                onClick={interactive ? () => toggleLevel(level as NodeLevel) : undefined}
                disabled={!interactive}
                aria-pressed={interactive ? !hidden : undefined}
                title={interactive
                  ? `${config.hint}\n\nClick to ${hidden ? 'show' : 'hide'} ${config.plural} in the tree.`
                  : config.hint}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  background: hidden ? '#f8fafc' : (count > 0 ? config.bg : '#f8fafc'),
                  color: hidden ? '#94a3b8' : (count > 0 ? config.color : '#94a3b8'),
                  borderRadius: 4, padding: '3px 8px', fontSize: 11, fontWeight: 500,
                  border: config.required ? `1px solid ${(hidden ? '#94a3b8' : (count > 0 ? config.color : '#94a3b8'))}33` : '1px solid transparent',
                  cursor: interactive ? 'pointer' : 'default',
                  textDecoration: hidden ? 'line-through' : 'none',
                  opacity: hidden ? 0.7 : 1,
                  fontFamily: 'inherit',
                }}
              >
                {config.icon} {count} {count === 1 ? config.label : config.plural}
                {config.required && <span style={{ fontSize: 8 }}>*</span>}
              </button>
            );
          })}
          <span style={{ fontSize: 10, color: 'var(--color-text-muted)', marginLeft: 4 }}>* = required · click a level to show / hide it</span>
          <button
            onClick={() => setShowLevelGuide(!showLevelGuide)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 10, color: 'var(--color-primary)', marginLeft: 'auto', padding: 0 }}
          >
            {showLevelGuide ? 'Hide' : 'What do these levels mean?'}
          </button>
        </div>
      )}
      {showLevelGuide && totalNodes > 0 && (
        <div style={{
          background: 'var(--color-primary-light)', border: '1px solid var(--color-primary)', borderRadius: 'var(--radius-md)',
          padding: '12px 16px', marginBottom: 12, fontSize: 12, lineHeight: 1.6,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--color-primary)' }}>Process Hierarchy Guide</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div><strong>Value Stream *</strong> — A major end-to-end business flow, like "Customer Onboarding" or "Order Fulfillment."</div>
            <div><strong>Process *</strong> — A specific procedure within a value stream, like "Verify Identity" or "Generate Invoice."</div>
            <div><strong>Activity *</strong> — A concrete unit of work with clear inputs and outputs, like "Run credit check" or "Send welcome email."</div>
            <div><strong>Sub-Process</strong> — Optional grouping of related activities within a process.</div>
            <div><strong>Domain / Capability</strong> — Optional higher-level groupings for large organizations.</div>
            <div><strong>Task / Execution</strong> — Optional granular detail or system-level steps within an activity.</div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-primary)', marginTop: 8 }}>
            Start by adding a Value Stream, then add Processes inside it, then Activities inside those. The other levels are optional.
          </div>
        </div>
      )}

      {/* Toolbar */}
      {tree.length > 0 && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 8, alignItems: 'center' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, color: 'var(--color-text-secondary)' }}>
            <input
              type="checkbox"
              checked={allNodeIds.length > 0 && selectedIds.size === allNodeIds.length}
              onChange={toggleSelectAllNodes}
            />
            Select all
          </label>
          <button style={{ ...btnIcon, fontSize: 12, color: 'var(--color-primary)' }} onClick={expandAll}>Expand All</button>
          <button style={{ ...btnIcon, fontSize: 12, color: 'var(--color-primary)' }} onClick={() => setExpanded(new Set())}>Collapse All</button>
          <span style={{ fontSize: 10, color: 'var(--color-text-muted)', marginLeft: 'auto' }}>
            Click any name or description to edit. Optional levels can be added at any time.
          </span>
        </div>
      )}

      <BulkActionBar count={selectedIds.size} onClear={() => setSelectedIds(new Set())}>
        <BulkActionButton variant="primary" onClick={() => setBulkStatusOpen(true)}>Set Status…</BulkActionButton>
        <BulkActionButton onClick={() => setBulkOwnerOpen(true)}>Set Owner…</BulkActionButton>
        <BulkActionButton variant="danger" onClick={() => setConfirmBulkDelete(true)}>Delete Selected</BulkActionButton>
        <span style={{ fontSize: 11, color: 'var(--color-text-muted)', marginLeft: 'auto' }}>
          Note: deleting a parent removes its descendants too.
        </span>
      </BulkActionBar>

      <ConfirmDialog
        open={confirmBulkDelete}
        title="Delete Selected Process Nodes?"
        message={`Delete ${selectedIds.size} selected process nodes and any descendants? This cannot be undone.`}
        confirmLabel="Delete Selected"
        onConfirm={async () => { setConfirmBulkDelete(false); await handleBulkDeleteNodes(); }}
        onCancel={() => setConfirmBulkDelete(false)}
      />

      {/* Cross-division link confirm. Fires when the asset's owner
          org isn't on the same vertical axis as the process node's
          org — i.e. Tidewater Water activity linking to a Tidewater
          Electric asset. Default is "warn" not "block": confirming
          creates the link normally, but the user has to acknowledge
          the cross-division reference first because it almost
          always means the wrong asset was picked. */}
      <ConfirmDialog
        open={!!pendingCrossLink}
        title="Link across divisions?"
        message={pendingCrossLink
          ? `${pendingCrossLink.assetName} is owned by ${pendingCrossLink.assetOrgName}, but ${pendingCrossLink.nodeName} sits in ${pendingCrossLink.nodeOrgName}. Cross-division links usually mean the wrong asset was picked — pick again, or confirm if this is genuinely a shared dependency.`
          : ''}
        confirmLabel="Link anyway"
        variant="primary"
        onConfirm={async () => {
          if (!pendingCrossLink) return;
          const { nodeId, target, linkType } = pendingCrossLink;
          setPendingCrossLink(null);
          await submitMapping(nodeId, target, linkType);
        }}
        onCancel={() => setPendingCrossLink(null)}
      />

      {/* Bulk Status Dialog */}
      <ConfirmDialog
        open={bulkStatusOpen}
        title={`Set status for ${selectedIds.size} process node${selectedIds.size === 1 ? '' : 's'}`}
        message=""
        confirmLabel={bulkStatusValue ? `Set to ${bulkStatusValue}` : 'Select a status'}
        variant="primary"
        onConfirm={handleBulkStatus}
        onCancel={() => { setBulkStatusOpen(false); setBulkStatusValue(''); }}
      >
        <div style={{ marginTop: 8 }}>
          <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12 }}>
            This will change the status for all selected nodes. Status lifecycle rules are bypassed for bulk operations.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {['DRAFT', 'ACTIVE', 'DEPRECATED'].map((s) => (
              <label key={s} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                background: bulkStatusValue === s ? '#eff6ff' : 'var(--color-bg)',
                border: `1px solid ${bulkStatusValue === s ? '#93c5fd' : 'var(--color-border)'}`,
                borderRadius: 'var(--radius-md)', cursor: 'pointer',
              }}>
                <input type="radio" name="bulkProcStatus" checked={bulkStatusValue === s} onChange={() => setBulkStatusValue(s)} />
                <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: s === 'ACTIVE' ? '#22c55e' : s === 'DEPRECATED' ? '#ef4444' : '#9ca3af' }} />
                <span style={{ fontSize: 13, fontWeight: 500 }}>{s.charAt(0) + s.slice(1).toLowerCase()}</span>
              </label>
            ))}
          </div>
        </div>
      </ConfirmDialog>

      {/* Bulk Owner Dialog */}
      <ConfirmDialog
        open={bulkOwnerOpen}
        title={`Set owner for ${selectedIds.size} process node${selectedIds.size === 1 ? '' : 's'}`}
        message=""
        confirmLabel={bulkOwnerValue ? 'Set Owner' : 'Select a person'}
        variant="primary"
        onConfirm={handleBulkOwner}
        onCancel={() => { setBulkOwnerOpen(false); setBulkOwnerValue(''); }}
      >
        <div style={{ marginTop: 8 }}>
          <PersonPicker
            mode="single"
            valueMode="id"
            value={bulkOwnerValue || null}
            onChange={(id) => setBulkOwnerValue(id || '')}
            placeholder="-- Select person --"
          />
        </div>
      </ConfirmDialog>

      {/* Validation summary */}
      {issues.length > 0 && (
        <div style={{ background: '#fef3c7', border: '1px solid #f59e0b33', borderRadius: 'var(--radius-md)', padding: '10px 14px', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: issues.length > 3 ? 6 : 0 }}>
            <span style={{ fontSize: 14 }}>{'\u26A0'}</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#92400e' }}>
              {issues.length} {issues.length === 1 ? 'issue' : 'issues'} to resolve before processes can be set to Active
            </span>
          </div>
          {issues.slice(0, 5).map((issue, i) => (
            <div key={i} style={{ fontSize: 11, color: '#92400e', marginLeft: 22, marginTop: 2 }}>
              <strong>{issue.nodeName}</strong> ({LEVEL_CONFIG[issue.level].label}): {issue.issue}
            </div>
          ))}
          {issues.length > 5 && (
            <div style={{ fontSize: 11, color: '#92400e', marginLeft: 22, marginTop: 2 }}>
              ...and {issues.length - 5} more
            </div>
          )}
        </div>
      )}

      {/* Ownership gap warning */}
      {tree.length > 0 && (() => {
        const countAll = (nodes: ProcessNode[]): number => nodes.reduce((s: number, n) => s + 1 + countAll(n.children || []), 0);
        const countOwnerless = (nodes: ProcessNode[]): number => nodes.reduce((s: number, n) => s + (!n.ownerId && ['VALUE_STREAM', 'PROCESS'].includes(n.level) ? 1 : 0) + countOwnerless(n.children || []), 0);
        const ownerless = countOwnerless(tree);
        if (ownerless === 0) return null;
        return (
          <div style={{ padding: '8px 14px', marginBottom: 12, borderRadius: 'var(--radius-md)', background: '#fef2f2', border: '1px solid #fca5a5', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#991b1b' }}>
            <span style={{ fontWeight: 700 }}>{ownerless}</span> value stream{ownerless !== 1 ? 's' : ''} or process{ownerless !== 1 ? 'es have' : ' has'} no owner assigned
          </div>
        );
      })()}

      <DomainLensActiveBanner pageKey="process-catalog" entityLabel="value streams" />

      {/* Add root form */}
      {addingTo === '__root__' && (
        <div style={{ marginBottom: 12 }}>
          <AddNodeForm validChildren={['VALUE_STREAM']}
            onAdd={(name, desc, level) => addNode(null, name, desc, level)}
            onCancel={() => setAddingTo(null)} />
        </div>
      )}

      {/* Tree */}
      <Card padding={0} shadow="none" style={{ overflow: 'hidden', minHeight: 300 }}>
        {loading ? (
          <SkeletonRows rows={5} columns={4} />
        ) : tree.length === 0 && addingTo !== '__root__' ? (
          <div style={{ textAlign: 'center', padding: '3rem 2rem' }}>
            <div style={{ marginBottom: 20 }}>
              <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Get started with your process hierarchy</h2>
              <p style={{ color: 'var(--color-text-secondary)', fontSize: 13, maxWidth: 500, margin: '0 auto', lineHeight: 1.6 }}>
                Every process in Procela follows a simple required path:
              </p>
            </div>

            {/* Visual guide */}
            <div style={{ display: 'flex', justifyContent: 'center', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
              {(['VALUE_STREAM', 'PROCESS', 'ACTIVITY'] as NodeLevel[]).map((level, i) => {
                const config = LEVEL_CONFIG[level];
                const examples: Record<string, string> = {
                  VALUE_STREAM: 'e.g. "Customer Onboarding," "Order Fulfillment"',
                  PROCESS: 'e.g. "Verify Identity," "Generate Invoice"',
                  ACTIVITY: 'e.g. "Check credit score," "Send confirmation email"',
                };
                return (
                  <div key={level} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{
                      background: config.bg, color: config.color, borderRadius: 8,
                      padding: '12px 16px', textAlign: 'center', minWidth: 140,
                      border: `2px solid ${config.color}44`,
                    }}>
                      <div style={{ fontSize: 20, marginBottom: 4 }}>{config.icon}</div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{config.label}</div>
                      <div style={{ fontSize: 10, opacity: 0.8, marginTop: 2 }}>{config.hint.split('.')[0]}</div>
                      <div style={{ fontSize: 10, fontStyle: 'italic', opacity: 0.7, marginTop: 4 }}>{examples[level]}</div>
                    </div>
                    {i < 2 && <span style={{ fontSize: 20, color: 'var(--color-text-muted)' }}>{'\u2192'}</span>}
                  </div>
                );
              })}
            </div>

            <p style={{ color: 'var(--color-text-muted)', fontSize: 12, marginBottom: 20 }}>
              Start simple, then add optional levels (Domain, Capability, Sub-Process, Task, Execution) as you need more detail.
            </p>

            {canCreateHere ? (
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                {aiEnabled && (
                <button onClick={() => navigate('/processes/wizard')}
                  style={{ padding: '10px 24px', background: 'var(--color-primary)', color: '#fff', border: 'none', borderRadius: 'var(--radius-md)', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>
                  Generate from Industry Template
                </button>
                )}
                <button onClick={() => setAddingTo('__root__')}
                  style={{ padding: '10px 24px', background: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>
                  Custom
                </button>
              </div>
            ) : (
              <p style={{ color: '#92400e', fontSize: 13 }}>
                {companyWithDivisions
                  ? <>Pick a division from the "Working in" dropdown to add value streams here.</>
                  : <>Select a <strong>company or division</strong> from the "Working in" dropdown to get started.</>}
              </p>
            )}
          </div>
        ) : lensedTree.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '3rem 2rem', color: 'var(--color-text-secondary)', fontSize: 13 }}>
            No {domainLens === 'GOVERNANCE' ? 'governance' : 'operational'} value streams.
            {' '}Switch the lens above to see {domainLens === 'GOVERNANCE' ? 'operational' : 'governance'} processes.
          </div>
        ) : visibleTree.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '3rem 2rem', color: 'var(--color-text-secondary)', fontSize: 13 }}>
            Every level is hidden. Re-enable a level in the Legend above to see the catalog.
          </div>
        ) : (
          visibleTree.map((node, idx) => (
            <TreeNode key={node.id} node={node} depth={0}
              onUpdate={updateNode} onDelete={deleteNode} onClone={cloneNode}
              onAddChild={(parentId) => setAddingTo(parentId)}
              expanded={expanded} toggleExpand={toggleExpand}
              selectedIds={selectedIds} toggleSelect={toggleNodeSelect}
              validChildrenMap={validChildrenMap} flows={flows}
              activitiesFlat={activitiesFlat}
              valueStreamName={node.level === 'VALUE_STREAM' ? node.name : ''}
              controlsList={controlsList}
              siblingIndex={idx} siblingCount={visibleTree.length} onReorder={reorderNode}
              onShowHistory={showHistory}
              allTags={allTags}
              onAddTag={addTag}
              onRemoveTag={removeTag}
              peopleList={peopleList}
              assetsList={assetsList}
              policiesList={policiesList}
              systemsList={systemsList}
              mappingsByStep={mappingsByStep}
              attachmentCountByNode={attachmentCountByNode}
              skillCoverageByNode={skillCoverageByNode}
              activePageOrgId={activeOrgId || ''}
              onAddMapping={addMapping}
              onRemoveMapping={removeMapping}
              onRestoreMapping={restoreMapping}
              statusMode={statusMode}
              agentExecByActivity={agentExecByActivity}
              onRunAgent={aiEnabled ? handleRunAgent : undefined}
              onReviewExecution={handleReviewExecution}
              onPromoteExecution={handlePromoteExecution}
              runningActivity={runningActivity}
              agentRoles={agentRoleOptions}
              governanceHolderIds={governanceHolderIds}
              holdersByRoleLabel={holdersByRoleLabel}
              viewMode={viewMode}
              ancestorStatusChain={[]}
              schedulesByActivity={schedulesByActivity}
              onCreateSchedule={handleCreateSchedule}
              onToggleSchedule={handleToggleSchedule}
              onDeleteSchedule={handleDeleteSchedule} />
          ))
        )}
      </Card>

      {/* Add child form */}
      {addingTo && addingTo !== '__root__' && (() => {
        const parentNode = findNodeInTree(tree, addingTo);
        if (!parentNode) return null;
        const validChildren = (validChildrenMap[parentNode.level] || []) as NodeLevel[];
        if (validChildren.length === 0) return null;
        return (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 4 }}>
              Adding to: <strong>{parentNode.name}</strong> ({LEVEL_CONFIG[parentNode.level].label})
            </div>
            <AddNodeForm validChildren={validChildren}
              onAdd={(name, desc, level) => addNode(addingTo, name, desc, level)}
              onCancel={() => setAddingTo(null)} />
          </div>
        );
      })()}

      {historyNodeId && (
        <Suspense fallback={null}>
          <VersionHistoryModal nodeId={historyNodeId} onClose={() => setHistoryNodeId(null)} />
        </Suspense>
      )}
    </div>
  );
}
