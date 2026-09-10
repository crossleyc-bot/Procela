import { useState } from 'react';
import { Bot, Paperclip, Lock } from 'lucide-react';
import { clickable } from '../../lib/a11y';
import StatusBadge from '../../components/StatusBadge';
import SkillPicker from '../../components/SkillPicker';
import UnqualifiedPersonChip from '../../components/UnqualifiedPersonChip';
import AttachmentsPanel from '../../components/AttachmentsPanel';
import FieldStack from '../../components/FieldStack';
import SectionLabel from '../../components/SectionLabel';
import Modal from '../../components/Modal';
import {
  InlineEdit, DocField, DocDropdown, TierField, RtoField, RpoField,
  ControlsPicker, DocPersonField, DocRoleField, DocMultiSelect,
  DocSystemsField,
} from './DocFields';
import DependenciesPanel from './DependenciesPanel';
import IOPanel, { type AddMappingTarget } from './IOPanel';
import {
  inputStyle, btnIcon, btnAdd,
  LEVEL_CONFIG, statusColors,
  SIMPLE_TRANSITIONS, REVIEW_TRANSITIONS, ADVANCED_TRANSITIONS,
  SIMPLE_LOCKED, REVIEW_LOCKED, ADVANCED_LOCKED,
  FREQUENCY_OPTIONS, RISK_OPTIONS, TRIGGER_OPTIONS,
  countByLevel, hasRequiredPath, getRequiredNextLevel,
  type ProcessNode, type NodeLevel,
  type FlowRelationship, type TagEntry,
  type PersonRef, type SystemRef,
  type DataAssetRef, type PolicyRef, type MappingInfo,
} from '../ProcessCatalogPage';
import { useComplianceFrameworks } from '../../stores/complianceStore';

// ── Tree Node ──

