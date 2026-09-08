import { Router, Request, Response } from 'express';
import { scopeListForRequest } from '../lib/tenant-scope';
import logger from '../lib/logger';
import { dataDomains } from './data-domains';
import { dataAssets } from './data-assets';
import { processNodes } from './process-catalog';
import { getDataDomainsRepository } from '../db/data-domains.repo';
import { getDataAssetsRepository } from '../db/data-assets.repo';
import { getProcessNodesRepository } from '../db/process-nodes.repo';
import { getGovernanceTasksRepository } from '../db/governance-tasks.repo';
import { getGovernanceIssuesRepository } from '../db/governance-issues.repo';
import { getGovernancePoliciesRepository } from '../db/governance-policies.repo';
import { getGovernanceControlsRepository } from '../db/governance-controls.repo';
import { governanceTasks } from './governance-tasks';
import { governanceIssues } from './governance-issues';
import { governancePolicies } from './governance-policies';
import { governanceControls } from './governance-controls';

// Repositories — read Postgres when DATABASE_URL is set, else the JSON arrays
// above. This aggregator is read-only; each request loads a fresh snapshot.
const dataDomainsRepo = getDataDomainsRepository(dataDomains);
const dataAssetsRepo = getDataAssetsRepository(dataAssets);
const processNodesRepo = getProcessNodesRepository(processNodes);
const governanceTasksRepo = getGovernanceTasksRepository(governanceTasks);
const governanceIssuesRepo = getGovernanceIssuesRepository(governanceIssues);
const governancePoliciesRepo = getGovernancePoliciesRepository(governancePolicies);
const governanceControlsRepo = getGovernanceControlsRepository(governanceControls);

// ── Helper: count occurrences of a field value in a filtered array ──────
function countBy<T>(items: T[], field: keyof T): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = String(item[field] ?? 'UNKNOWN');
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

const router = Router();

/**
 * GET /api/v1/control-tower/summary
 *
 * Aggregates metrics from governance issues, tasks, policies, controls,
 * and coverage data (domains, assets, processes) into a single payload
 * for the Control Tower dashboard.
 *
 * Supports `?orgId=` to scope results to a specific organization.
 */
