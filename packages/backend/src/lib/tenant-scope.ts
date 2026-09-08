// ──────────────────────────────────────────────────────────────────────────
// Tenant-isolation enforcement helpers.
//
// The auth middleware (middleware/auth.ts) only validates an orgId the client
// *volunteers*: if the caller supplies none, no scope is applied. And the
// list filter (lib/org-scope.ts filterByOrgScope) treats "no scope" as "return
// everything". Together those two defaults mean a restricted user who simply
// omits `?orgId` — or hits a bare `/:id` route — reaches another tenant's rows.
//
// These helpers close that hole by deriving the caller's visible-org set from
// their identity (never from a client-supplied value) and enforcing it:
//
//   • scopeListForRequest(req, items) — for list endpoints. Drops every row
//     outside the caller's visible orgs *first*, then applies the optional
//     explicit `?orgId` narrowing. A restricted caller can never widen past
//     their own orgs by omitting the param.
//
//   • assertOrgAccess(req, res, orgId) — for `/:id` GET/PUT/DELETE. Returns
//     true when the caller may touch a row in `orgId`; otherwise sends 404
//     (not 403 — a cross-tenant id must not be confirmed to exist) and
//     returns false so the handler can `return`.
//
// Unrestricted callers (SUPER_ADMIN, or the dev-fallback identity with no
// people row) get visible === null and pass through unchanged — identical to
// today's behavior for them.
//
// getVisibleOrgIds / canAccessOrg live on routes/people; they're lazy-required
// inside each function to avoid a module import cycle at boot (the same pattern
// middleware/auth.ts uses).
// ──────────────────────────────────────────────────────────────────────────

import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { filterByOrgScope } from './org-scope';

type OrgScoped = { orgId?: string; orgIds?: string[] };

function visibleOrgIds(req: AuthenticatedRequest): Set<string> | null {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getVisibleOrgIds } = require('../routes/people') as typeof import('../routes/people');
  return getVisibleOrgIds(req.user);
}

/** Pull the explicit scope the client asked to narrow to, if any. Mirrors the
 *  params middleware/auth.ts validates: `?orgId` and `?scopeOrgId`. */
function explicitScope(req: AuthenticatedRequest): string | undefined {
  const q = (req.query || {}) as Record<string, unknown>;
  const raw = q.orgId ?? q.scopeOrgId;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function inScope(item: OrgScoped, visible: Set<string>): boolean {
  if (item.orgId && visible.has(item.orgId)) return true;
  if (item.orgIds && item.orgIds.some((id) => visible.has(id))) return true;
  return false;
}

/**
 * Scope a list for the requesting user: enforce their visible-org set, then
 * honor an explicit `?orgId` narrowing on top. Use in place of a bare
 * `filterByOrgScope(items, req.query.orgId)` on every list endpoint.
 */
export function scopeListForRequest<T extends OrgScoped>(
  req: AuthenticatedRequest,
  items: T[],
): T[] {
  const visible = visibleOrgIds(req);
  // Unrestricted caller: preserve exact prior behavior (explicit filter only).
  const enforced = visible ? items.filter((it) => inScope(it, visible)) : items;
  return filterByOrgScope(enforced, explicitScope(req));
}

/**
 * Guard a single `/:id` record by its org. Returns true when the caller may
 * access it; otherwise responds 404 and returns false. Callers must `return`
 * when it returns false — the response is already sent.
 */
export function assertOrgAccess(
  req: AuthenticatedRequest,
  res: Response,
  orgId: string | null | undefined,
  notFoundMessage = 'Not found',
): boolean {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { canAccessOrg } = require('../routes/people') as typeof import('../routes/people');
  if (orgId && canAccessOrg(req.user, orgId)) return true;
  const visible = visibleOrgIds(req);
  // Unrestricted caller with a row that simply has no orgId still passes.
  if (visible === null) return true;
  res.status(404).json({ success: false, error: notFoundMessage });
  return false;
}

/**
 * Multi-org variant of assertOrgAccess for records visible through ANY of
 * several orgs (e.g. a ProcessNode with an `orgIds[]` array plus a primary
 * `orgId`). Passes when the caller can access at least one of them, or is
 * unrestricted. Responds 404 and returns false otherwise.
 */
export function assertOrgAccessAny(
  req: AuthenticatedRequest,
  res: Response,
  orgIds: Array<string | null | undefined>,
  notFoundMessage = 'Not found',
): boolean {
  const visible = visibleOrgIds(req);
  if (visible === null) return true; // unrestricted
  if (orgIds.some((id) => id != null && visible.has(id))) return true;
  res.status(404).json({ success: false, error: notFoundMessage });
  return false;
}