function TreeNode({ node, depth, onUpdate, onDelete, onClone, onAddChild, expanded, toggleExpand, validChildrenMap, flows, activitiesFlat, valueStreamName, controlsList, siblingIndex, siblingCount, onReorder, onShowHistory, allTags, onAddTag, onRemoveTag, selectedIds, toggleSelect, peopleList, assetsList, policiesList, systemsList, mappingsByStep, attachmentCountByNode, skillCoverageByNode, activePageOrgId, onAddMapping, onRemoveMapping, onRestoreMapping, statusMode, agentExecByActivity, onRunAgent, onReviewExecution, onPromoteExecution, runningActivity, agentRoles, governanceHolderIds, holdersByRoleLabel, viewMode, ancestorStatusChain, schedulesByActivity, onCreateSchedule, onToggleSchedule, onDeleteSchedule }: {
  node: ProcessNode; depth: number;
  onUpdate: (id: string, data: Record<string, any>) => void;
  onDelete: (id: string) => void;
  onClone: (id: string) => void;
  onAddChild: (parentId: string) => void;
  expanded: Set<string>; toggleExpand: (id: string) => void;
  validChildrenMap: Record<string, string[]>;
  flows: FlowRelationship[];
  /** Flat list of every ACTIVITY node in the current tree with its
   *  value stream name, threaded from the top-level render so
   *  DependenciesPanel's add-picker doesn't need to walk the tree. */
  activitiesFlat: Array<{ id: string; name: string; valueStreamName: string }>;
  /** Name of the value stream this node belongs to; empty string at
   *  the value-stream row itself and above. Used by the Dependencies
   *  panel to flag cross-stream picks. */
  valueStreamName: string;
  /** Governance controls available for the Activity-level Controls
   *  picker. Threaded from the top-level fetch so each row doesn't
   *  have to fire its own request. */
  controlsList: Array<{ id: string; code: string; name: string; policyId: string }>;
  peopleList: PersonRef[];
  assetsList: DataAssetRef[];
  policiesList: PolicyRef[];
  systemsList: SystemRef[];
  mappingsByStep: Record<string, MappingInfo[]>;
  /** Per-node attachment counts (bulk-fetched once by the page) so every
   *  node's "Attach (n)" badge is populated without a per-node request. */
  attachmentCountByNode: Record<string, number>;
  /** Per-node skill-coverage lookup. Populated for activity nodes
   *  whose responsible person is missing one or more required
   *  skills. Drives a warning chip next to the Required Skills
   *  picker so the operator sees the mismatch without having to
   *  cross-reference the People page. */
  skillCoverageByNode: Record<string, { personId: string; missingSkillNames: string[] }>;
  activePageOrgId: string;
  onAddMapping: (nodeId: string, target: AddMappingTarget, linkType: string) => void;
  onRemoveMapping: (mappingId: string) => void;
  onRestoreMapping: (snapshot: MappingInfo) => void;
  statusMode: 'simple' | 'review' | 'advanced';
  siblingIndex: number;
  siblingCount: number;
  onReorder: (nodeId: string, direction: 'up' | 'down') => void;
  onShowHistory: (nodeId: string) => void;
  allTags: TagEntry[];
  onAddTag: (nodeId: string, tag: string) => void;
  onRemoveTag: (tagId: string) => void;
  selectedIds: Set<string>;
  toggleSelect: (id: string) => void;
  agentExecByActivity?: Record<string, { id: string; status: string; output: string; error: string | null; reviewStatus: string; reviewedBy: string | null; completedAt: string | null; agentName: string; durationMs: number | null; promotedDocumentId?: string | null }>;
  onRunAgent?: (activityId: string, activityName: string, agentRole: { agentId: string; agentName: string | null; roleType: string }) => void;
  onReviewExecution?: (executionId: string, reviewStatus: 'APPROVED' | 'REJECTED' | 'PENDING') => void;
  onPromoteExecution?: (executionId: string, payload: { name: string; documentType: string; description?: string }) => Promise<boolean>;
  /** Status of each ancestor from root to immediate parent. Empty at the
   *  top level. Used to warn when an agent is about to run, or a draft is
   *  about to be promoted, against an unfinished part of the catalogue. */
  ancestorStatusChain?: Array<{ level: string; status: string; name: string }>;
  /** Schedules grouped by activityId — used by the agent panel to list
   *  active and paused schedules inline. */
  schedulesByActivity?: Record<string, Array<{
    id: string; agentId: string; agentName: string; roleType: string;
    frequency: 'ONCE' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY';
    status: 'ACTIVE' | 'PAUSED' | 'COMPLETED';
    nextRunAt: string; lastRunAt: string | null; runCount: number;
  }>>;
  onCreateSchedule?: (payload: {
    activityId: string; agentId: string; roleType: string;
    frequency: 'ONCE' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY';
    startAt: string;
  }) => Promise<boolean>;
  onToggleSchedule?: (scheduleId: string, nextStatus: 'ACTIVE' | 'PAUSED') => Promise<void>;
  onDeleteSchedule?: (scheduleId: string) => Promise<void>;
  runningActivity?: string | null;
  /** Agents available to run governance work (one entry per agent). */
  agentRoles?: Array<{ agentId: string; agentName: string | null; roleType: string }>;
  /** Union of personIds holding ANY governance role in this org —
   *  used to gate Owner / Stakeholders on governance value streams
   *  and processes. */
  governanceHolderIds: Set<string>;
  /** Per-role-label → personIds. Used by the Responsible Person picker
   *  on activities to restrict to people who hold the activity's
   *  Responsible Role. */
  holdersByRoleLabel: Map<string, Set<string>>;
  /** Simple hides Compliance, Frequency, Risk Level, Automation and
   *  Est. Duration from the per-node panel. Advanced shows everything. */
  viewMode: 'simple' | 'advanced';
}) {
  // The tenant's active compliance-framework list (org-configurable in
  // Settings → Data). Drives the Compliance picker options; already-selected
  // tags outside this set still render as chips.
  const complianceFrameworks = useComplianceFrameworks();
  const [showTagInput, setShowTagInput] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const [pendingStatus, setPendingStatus] = useState<string | null>(null);
  const [reviewCommentDraft, setReviewCommentDraft] = useState('');
  // Attachments live behind the "Attach" button in the action row (the
  // same affordance at every level), opened in a modal. The badge count
  // comes from the page's bulk fetch (attachmentCountByNode); after an
  // upload/delete in the modal we override it locally for this node so the
  // badge updates immediately, without re-fetching the whole tree.
  const [showAttachments, setShowAttachments] = useState(false);
  const [attachmentCountOverride, setAttachmentCountOverride] = useState<number | null>(null);
  const attachmentCount = attachmentCountOverride ?? attachmentCountByNode[node.id] ?? 0;
  // Which available agent to run on this activity, and whether the produced
  // draft is expanded for review.
  const [runAgentId, setRunAgentId] = useState('');
  const [showAgentResult, setShowAgentResult] = useState(false);
  // Schedule inline form state. When `scheduleFormOpen` is true the form
  // is rendered beneath the Run / Schedule button row.
  const [scheduleFormOpen, setScheduleFormOpen] = useState(false);
  const [scheduleFrequency, setScheduleFrequency] = useState<'ONCE' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY'>('DAILY');
  // datetime-local stores naive "YYYY-MM-DDTHH:mm"; default to roughly
  // "ten minutes from now" so a user who just clicks Save doesn't get
  // an instantly-firing run they didn't intend.
  const defaultScheduleStart = () => {
    const d = new Date(Date.now() + 10 * 60 * 1000);
    d.setSeconds(0, 0);
    return d.toISOString().slice(0, 16);
  };
  const [scheduleStartLocal, setScheduleStartLocal] = useState<string>(defaultScheduleStart);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  // Walk the ancestor chain + the current node looking for the most-
  // senior level whose status is not ACTIVE. Used to warn (not block) on
  // agent runs and document promotions whose source is in flux. Anything
  // other than ACTIVE counts as "not settled" — DRAFT/PROPOSED/UNDER_REVIEW
  // mean still-designing, DEPRECATED means shouldn't be used for new work.
  const fullStatusChain = [...(ancestorStatusChain || []), { level: node.level, status: node.status, name: node.name }];
  const firstUnsettled = fullStatusChain.find((s) => s.status !== 'ACTIVE');
  const sourceUnsettled = !!firstUnsettled;
  const unsettledLabel = (() => {
    if (!firstUnsettled) return '';
    const friendly: Record<string, string> = {
      VALUE_STREAM: 'Value stream', PROCESS: 'Process', SUBPROCESS: 'Sub-process',
      ACTIVITY: 'Activity', TASK: 'Task', DOMAIN: 'Domain', CAPABILITY: 'Capability',
    };
    return `${friendly[firstUnsettled.level] || firstUnsettled.level} is ${firstUnsettled.status}`;
  })();
  // Promote-agent-draft inline form. Open keyed by the execution id so
  // the same form can be opened from either the agent panel or the
  // Outputs panel chip for the same execution.
  const [promoteOpen, setPromoteOpen] = useState<string | null>(null);
  const [promoteName, setPromoteName] = useState('');
  const [promoteDocType, setPromoteDocType] = useState<'POLICY' | 'STANDARD' | 'CHARTER' | 'FRAMEWORK'>('POLICY');
  const [promoting, setPromoting] = useState(false);
  const openPromoteForm = (execId: string, defaultName: string) => {
    setPromoteOpen(execId);
    setPromoteName(defaultName);
    setPromoteDocType('POLICY');
  };
  const nodeTags = allTags.filter((t) => t.entityId === node.id);
  const isExpanded = expanded.has(node.id);
  const hasChildren = (node.children || []).length > 0;
  const config = LEVEL_CONFIG[node.level];
  const validChildren = (validChildrenMap[node.level] || []) as NodeLevel[];
  const canAddChildren = validChildren.length > 0;
  const STATUS_TRANSITIONS =
    statusMode === 'advanced' ? ADVANCED_TRANSITIONS
    : statusMode === 'review' ? REVIEW_TRANSITIONS
    : SIMPLE_TRANSITIONS;
  const LOCKED_STATUSES =
    statusMode === 'advanced' ? ADVANCED_LOCKED
    : statusMode === 'review' ? REVIEW_LOCKED
    : SIMPLE_LOCKED;
  const isLocked = LOCKED_STATUSES.has(node.status);

  // Completeness check for value streams
  const completeness = node.level === 'VALUE_STREAM' ? hasRequiredPath(node) : null;

  // Missing required children — what's needed next
  void getRequiredNextLevel;
  let warning: string | null = null;
  let guidedLevel: NodeLevel | null = null;
  if (node.level === 'VALUE_STREAM' && countByLevel(node, 'PROCESS') === 0) {
    warning = 'Next step: Add a Process';
    guidedLevel = 'PROCESS';
  } else if (node.level === 'PROCESS' && countByLevel(node, 'ACTIVITY') === 0) {
    warning = 'Next step: Add Activities';
    guidedLevel = 'ACTIVITY';
  } else if (node.level === 'VALUE_STREAM' && countByLevel(node, 'ACTIVITY') === 0) {
    warning = 'Processes need Activities';
  }

  // Can this node be set to ACTIVE?
  const canBeActive = (() => {
    if (node.level === 'VALUE_STREAM') return completeness?.complete ?? false;
    if (node.level === 'PROCESS') return countByLevel(node, 'ACTIVITY') > 0;
    return true;
  })();

  // Flow indicators for activities
  const outgoingFlows = flows.filter((f) => f.fromNodeId === node.id);
  const incomingFlows = flows.filter((f) => f.toNodeId === node.id);

  // Connecting line style
  const isLeafLevel = validChildren.length === 0;

  const isSelected = selectedIds.has(node.id);

  return (
    <div>
      <div
        data-node-id={node.id}
        style={{
        display: 'flex', alignItems: 'flex-start', gap: 6,
        padding: '7px 12px', paddingLeft: 12 + depth * 22,
        borderBottom: '1px solid var(--color-border)',
        background: isSelected ? '#f0f9ff' : (completeness && !completeness.complete ? '#fffbeb' : undefined),
        transition: 'background 0.1s',
      }}
        onMouseEnter={(e) => { if (!isSelected && (!completeness || completeness.complete)) e.currentTarget.style.background = 'var(--color-bg)'; }}
        onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = completeness && !completeness.complete ? '#fffbeb' : ''; }}
      >
        {/* Selection checkbox */}
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => toggleSelect(node.id)}
          title="Select for bulk delete"
          style={{ flexShrink: 0, width: 14, height: 14, marginTop: 4, cursor: 'pointer' }}
        />
        {/* Connecting line + expand */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 16, flexShrink: 0, paddingTop: 3 }}>
          {depth > 0 && (
            <div style={{ width: 1, height: 4, background: 'var(--color-border)' }} />
          )}
          <span {...clickable(() => toggleExpand(node.id), { label: `Expand ${node.name}`, disabled: !(hasChildren || canAddChildren) })}
            aria-expanded={hasChildren ? isExpanded : undefined}
            style={{ fontSize: 10, color: config.color, cursor: hasChildren || canAddChildren ? 'pointer' : 'default', userSelect: 'none', lineHeight: 1 }}>
            {hasChildren ? (isExpanded ? '\u25BC' : '\u25B6') : isLeafLevel ? config.icon : '\u25B7'}
          </span>
        </div>

        {/* Level badge */}
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 3,
          padding: '2px 7px', borderRadius: 4, flexShrink: 0,
          fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap',
          background: config.bg, color: config.color,
          border: config.required ? `1px solid ${config.color}44` : 'none',
        }}>
          {config.icon} {config.label}
          {config.required && <span title="Required level" style={{ fontSize: 8 }}>*</span>}
        </span>

        {/* Activity ID */}
        {node.activityId && (
          <span style={{ fontSize: 10, color: config.color, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', background: '#fff', padding: '1px 4px', borderRadius: 3, border: '1px solid #e2e8f0' }}>
            {node.activityId}
          </span>
        )}

        {/* Name + Description */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <InlineEdit value={node.name} onSave={(name) => onUpdate(node.id, { name })} fontSize={node.level === 'VALUE_STREAM' ? 15 : 13} fontWeight={node.level === 'VALUE_STREAM' || node.level === 'PROCESS' ? 600 : 500} disabled={isLocked} />
          <div style={{ marginTop: 1 }}>
            <InlineEdit value={node.description} onSave={(description) => onUpdate(node.id, { description })} fontSize={11} placeholder="Add description..." disabled={isLocked} />
          </div>
          {/* Review-workflow banner: whenever a node is sitting in
              PENDING_REVIEW, the row shows a small yellow strip with
              the submitter's name (resolved via peopleList) and the
              comment the submitter left. The buttons for approve /
              request-changes are on the status pill above; this banner
              is purely informational. */}
          {node.status === 'PENDING_REVIEW' && (
            <div style={{ marginTop: 4, background: '#fef3c7', border: '1px solid #fbbf24', borderRadius: 4, padding: '4px 8px', fontSize: 11, color: '#92400e' }}>
              <strong>Pending review</strong>
              {(() => {
                const p = node.submittedBy ? peopleList.find((x) => x.id === node.submittedBy) : null;
                return p ? <> — submitted by <strong>{p.name}</strong></> : null;
              })()}
              {node.submittedAt && <> · {new Date(node.submittedAt).toLocaleString()}</>}
              {node.reviewComment && (
                <div style={{ marginTop: 2, fontStyle: 'italic', color: '#78350f' }}>
                  &ldquo;{node.reviewComment}&rdquo;
                </div>
              )}
            </div>
          )}
          {/* Documentation fields — visible when expanded. FieldStack
             owns the vertical rhythm (--space-field) so the gap between
             rows is uniform no matter which fields render for this node
             type / status; children must not add their own margins. */}
          {isExpanded && (
            <FieldStack style={{ marginTop: 'var(--space-section)', paddingLeft: 2 }}>
              {/* Locked-state notice. When a node's status locks editing,
                  every field renders disabled with no explanation — so a
                  user opening it to make a change hits dead inputs and no
                  hint at why. Surface the reason and a one-click way out:
                  "Reopen for editing" reuses the normal status-change
                  confirm (setPendingStatus('DRAFT')) rather than a raw
                  dropdown hunt. Only offered when Draft is actually a
                  reachable transition from this status. */}
              {isLocked && (STATUS_TRANSITIONS[node.status] || []).includes('DRAFT') && (
                <div style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 4, padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, flexWrap: 'wrap' }}>
                  <Lock size={12} strokeWidth={2} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
                  <span style={{ color: 'var(--color-text-secondary)' }}>
                    This {config.label.toLowerCase()} is <strong>{node.status.replace('_', ' ').toLowerCase()}</strong> and locked for editing.
                  </span>
                  <button
                    onClick={() => setPendingStatus('DRAFT')}
                    disabled={pendingStatus === 'DRAFT'}
                    title={statusMode === 'simple'
                      ? 'Move back to Draft to edit'
                      : 'Move back to Draft to edit — it will need to be re-approved to become Active again'}
                    style={{ marginLeft: 'auto', background: 'var(--color-surface)', color: 'var(--color-primary)', border: '1px solid var(--color-primary)', borderRadius: 4, padding: '2px 10px', fontSize: 11, fontWeight: 500, cursor: pendingStatus === 'DRAFT' ? 'default' : 'pointer', opacity: pendingStatus === 'DRAFT' ? 0.5 : 1 }}
                  >
                    Reopen for editing
                  </button>
                </div>
              )}
              {/* Value Stream fields */}
              {node.level === 'VALUE_STREAM' && (() => {
                const isGov = node.domain === 'GOVERNANCE';
                // On governance nodes, restrict the Owner picker to people
                // who hold a governance role. If nobody has a role assigned
                // yet, the picker is locked with a hint pointing the user at
                // the Governance Roles page.
                const noHolders = governanceHolderIds.size === 0;
                const govHint = 'Locked until at least one person is given a governance role on the Governance Roles page.';
                return (
                  <>
                    {/* Purpose sits above Owner on value streams because
                        it's the "what does this stream actually deliver"
                        framing — users read or set the strategic intent
                        first, then assign accountability. Process nodes
                        keep Owner-first since their fields are more
                        operational. (Purpose absorbed the former separate
                        "Business Outcome" field — one field for what this
                        accomplishes and the value it delivers.) */}
                    <DocField label="Purpose" value={node.purpose || ''} onSave={(v) => onUpdate(node.id, { purpose: v })} disabled={isLocked} placeholder="What this accomplishes and the value it delivers…" />
                    <DocPersonField label="Owner" orgId={activePageOrgId} mode="single" valueMode="id" value={node.ownerId || null} onChange={(id) => onUpdate(node.id, { ownerId: id || null })} disabled={isLocked || (isGov && noHolders)} domain={isGov ? 'GOVERNANCE' : 'OPERATIONAL'} eligibleKeys={isGov ? governanceHolderIds : undefined} disabledHint={isGov && noHolders ? govHint : undefined} disabledHintLink={isGov && noHolders ? { to: '/dama-roles', label: 'Open Governance Roles' } : undefined} />
                    {/* Stakeholders removed: the RACI Matrix is the
                        structured home for who's responsible / accountable /
                        consulted / informed. A parallel free-text field just
                        drifted from it. Existing values are retained on the
                        record, just no longer edited from this panel. */}
                    {viewMode === 'advanced' && (
                      <DocMultiSelect label="Compliance" selected={node.complianceTags || []} options={complianceFrameworks} onSave={(vals) => onUpdate(node.id, { complianceTags: vals })} disabled={isLocked} placeholder="Select compliance tags..." />
                    )}
                  </>
                );
              })()}
              {/* Process fields */}
              {node.level === 'PROCESS' && (() => {
                const isGov = node.domain === 'GOVERNANCE';
                const noHolders = governanceHolderIds.size === 0;
                const govHint = 'Locked until at least one person is given a governance role on the Governance Roles page.';
                return (
                  <>
                    {/* Purpose sits above Owner on processes for the
                        same reason as value streams — the strategic
                        framing comes before accountability for it.
                        Sub-Process / Activity / Task levels keep
                        Owner-first since they're execution units
                        without a strategic purpose of their own. */}
                    <DocField label="Purpose" value={node.purpose || ''} onSave={(v) => onUpdate(node.id, { purpose: v })} disabled={isLocked} placeholder="What does this accomplish?" />
                    <DocPersonField label="Owner" orgId={activePageOrgId} mode="single" valueMode="id" value={node.ownerId || null} onChange={(id) => onUpdate(node.id, { ownerId: id || null })} disabled={isLocked || (isGov && noHolders)} domain={isGov ? 'GOVERNANCE' : 'OPERATIONAL'} eligibleKeys={isGov ? governanceHolderIds : undefined} disabledHint={isGov && noHolders ? govHint : undefined} disabledHintLink={isGov && noHolders ? { to: '/dama-roles', label: 'Open Governance Roles' } : undefined} />
                    {/* Stakeholders is not edited here. The RACI Matrix is
                        the structured home for who-needs-to-be-responsible /
                        accountable / consulted / informed; a parallel
                        free-text Stakeholders field just drifted from it, so
                        it was retired from every level. Existing stored
                        values stay on the record. */}
                    {viewMode === 'advanced' && (
                      <>
                        <DocMultiSelect label="Compliance" selected={node.complianceTags || []} options={complianceFrameworks} onSave={(vals) => onUpdate(node.id, { complianceTags: vals })} disabled={isLocked} placeholder="Select compliance tags..." />
                        <DocDropdown label="Frequency" value={node.frequency || ''} options={FREQUENCY_OPTIONS} onSave={(v) => onUpdate(node.id, { frequency: v })} disabled={isLocked} placeholder="How often?" />
                        <DocDropdown label="Risk Level" value={node.riskLevel || ''} options={RISK_OPTIONS} onSave={(v) => onUpdate(node.id, { riskLevel: v })} disabled={isLocked} placeholder="Select risk..." />
                      </>
                    )}
                  </>
                );
              })()}
              {/* Sub-Process fields — no level-specific fields; the
                 Inputs / Outputs note now lives next to the data-asset
                 panel below so the text and the structured list sit
                 together. */}
              {node.level === 'SUBPROCESS' && null}
              {/* Activity fields */}
              {node.level === 'ACTIVITY' && (
                <>
                  <DocRoleField value={node.responsibleRole || ''} onSave={(v) => onUpdate(node.id, { responsibleRole: v })} disabled={isLocked} domain={node.domain === 'GOVERNANCE' ? 'GOVERNANCE' : 'OPERATIONAL'} />
                  {/* Responsible Person — restricted to people who
                     currently hold node.responsibleRole. Disabled until
                     the role is set, or if no one holds that role yet
                     (with hints pointing the user at where to fix it). */}
                  {(() => {
                    const role = node.responsibleRole || '';
                    const isGov = node.domain === 'GOVERNANCE';
                    const holders = role ? (holdersByRoleLabel.get(role) || new Set<string>()) : new Set<string>();
                    const noRole = !role;
                    // "No holders" only gates GOVERNANCE roles, whose holders come
                    // from formal DAMA assignments on the Governance Roles page.
                    // Operational roles are job titles, not a governance registry —
                    // so an operational activity is never gated on governance
                    // holders and never points the user at that page (any person
                    // can be marked responsible, matching the Owner field above).
                    const noHolders = isGov && !noRole && holders.size === 0;
                    const hint = noRole
                      ? (isGov
                          ? 'Pick a Responsible Role first — then the person list will be filtered to people who hold it.'
                          : 'Pick a Responsible Role first.')
                      : noHolders
                        ? `No one currently holds "${role}". Assign it on the Governance Roles page first.`
                        : undefined;
                    return (
                      <DocPersonField
                        label="Responsible Person"
                        orgId={activePageOrgId}
                        mode="single"
                        valueMode="id"
                        value={node.responsiblePersonId || null}
                        onChange={(id) => onUpdate(node.id, { responsiblePersonId: id || null })}
                        disabled={isLocked || noRole || noHolders}
                        domain={isGov ? 'GOVERNANCE' : 'OPERATIONAL'}
                        eligibleKeys={isGov ? holders : undefined}
                        disabledHint={hint}
                        disabledHintLink={noHolders ? { to: '/dama-roles', label: 'Open Governance Roles' } : undefined}
                        placeholder={noRole ? 'Pick a role first…' : 'Select responsible person…'}
                      />
                    );
                  })()}
                  {viewMode === 'advanced' && (
                    <>
                      {/* Automation and Est. Duration removed from the panel
                          (rarely filled); their columns are retained. */}
                      {/* BCM: business-continuity tier + RTO. Value maps
                         between the display label ("Tier 1") and the
                         stored enum ("TIER_1") so the picker reads
                         naturally while storage stays parseable. */}
                      <TierField
                        value={node.criticalityTier || ''}
                        onSave={(v) => onUpdate(node.id, { criticalityTier: v || null })}
                        disabled={isLocked}
                      />
                      <RtoField
                        value={node.rtoHours}
                        onSave={(v) => onUpdate(node.id, { rtoHours: v })}
                        disabled={isLocked}
                      />
                      {/* RPO — the BCM pair to RTO: how much data loss (in
                          time) is tolerable if this activity fails. */}
                      <RpoField
                        value={node.rpoHours}
                        onSave={(v) => onUpdate(node.id, { rpoHours: v })}
                        disabled={isLocked}
                      />
                      {/* Trigger — what initiates the activity (complements the
                          flow edges, which only give ordering). */}
                      <DocDropdown label="Trigger" value={node.trigger || ''} options={TRIGGER_OPTIONS} onSave={(v) => onUpdate(node.id, { trigger: v })} disabled={isLocked} placeholder="What starts this?" />
                      {/* Volume — processing scale/throughput; Frequency is
                          cadence, this is how much. */}
                      <DocField label="Volume" value={node.volume || ''} onSave={(v) => onUpdate(node.id, { volume: v })} disabled={isLocked} placeholder="Throughput, e.g. ~10k invoices/day" />
                      {/* Target / SLA — the former "Success Measure" and
                          "SLA Target" fields, merged: both expressed the same
                          "what does good look like" target. Stored in
                          successMeasure; any legacy slaTarget was folded in by
                          the merge_sla_into_success_measure migration. */}
                      <DocField label="Target / SLA" value={node.successMeasure || ''} onSave={(v) => onUpdate(node.id, { successMeasure: v })} disabled={isLocked} placeholder="Measurable target / SLA, e.g. resolve within 4h P95, 99.9% monthly" />
                      {/* Next review — forward-looking governance review date
                          (distinct from the status-review timestamp). */}
                      <DocField label="Next review" value={node.nextReviewDate || ''} onSave={(v) => onUpdate(node.id, { nextReviewDate: v })} disabled={isLocked} placeholder="Next governance review date, e.g. 2026-12-31" />
                      {/* Risk mitigation — free-text notes complementing the
                          Risk Level dropdown above. */}
                      <DocField label="Risk mitigation" value={node.riskMitigation || ''} onSave={(v) => onUpdate(node.id, { riskMitigation: v })} disabled={isLocked} placeholder="How the risk is mitigated — controls, compensations…" />
                      <ControlsPicker
                        selected={node.controlIds || []}
                        options={controlsList}
                        onChange={(ids) => onUpdate(node.id, { controlIds: ids })}
                        disabled={isLocked}
                      />
                    </>
                  )}
                  <SkillPicker compact orgId={node.orgIds?.[0]} selectedSkillIds={node.requiredSkillIds || []} onChange={(ids) => onUpdate(node.id, { requiredSkillIds: ids })} disabled={isLocked} label="Required Skills" />
                  <UnqualifiedPersonChip missingSkillNames={skillCoverageByNode[node.id]?.missingSkillNames || []} />
                  {/* Agent execution — have an agent PERFORM this activity.
                      Scoped to the governance value stream; the backend enforces
                      the same rule. */}
                  {node.domain === 'GOVERNANCE' && onRunAgent && (agentRoles?.length ?? 0) > 0 && (() => {
                    const ex = agentExecByActivity?.[node.id];
                    const selectedId = runAgentId || agentRoles![0].agentId;
                    const selected = agentRoles!.find((a) => a.agentId === selectedId) || agentRoles![0];
                    const running = runningActivity === node.id;
                    const reviewMap: Record<string, { bg: string; c: string; t: string }> = {
                      APPROVED: { bg: '#d1fae5', c: '#065f46', t: 'Approved' },
                      REJECTED: { bg: '#fee2e2', c: '#991b1b', t: 'Rejected' },
                      PENDING: { bg: '#fef3c7', c: '#92400e', t: 'Pending review' },
                    };
                    return (
                      <div style={{ marginTop: 4, padding: '6px 8px', background: '#faf5ff', border: '1px solid #e9d5ff', borderRadius: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, flexWrap: 'wrap' }}>
                          <span style={{ color: '#6b21a8', fontWeight: 600 }}>Perform with agent:</span>
                          <select aria-label="Perform with agent" value={selectedId} onChange={(e) => setRunAgentId(e.target.value)} disabled={running}
                            style={{ fontSize: 11, padding: '2px 6px', border: '1px solid var(--color-border)', borderRadius: 4, background: 'var(--color-surface)' }}>
                            {agentRoles!.map((a) => <option key={a.agentId} value={a.agentId}>{a.agentName || 'Agent'}{a.roleType ? ` — ${a.roleType}` : ''}</option>)}
                          </select>
                          <button onClick={() => onRunAgent(node.id, node.name, selected)} disabled={running}
                            style={{ padding: '2px 10px', fontSize: 10, fontWeight: 600, background: running ? '#e5e7eb' : '#7c3aed', color: running ? '#6b7280' : '#fff', border: 'none', borderRadius: 4, cursor: running ? 'not-allowed' : 'pointer' }}>
                            {running ? 'Running…' : (ex ? 'Re-run' : 'Run')}
                          </button>
                          {onCreateSchedule && (
                            <button onClick={() => setScheduleFormOpen((v) => !v)}
                              title="Schedule this agent to run once at a later time, or on a recurring cadence"
                              style={{ padding: '2px 10px', fontSize: 10, fontWeight: 600, background: 'transparent', color: '#6b21a8', border: '1px solid #c4b5fd', borderRadius: 4, cursor: 'pointer' }}>
                              {scheduleFormOpen ? 'Cancel schedule' : 'Schedule…'}
                            </button>
                          )}
                          {/* Soft warning when the source definition isn't
                             ACTIVE. Doesn't block — iterative design with
                             agent assistance is a legitimate use case —
                             but makes the design state legible. */}
                          {sourceUnsettled && (
                            <span title={`Agents can still run, but the draft will reference an unfinished definition. ${unsettledLabel}.`}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 12, fontSize: 10, fontWeight: 600, background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}>
                              <span aria-hidden>!</span> {unsettledLabel}
                            </span>
                          )}
                          {ex && (() => {
                            const sc = ex.status === 'SUCCESS' ? '#065f46' : ex.status === 'FAILED' ? '#b91c1c' : '#92400e';
                            const sb = ex.status === 'SUCCESS' ? '#d1fae5' : ex.status === 'FAILED' ? '#fef2f2' : '#fef3c7';
                            return (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <span style={{ padding: '1px 5px', borderRadius: 3, fontSize: 9, fontWeight: 600, background: sb, color: sc }}>{ex.status}</span>
                                <span style={{ color: 'var(--color-text-muted)', fontSize: 10 }}>{ex.agentName} {ex.completedAt ? new Date(ex.completedAt).toLocaleString() : ''}</span>
                              </span>
                            );
                          })()}
                        </div>
                        {ex && ex.status === 'SUCCESS' && (
                          <div style={{ marginTop: 6 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <button onClick={() => setShowAgentResult((v) => !v)}
                                style={{ fontSize: 10, padding: '2px 8px', background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 3, cursor: 'pointer', color: 'var(--color-primary)' }}>
                                {showAgentResult ? 'Hide draft' : 'View draft'}
                              </button>
                              {(() => { const m = reviewMap[ex.reviewStatus] || reviewMap.PENDING; return (
                                <span style={{ padding: '1px 6px', borderRadius: 3, fontSize: 9, fontWeight: 600, background: m.bg, color: m.c }}>
                                  {m.t}{ex.reviewedBy && ex.reviewStatus !== 'PENDING' ? ` · ${ex.reviewedBy}` : ''}
                                </span>
                              ); })()}
                              {onReviewExecution && ex.reviewStatus === 'PENDING' && (
                                <>
                                  <button onClick={() => onReviewExecution(ex.id, 'APPROVED')}
                                    style={{ fontSize: 10, padding: '2px 8px', background: '#065f46', color: '#fff', border: 'none', borderRadius: 3, cursor: 'pointer' }}>Approve</button>
                                  <button onClick={() => onReviewExecution(ex.id, 'REJECTED')}
                                    style={{ fontSize: 10, padding: '2px 8px', background: 'transparent', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 3, cursor: 'pointer' }}>Reject</button>
                                </>
                              )}
                              {onReviewExecution && ex.reviewStatus !== 'PENDING' && (
                                <button onClick={() => onReviewExecution(ex.id, 'PENDING')}
                                  style={{ fontSize: 10, padding: '2px 6px', background: 'transparent', color: 'var(--color-text-muted)', border: '1px solid var(--color-border)', borderRadius: 3, cursor: 'pointer' }}>Reset</button>
                              )}
                              {/* Promote-to-document affordance. An approved-but-
                                 unpromoted draft can be turned into a Governance
                                 Document and attached as an OUTPUT in one step.
                                 Available also on PENDING drafts as a fast-path
                                 (the backend marks them APPROVED on promote). */}
                              {onPromoteExecution && ex.reviewStatus !== 'REJECTED' && !ex.promotedDocumentId && (
                                <button onClick={() => openPromoteForm(ex.id, node.name)}
                                  style={{ fontSize: 10, padding: '2px 8px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 3, cursor: 'pointer' }}
                                  title="Create a Governance Document from this draft and attach it as an Output of this activity">
                                  Promote to Document
                                </button>
                              )}
                              {ex.promotedDocumentId && (
                                <a href="/governance-documents"
                                  style={{ fontSize: 10, padding: '2px 8px', background: '#ede9fe', color: '#5b21b6', border: '1px solid #c4b5fd', borderRadius: 3, textDecoration: 'none', fontWeight: 600 }}
                                  title="This draft has been promoted to a Governance Document and now appears in the activity's Outputs.">
                                  Promoted →
                                </a>
                              )}
                            </div>
                            {showAgentResult && (
                              <div style={{ marginTop: 6, padding: '8px 10px', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 4, maxHeight: 360, overflowY: 'auto' }}>
                                <div style={{ fontSize: 9, fontWeight: 600, color: '#92400e', background: '#fef3c7', display: 'inline-block', padding: '1px 6px', borderRadius: 3, marginBottom: 6 }}>AI DRAFT — review before use</div>
                                <div style={{ fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{ex.output}</div>
                              </div>
                            )}
                            {/* Inline promote form — shown when openPromoteForm
                               was called for this execution. The form's name
                               defaults to the activity name; documentType
                               defaults to POLICY. The "Outputs panel" chip
                               opens this same form via the same state. */}
                            {promoteOpen === ex.id && onPromoteExecution && (
                              <div style={{ marginTop: 8, padding: '10px 12px', background: 'var(--color-bg)', border: '1px solid #c4b5fd', borderRadius: 4 }}>
                                <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8, color: '#5b21b6' }}>Promote draft to Governance Document</div>
                                <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 8, lineHeight: 1.5 }}>
                                  Creates a new <strong>{promoteDocType.toLowerCase()}</strong> in the Governance Documents catalogue with this draft's content, and links it as an <strong>Output</strong> of this activity.
                                </div>
                                {sourceUnsettled && (
                                  <div style={{ fontSize: 10, padding: '6px 8px', marginBottom: 8, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 3, color: '#92400e', lineHeight: 1.5 }}>
                                    <strong>{unsettledLabel}.</strong> The document will reference an unfinished process. It will be created as a <strong>DRAFT</strong> document, and its description will record the source status at promotion time. Promote anyway?
                                  </div>
                                )}
                                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8, marginBottom: 8 }}>
                                  <div>
                                    <label style={{ fontSize: 10, fontWeight: 500, display: 'block', marginBottom: 2 }}>Name</label>
                                    <input aria-label="Name" value={promoteName} onChange={(e) => setPromoteName(e.target.value)}
                                      style={{ fontSize: 11, padding: '4px 6px', border: '1px solid var(--color-border)', borderRadius: 3, width: '100%', background: 'var(--color-surface)' }} />
                                  </div>
                                  <div>
                                    <label style={{ fontSize: 10, fontWeight: 500, display: 'block', marginBottom: 2 }}>Document type</label>
                                    <select aria-label="Document type" value={promoteDocType} onChange={(e) => setPromoteDocType(e.target.value as typeof promoteDocType)}
                                      style={{ fontSize: 11, padding: '4px 6px', border: '1px solid var(--color-border)', borderRadius: 3, width: '100%', background: 'var(--color-surface)' }}>
                                      <option value="POLICY">Policy</option>
                                      <option value="STANDARD">Standard</option>
                                      <option value="CHARTER">Charter</option>
                                      <option value="FRAMEWORK">Framework</option>
                                    </select>
                                  </div>
                                </div>
                                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                                  <button onClick={() => setPromoteOpen(null)} disabled={promoting}
                                    style={{ fontSize: 10, padding: '3px 10px', background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 3, cursor: promoting ? 'not-allowed' : 'pointer' }}>
                                    Cancel
                                  </button>
                                  <button
                                    onClick={async () => {
                                      if (!promoteName.trim() || !onPromoteExecution) return;
                                      setPromoting(true);
                                      const ok = await onPromoteExecution(ex.id, { name: promoteName.trim(), documentType: promoteDocType });
                                      setPromoting(false);
                                      if (ok) setPromoteOpen(null);
                                    }}
                                    disabled={promoting || !promoteName.trim()}
                                    style={{ fontSize: 10, padding: '3px 12px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 3, cursor: (promoting || !promoteName.trim()) ? 'not-allowed' : 'pointer', opacity: (promoting || !promoteName.trim()) ? 0.6 : 1 }}>
                                    {promoting ? 'Promoting…' : 'Promote'}
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                        {ex && ex.status === 'FAILED' && ex.error && (
                          <div style={{ marginTop: 6, fontSize: 10, color: '#991b1b' }}>{ex.error}</div>
                        )}

                        {/* Inline schedule form. Frequency + start datetime;
                            saves a new agent-schedules row. ONCE schedules
                            auto-COMPLETED after their single run. */}
                        {scheduleFormOpen && onCreateSchedule && (
                          <div style={{ marginTop: 8, padding: '8px 10px', background: 'var(--color-bg)', border: '1px solid #c4b5fd', borderRadius: 4 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6, color: '#5b21b6' }}>Schedule this agent</div>
                            <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 6, lineHeight: 1.5 }}>
                              The agent runs on the cadence you pick. The activity's responsible person is notified when each run completes; every run is recorded in the audit log.
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                              <div>
                                <label style={{ fontSize: 10, fontWeight: 500, display: 'block', marginBottom: 2 }}>Frequency</label>
                                <select aria-label="Frequency" value={scheduleFrequency} onChange={(e) => setScheduleFrequency(e.target.value as typeof scheduleFrequency)}
                                  style={{ fontSize: 11, padding: '4px 6px', border: '1px solid var(--color-border)', borderRadius: 3, width: '100%', background: 'var(--color-surface)' }}>
                                  <option value="ONCE">Once (run at this time)</option>
                                  <option value="HOURLY">Hourly</option>
                                  <option value="DAILY">Daily</option>
                                  <option value="WEEKLY">Weekly</option>
                                  <option value="MONTHLY">Monthly</option>
                                </select>
                              </div>
                              <div>
                                <label style={{ fontSize: 10, fontWeight: 500, display: 'block', marginBottom: 2 }}>{scheduleFrequency === 'ONCE' ? 'Run at' : 'First run at'}</label>
                                <input type="datetime-local" aria-label={scheduleFrequency === 'ONCE' ? 'Run at' : 'First run at'} value={scheduleStartLocal} onChange={(e) => setScheduleStartLocal(e.target.value)}
                                  style={{ fontSize: 11, padding: '4px 6px', border: '1px solid var(--color-border)', borderRadius: 3, width: '100%', background: 'var(--color-surface)' }} />
                              </div>
                            </div>
                            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                              <button onClick={() => { setScheduleFormOpen(false); setScheduleStartLocal(defaultScheduleStart()); }} disabled={scheduleSaving}
                                style={{ fontSize: 10, padding: '3px 10px', background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 3, cursor: scheduleSaving ? 'not-allowed' : 'pointer' }}>
                                Cancel
                              </button>
                              <button
                                onClick={async () => {
                                  if (!scheduleStartLocal || !onCreateSchedule) return;
                                  // datetime-local is naive local time; convert to ISO.
                                  const iso = new Date(scheduleStartLocal).toISOString();
                                  setScheduleSaving(true);
                                  const ok = await onCreateSchedule({
                                    activityId: node.id, agentId: selectedId, roleType: selected.roleType,
                                    frequency: scheduleFrequency, startAt: iso,
                                  });
                                  setScheduleSaving(false);
                                  if (ok) { setScheduleFormOpen(false); setScheduleStartLocal(defaultScheduleStart()); }
                                }}
                                disabled={scheduleSaving || !scheduleStartLocal}
                                style={{ fontSize: 10, padding: '3px 12px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 3, cursor: scheduleSaving ? 'not-allowed' : 'pointer', opacity: scheduleSaving ? 0.6 : 1 }}>
                                {scheduleSaving ? 'Saving…' : 'Save schedule'}
                              </button>
                            </div>
                          </div>
                        )}

                        {/* Existing schedules for this activity (ACTIVE or
                            PAUSED — COMPLETED ones drop off automatically
                            on the next tick). */}
                        {(() => {
                          const list = (schedulesByActivity?.[node.id] || []).filter((s) => s.status !== 'COMPLETED');
                          if (list.length === 0) return null;
                          return (
                            <div style={{ marginTop: 8 }}>
                              <div style={{ fontSize: 10, fontWeight: 600, color: '#6b21a8', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
                                Scheduled runs ({list.length})
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                {list.map((s) => {
                                  const isActive = s.status === 'ACTIVE';
                                  return (
                                    <div key={s.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '3px 8px', background: isActive ? '#ede9fe' : '#f5f3ff', color: '#5b21b6', borderRadius: 4, fontSize: 11, border: `1px solid ${isActive ? '#c4b5fd' : 'var(--color-border)'}` }}>
                                      <Bot size={12} strokeWidth={2.4} />
                                      <span>{s.agentName}</span>
                                      <span style={{ color: '#7c3aed' }}>·</span>
                                      <span>{s.frequency.toLowerCase()}</span>
                                      <span style={{ color: '#7c3aed' }}>·</span>
                                      <span title={`Next run: ${new Date(s.nextRunAt).toLocaleString()}`}>
                                        next: {new Date(s.nextRunAt).toLocaleString()}
                                      </span>
                                      {s.runCount > 0 && (
                                        <>
                                          <span style={{ color: '#7c3aed' }}>·</span>
                                          <span style={{ color: 'var(--color-text-muted)' }}>{s.runCount} run{s.runCount === 1 ? '' : 's'}</span>
                                        </>
                                      )}
                                      {!isActive && <StatusBadge variant="warning">Paused</StatusBadge>}
                                      <div style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4 }}>
                                        {onToggleSchedule && (
                                          <button onClick={() => onToggleSchedule(s.id, isActive ? 'PAUSED' : 'ACTIVE')}
                                            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#5b21b6', fontSize: 11, padding: 0, textDecoration: 'underline' }}>
                                            {isActive ? 'Pause' : 'Resume'}
                                          </button>
                                        )}
                                        {onDeleteSchedule && (
                                          <button onClick={() => onDeleteSchedule(s.id)}
                                            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#991b1b', fontSize: 11, padding: 0, textDecoration: 'underline' }}>
                                            Delete
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    );
                  })()}
                </>
              )}
              {/* Task fields — required skills */}
              {node.level === 'TASK' && (
                <>
                  <SkillPicker compact orgId={node.orgIds?.[0]} selectedSkillIds={node.requiredSkillIds || []} onChange={(ids) => onUpdate(node.id, { requiredSkillIds: ids })} disabled={isLocked} label="Required Skills" />
                  <UnqualifiedPersonChip missingSkillNames={skillCoverageByNode[node.id]?.missingSkillNames || []} />
                </>
              )}
              {/* Systems this step runs on — first-class link, distinct
                 from the data-asset mappings below (a step may run on a
                 system even before any data asset is linked). Scoped to
                 Activity level, like Inputs/Outputs: a process/sub-process
                 "runs on" whatever its activities do, so a higher-level
                 node's systems are the roll-up of its children — declaring
                 them independently is a two-sources-of-truth trap.
                 Governance nodes have no system flows (policies and
                 decisions, not systems). Higher levels get the pointer
                 note below instead. */}
              {node.level === 'ACTIVITY' && node.domain !== 'GOVERNANCE' && (
                <DocSystemsField
                  selected={node.systemIds || []}
                  options={systemsList}
                  onSave={(ids) => onUpdate(node.id, { systemIds: ids })}
                  disabled={isLocked}
                />
              )}
            </FieldStack>
          )}
          {/* Free-text Inputs / Outputs note — sits directly above the
             structured IOPanel so the description and the attached
             assets read as one block (it used to live up among the
             other doc fields, separated from the panel by Skills /
             Agent rows). */}
          {/* Structured Inputs / Outputs panel — rows can target a
              data asset, a governance document (policy), or an
              uploaded attachment. Picker is segmented across the
              three kinds.

              Scoped to Activity-level nodes only. A process's
              effective inputs/outputs are a roll-up of its child
              activities; declaring them independently at the process
              level creates a two-sources-of-truth maintenance trap
              (and disagrees with how the governance template, the
              agent execution model, and the mappings already work).
              Higher-level nodes get a quiet pointer instead. */}
          {/* Flow — the activity's data flow (Inputs / Outputs) and its
              sequence flow (Predecessors / Successors) grouped under one
              header so they read as one unit. They stay distinct panels:
              I/O is what the step consumes/produces, dependencies are what
              runs before/after — related but deliberately not merged (an
              output auto-becoming a successor's input is the
              two-sources-of-truth trap these panels already warn about). */}
          {isExpanded && node.level === 'ACTIVITY' && (
            <div style={{ marginTop: 'var(--space-section)' }}>
              <SectionLabel>Flow</SectionLabel>
              {/* Both panels are full-width and stacked. They are NOT
                  coupled — I/O is data flow (assets/policies this step
                  consumes/produces), Dependencies is sequence flow (which
                  other activities run before/after). Height is kept down
                  by IOPanel laying its own Inputs|Outputs side by side
                  internally, and by Dependencies' Predecessors|Successors
                  columns — not by squeezing the two panels into one row,
                  which cramped the dependency rows and implied a link
                  between the two that doesn't exist. */}
              <FieldStack gap="field">
                <IOPanel
                  grouped
                  nodeId={node.id}
                  mappings={mappingsByStep[node.id] || []}
                  assetsList={assetsList}
                  policiesList={policiesList}
                  orgId={activePageOrgId}
                  disabled={isLocked}
                  isGovernance={node.domain === 'GOVERNANCE'}
                  onAdd={onAddMapping}
                  onRemove={onRemoveMapping}
                  onRestore={onRestoreMapping}
                  nodeInputsOutputs={node.inputsOutputs}
                />
                <DependenciesPanel
                  grouped
                  nodeId={node.id}
                  valueStreamName={valueStreamName || null}
                  allActivities={activitiesFlat}
                  disabled={isLocked}
                />
              </FieldStack>
            </div>
          )}
          {/* Approved agent drafts that haven't yet been promoted to a
             Governance Document — surfaced here in the Outputs area so
             the answer to "where's my approved draft as an output?" is
             one click away. Promoted drafts disappear from this chip
             list because they show up as proper Output mappings above. */}
          {isExpanded && (() => {
            const ex = agentExecByActivity?.[node.id];
            if (!ex || ex.status !== 'SUCCESS') return null;
            if (ex.reviewStatus !== 'APPROVED') return null;
            if (ex.promotedDocumentId) return null;
            return (
              <div style={{ marginTop: 'var(--space-section)', padding: '6px 10px', background: '#faf5ff', border: '1px dashed #d8b4fe', borderRadius: 4 }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: '#6b21a8', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
                  Approved draft pending promotion
                </div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', background: '#ede9fe', color: '#5b21b6', borderRadius: 12, fontSize: 11 }}>
                  <Bot size={12} strokeWidth={2.4} />
                  <span>Agent draft by {ex.agentName}</span>
                  <button onClick={() => setShowAgentResult(true)} style={{ background: 'transparent', border: 'none', color: '#5b21b6', textDecoration: 'underline', cursor: 'pointer', fontSize: 11, padding: 0 }}>View</button>
                  <span style={{ color: '#a78bfa' }}>·</span>
                  {onPromoteExecution && (
                    <button onClick={() => openPromoteForm(ex.id, node.name)} style={{ background: 'transparent', border: 'none', color: '#5b21b6', textDecoration: 'underline', cursor: 'pointer', fontSize: 11, padding: 0 }}>Promote</button>
                  )}
                </div>
                <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 4 }}>
                  Promote to a Governance Document to make this an Output of the activity.
                </div>
              </div>
            );
          })()}
          {/* Attachments window — reachable from the "Attach" button in the
              action row at every level. The badge count comes from the
              page's bulk fetch; the panel's onCount keeps this node's badge
              live after uploads / deletes while the modal is open. */}
          {showAttachments && (
            <Modal
              open
              onClose={() => setShowAttachments(false)}
              size="md"
              kicker="ATTACHMENTS"
              title={node.name || 'Attachments'}
              subtitle="Upload files or link documentation, diagrams, SOPs, and external references."
            >
              <AttachmentsPanel
                entityType="ProcessNode"
                entityId={node.id}
                orgId={node.orgIds?.[0]}
                disabled={isLocked}
                hideHeader
                onCount={setAttachmentCountOverride}
              />
            </Modal>
          )}
          {/* Guided prompt for missing required children */}
          {warning && (
            <div style={{ fontSize: 10, color: 'var(--color-warning)', marginTop: 3, display: 'flex', alignItems: 'center', gap: 4, background: '#fef3c7', padding: '2px 8px', borderRadius: 4, width: 'fit-content' }}>
              <span style={{ fontSize: 11 }}>{'\u2192'}</span>
              <span style={{ fontWeight: 500 }}>{warning}</span>
              {guidedLevel && (
                <button style={{ ...btnAdd, fontSize: 10, padding: '1px 8px', borderColor: 'var(--color-warning)', color: 'var(--color-warning)', background: '#fff', fontWeight: 600 }}
                  onClick={() => { if (!isExpanded) toggleExpand(node.id); onAddChild(node.id); }}>
                  + Add {LEVEL_CONFIG[guidedLevel].label}
                </button>
              )}
            </div>
          )}
          {/* Progress checklist for value streams */}
          {completeness && (
            <div style={{ fontSize: 10, marginTop: 3, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: 'var(--color-success)' }}>{'\u2713'} Value Stream</span>
              <span style={{ color: completeness.hasProcess ? 'var(--color-success)' : 'var(--color-warning)' }}>
                {completeness.hasProcess ? '\u2713' : '\u2717'} Process
              </span>
              <span style={{ color: completeness.hasActivity ? 'var(--color-success)' : 'var(--color-warning)' }}>
                {completeness.hasActivity ? '\u2713' : '\u2717'} Activity
              </span>
              {completeness.complete && <span style={{ color: 'var(--color-success)', fontWeight: 500 }}>Ready</span>}
            </div>
          )}
        </div>

        {/* Flow indicators */}
        {node.level === 'ACTIVITY' && (incomingFlows.length > 0 || outgoingFlows.length > 0) && (
          <span style={{ fontSize: 9, color: 'var(--color-text-muted)', whiteSpace: 'nowrap', background: '#f1f5f9', padding: '1px 4px', borderRadius: 3 }}
            title={`${incomingFlows.length} incoming, ${outgoingFlows.length} outgoing flows`}>
            {incomingFlows.length > 0 && `\u2190${incomingFlows.length}`}{' '}
            {outgoingFlows.length > 0 && `\u2192${outgoingFlows.length}`}
          </span>
        )}

        {/* Status — with confirmation. Review-mode transitions
            (submit / approve / request-changes) prompt for a comment. */}
        {pendingStatus ? (() => {
          const needsComment = statusMode === 'review'
            && (
              (node.status === 'DRAFT' && pendingStatus === 'PENDING_REVIEW')
              || (node.status === 'PENDING_REVIEW')
            );
          const commit = () => {
            const payload: any = { status: pendingStatus };
            if (needsComment) payload.reviewComment = reviewCommentDraft;
            onUpdate(node.id, payload);
            setPendingStatus(null);
            setReviewCommentDraft('');
          };
          const cancel = () => { setPendingStatus(null); setReviewCommentDraft(''); };
          // Reopening a locked item back to Draft — label it as such, and
          // in governed modes warn that it drops out of the approved state
          // and must be re-approved to return to Active.
          const isReopen = pendingStatus === 'DRAFT' && LOCKED_STATUSES.has(node.status);
          const reopenWarn = isReopen && statusMode !== 'simple';
          const saveLabel = isReopen ? 'Reopen for editing'
            : statusMode === 'review'
            ? (pendingStatus === 'PENDING_REVIEW' ? 'Submit for review'
              : pendingStatus === 'ACTIVE' && node.status === 'PENDING_REVIEW' ? 'Approve'
              : pendingStatus === 'DRAFT' && node.status === 'PENDING_REVIEW' ? 'Request changes'
              : 'Save')
            : 'Save';
          const stacked = needsComment || reopenWarn;
          return (
            <div style={{ display: 'flex', flexDirection: stacked ? 'column' : 'row', alignItems: stacked ? 'stretch' : 'center', gap: 4, background: '#fffbeb', border: '1px solid #f59e0b44', borderRadius: 4, padding: '4px 6px', minWidth: stacked ? 260 : undefined }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 9, color: 'var(--color-text-muted)' }}>
                  {node.status.replace('_', ' ')} {'\u2192'}
                </span>
                <span style={{ fontSize: 10, fontWeight: 600, color: statusColors[pendingStatus]?.color || '#64748b' }}>
                  {pendingStatus.replace('_', ' ')}
                </span>
              </div>
              {reopenWarn && (
                <span style={{ fontSize: 10, color: '#92400e' }}>
                  Reopening drops this out of {node.status.replace('_', ' ').toLowerCase()}; it'll need to be re-approved to become active again.
                </span>
              )}
              {needsComment && (
                <input
                  autoFocus
                  aria-label="Review comment"
                  value={reviewCommentDraft}
                  onChange={(e) => setReviewCommentDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') cancel(); }}
                  placeholder={
                    pendingStatus === 'PENDING_REVIEW' ? 'What are you changing? (optional but helpful)'
                    : pendingStatus === 'ACTIVE' ? 'Approval note (optional)'
                    : 'Explain what needs to change'
                  }
                  style={{ fontSize: 10, padding: '2px 6px', border: '1px solid var(--color-border)', borderRadius: 3 }}
                />
              )}
              <div style={{ display: 'flex', gap: 4 }}>
                <button onClick={commit}
                  style={{ background: 'var(--color-primary)', color: '#fff', border: 'none', borderRadius: 3, padding: '2px 8px', fontSize: 9, fontWeight: 600, cursor: 'pointer' }}>
                  {saveLabel}
                </button>
                <button onClick={cancel}
                  style={{ background: 'none', border: '1px solid var(--color-border)', borderRadius: 3, padding: '2px 8px', fontSize: 9, cursor: 'pointer', color: 'var(--color-text-muted)' }}>
                  Cancel
                </button>
              </div>
            </div>
          );
        })() : (
          <select aria-label="Status" value={node.status} onChange={(e) => {
              if (e.target.value === node.status) return;
              setPendingStatus(e.target.value);
            }}
            style={{ ...inputStyle, width: 'auto', fontSize: 10, padding: '1px 4px',
              background: statusColors[node.status]?.bg || '#f1f5f9',
              color: statusColors[node.status]?.color || '#64748b', fontWeight: 600, border: 'none',
            }}>
            <option value={node.status}>{node.status.replace('_', ' ')}</option>
            {(STATUS_TRANSITIONS[node.status] || []).map((s) => {
              const blocked = (s === 'ACTIVE' || s === 'APPROVED') && !canBeActive;
              return (
                <option key={s} value={s} disabled={blocked}>
                  {s.replace('_', ' ')}{blocked ? ' (incomplete)' : ''}
                </option>
              );
            })}
          </select>
        )}

        {/* Attachments — opens the upload / manage window. Rendered at
            every level so the affordance is identical across the whole
            hierarchy; the count badge shows once known. */}
        <button
          style={{ ...btnIcon, fontSize: 11, color: 'var(--color-text-muted)', display: 'inline-flex', alignItems: 'center', gap: 3 }}
          onClick={() => setShowAttachments(true)}
          title="Attachments — upload & manage"
        >
          <Paperclip size={12} strokeWidth={2} />
          Attach{attachmentCount ? ` (${attachmentCount})` : ''}
        </button>

        {/* Actions — smart + button */}
        {/* Tags display */}
        {nodeTags.length > 0 && (
          <span style={{ display: 'inline-flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
            {nodeTags.map((t) => (
              <span key={t.id} onClick={() => onRemoveTag(t.id)} title="Click to remove tag"
                style={{ display: 'inline-block', padding: '1px 6px', borderRadius: 8, fontSize: 9, fontWeight: 500, background: '#e0e7ff', color: '#3730a3', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                {t.tag} x
              </span>
            ))}
          </span>
        )}

        {/* Tag add button / input */}
        {showTagInput ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            <input autoFocus aria-label="Tag" style={{ ...inputStyle, width: 80, fontSize: 10, padding: '1px 4px' }}
              placeholder="tag..."
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && tagDraft.trim()) { onAddTag(node.id, tagDraft.trim()); setTagDraft(''); setShowTagInput(false); }
                if (e.key === 'Escape') { setTagDraft(''); setShowTagInput(false); }
              }}
              onBlur={() => { if (tagDraft.trim()) { onAddTag(node.id, tagDraft.trim()); } setTagDraft(''); setShowTagInput(false); }}
            />
          </span>
        ) : (
          <button style={{ ...btnIcon, fontSize: 9, color: '#6366f1' }} onClick={() => setShowTagInput(true)} title="Add tag">tag+</button>
        )}

        {canAddChildren && !isLocked && (
          guidedLevel ? (
            <button style={{
              background: LEVEL_CONFIG[guidedLevel].bg, color: LEVEL_CONFIG[guidedLevel].color,
              border: `1px solid ${LEVEL_CONFIG[guidedLevel].color}44`, borderRadius: 4,
              padding: '1px 8px', fontSize: 10, fontWeight: 600, cursor: 'pointer',
            }}
              onClick={() => { if (!isExpanded) toggleExpand(node.id); onAddChild(node.id); }}
              title={`Add ${LEVEL_CONFIG[guidedLevel].label} to ${node.name}`}>
              + {LEVEL_CONFIG[guidedLevel].label}
            </button>
          ) : (
            <button style={{ ...btnIcon, color: config.color, fontWeight: 700, fontSize: 14 }}
              onClick={() => { if (!isExpanded) toggleExpand(node.id); onAddChild(node.id); }} title={`Add child to ${node.name}`}>+</button>
          )
        )}
        <button style={{ ...btnIcon, fontSize: 11, color: 'var(--color-text-muted)' }} onClick={() => onShowHistory(node.id)} title="Version snapshots">Versions</button>
        {node.level === 'VALUE_STREAM' && (
          <button style={{ ...btnIcon, fontSize: 11, color: 'var(--color-text-muted)' }} onClick={() => onClone(node.id)} title="Clone Value Stream">Clone</button>
        )}
        {/* Reorder — move up / down among siblings. Kept at the far end of
            the row so no arrow sits beside the Attach button. */}
        <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 0, flexShrink: 0 }}>
          {siblingIndex > 0 ? (
            <button style={{ ...btnIcon, fontSize: 10, padding: '0 4px', lineHeight: 1, color: 'var(--color-text-muted)' }}
              onClick={() => onReorder(node.id, 'up')} title="Move up">{'▲'}</button>
          ) : (
            <span style={{ display: 'inline-block', width: 22, height: 14 }} />
          )}
          {siblingIndex < siblingCount - 1 ? (
            <button style={{ ...btnIcon, fontSize: 10, padding: '0 4px', lineHeight: 1, color: 'var(--color-text-muted)' }}
              onClick={() => onReorder(node.id, 'down')} title="Move down">{'▼'}</button>
          ) : (
            <span style={{ display: 'inline-block', width: 22, height: 14 }} />
          )}
        </span>
        {!isLocked && (
          <button type="button" style={{ ...btnIcon, color: 'var(--color-error)', fontSize: 14 }} onClick={() => onDelete(node.id)} title="Delete" aria-label={`Delete ${node.name || 'node'}`}><span aria-hidden="true">&times;</span></button>
        )}
      </div>

      {/* Children */}
      {isExpanded && (node.children || []).map((child, idx, arr) => (
        <TreeNode key={child.id} node={child} depth={depth + 1}
          onUpdate={onUpdate} onDelete={onDelete} onClone={onClone} onAddChild={onAddChild}
          expanded={expanded} toggleExpand={toggleExpand}
          selectedIds={selectedIds} toggleSelect={toggleSelect}
          validChildrenMap={validChildrenMap} flows={flows}
          activitiesFlat={activitiesFlat}
          valueStreamName={node.level === 'VALUE_STREAM' ? node.name : valueStreamName}
          controlsList={controlsList}
          siblingIndex={idx} siblingCount={arr.length} onReorder={onReorder}
          onShowHistory={onShowHistory}
          allTags={allTags}
          onAddTag={onAddTag}
          onRemoveTag={onRemoveTag}
          peopleList={peopleList}
          assetsList={assetsList}
          policiesList={policiesList}
          systemsList={systemsList}
          mappingsByStep={mappingsByStep}
          attachmentCountByNode={attachmentCountByNode}
          skillCoverageByNode={skillCoverageByNode}
          activePageOrgId={activePageOrgId}
          onAddMapping={onAddMapping}
          onRemoveMapping={onRemoveMapping}
          onRestoreMapping={onRestoreMapping}
          statusMode={statusMode}
          agentExecByActivity={agentExecByActivity}
          onRunAgent={onRunAgent}
          onReviewExecution={onReviewExecution}
          onPromoteExecution={onPromoteExecution}
          runningActivity={runningActivity}
          agentRoles={agentRoles}
          governanceHolderIds={governanceHolderIds}
          holdersByRoleLabel={holdersByRoleLabel}
          viewMode={viewMode}
          ancestorStatusChain={[...(ancestorStatusChain || []), { level: node.level, status: node.status, name: node.name }]}
          schedulesByActivity={schedulesByActivity}
          onCreateSchedule={onCreateSchedule}
          onToggleSchedule={onToggleSchedule}
          onDeleteSchedule={onDeleteSchedule} />
      ))}
    </div>
  );
}

export default TreeNode;