router.get('/summary', async (req: Request, res: Response) => {
  try {
    const { orgId } = req.query;
    const orgFilter = orgId as string | undefined;

    // ── Load each store (Postgres or JSON) then filter by org scope ─────
    const [allIssues, allTasks, allPolicies, allControls, allDomains, allAssets, allNodes] = await Promise.all([
      governanceIssuesRepo.list(),
      governanceTasksRepo.list(),
      governancePoliciesRepo.list(),
      governanceControlsRepo.list(),
      dataDomainsRepo.list(),
      dataAssetsRepo.list(),
      processNodesRepo.list(),
    ]);
    const filteredIssues = scopeListForRequest(req, allIssues);
    const filteredTasks = scopeListForRequest(req, allTasks);
    const filteredPolicies = scopeListForRequest(req, allPolicies);
    const filteredControls = scopeListForRequest(req, allControls);
    const filteredDomains = scopeListForRequest(req, allDomains);
    const filteredAssets = scopeListForRequest(req, allAssets);
    const filteredProcesses = orgFilter
      ? allNodes.filter((n) => {
          // processNodes use orgId + orgIds (multi-org), mirror the
          // pattern in process-catalog route's GET /
          return n.orgId === orgFilter || (n.orgIds && n.orgIds.includes(orgFilter));
        })
      : allNodes;

    // ── Issue metrics ───────────────────────────────────────────────────
    const issueTotal = filteredIssues.length;
    const issueOpen = filteredIssues.filter((i: any) => i.status === 'OPEN').length;
    const issueInvestigating = filteredIssues.filter((i: any) => i.status === 'INVESTIGATING').length;
    const issueInProgress = filteredIssues.filter((i: any) => i.status === 'IN_PROGRESS').length;
    const issueResolved = filteredIssues.filter((i: any) => i.status === 'RESOLVED').length;
    const issueBySeverity = countBy(filteredIssues, 'severity' as any);
    const issueByType = countBy(filteredIssues, 'issueType' as any);

    // ── Task metrics ────────────────────────────────────────────────────
    const now = new Date().toISOString();
    const taskTotal = filteredTasks.length;
    const taskOpen = filteredTasks.filter((t: any) => t.status === 'OPEN').length;
    const taskInProgress = filteredTasks.filter((t: any) => t.status === 'IN_PROGRESS').length;
    const taskPendingReview = filteredTasks.filter((t: any) => t.status === 'PENDING_REVIEW').length;
    const taskPendingApproval = filteredTasks.filter((t: any) => t.status === 'PENDING_APPROVAL').length;
    const taskCompleted = filteredTasks.filter((t: any) => t.status === 'COMPLETED').length;
    const taskOverdue = filteredTasks.filter((t: any) => {
      if (!t.dueDate) return false;
      const isTerminal = t.status === 'COMPLETED' || t.status === 'CANCELLED';
      return !isTerminal && t.dueDate < now;
    }).length;
    const taskByPriority = countBy(filteredTasks, 'priority' as any);
    const taskByAutomationMode = countBy(filteredTasks, 'automationMode' as any);

    // ── Policy metrics ──────────────────────────────────────────────────
    const policyTotal = filteredPolicies.length;
    const policyActive = filteredPolicies.filter((p: any) => p.status === 'ACTIVE').length;
    const policyDraft = filteredPolicies.filter((p: any) => p.status === 'DRAFT').length;
    const policyUnderReview = filteredPolicies.filter((p: any) => p.status === 'UNDER_REVIEW').length;
    const policyOverdueReviews = filteredPolicies.filter((p: any) => {
      return p.status === 'ACTIVE' && p.nextReviewDate && p.nextReviewDate < now;
    }).length;
    const policyByCategory = countBy(filteredPolicies, 'category' as any);

    // ── Control metrics ─────────────────────────────────────────────────
    const controlTotal = filteredControls.length;
    const controlActive = filteredControls.filter((c: any) => c.status === 'ACTIVE').length;
    const controlByType = countBy(filteredControls, 'controlType' as any);
    const controlByAutomationMode = countBy(filteredControls, 'automationMode' as any);
    const agentOrHybrid = filteredControls.filter(
      (c: any) => c.automationMode === 'AGENT' || c.automationMode === 'HYBRID',
    ).length;
    const automationRate = controlTotal > 0
      ? Math.round((agentOrHybrid / controlTotal) * 100)
      : 0;

    // ── Coverage metrics ────────────────────────────────────────────────
    const domainsTotal = filteredDomains.length;
    const domainsWithOwners = filteredDomains.filter((d) => d.ownerId).length;

    const assetsTotal = filteredAssets.length;
    const assetsWithOwners = filteredAssets.filter((a: any) => a.owner).length;

    const processesTotal = filteredProcesses.length;
    const processesWithOwners = filteredProcesses.filter((p) => p.ownerId).length;

    // ── Assemble response ───────────────────────────────────────────────
    const summary = {
      issues: {
        total: issueTotal,
        open: issueOpen,
        investigating: issueInvestigating,
        inProgress: issueInProgress,
        resolved: issueResolved,
        bySeverity: issueBySeverity,
        byType: issueByType,
      },
      tasks: {
        total: taskTotal,
        open: taskOpen,
        inProgress: taskInProgress,
        pendingReview: taskPendingReview,
        pendingApproval: taskPendingApproval,
        completed: taskCompleted,
        overdue: taskOverdue,
        byPriority: taskByPriority,
        byAutomationMode: taskByAutomationMode,
      },
      policies: {
        total: policyTotal,
        active: policyActive,
        draft: policyDraft,
        underReview: policyUnderReview,
        overdueReviews: policyOverdueReviews,
        byCategory: policyByCategory,
      },
      controls: {
        total: controlTotal,
        active: controlActive,
        byType: controlByType,
        byAutomationMode: controlByAutomationMode,
        automationRate,
      },
      coverage: {
        domainsWithOwners,
        domainsTotal,
        assetsWithOwners,
        assetsTotal,
        processesWithOwners,
        processesTotal,
      },
    };

    res.json({ success: true, data: summary });
  } catch (err: any) {
    logger.error({ err }, 'Control tower summary failed');
    res.status(500).json({ success: false, error: err?.message || 'Failed to generate control tower summary' });
  }
});

export default router;
