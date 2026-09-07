import { Router, Request, Response } from 'express';
import { randomBytes, randomInt, createHash } from 'crypto';
import { v4 as uuid } from 'uuid';
import logger from '../lib/logger';
import { loadStore, registerStore } from '../lib/persistence';
import { auditService } from '../services/audit.service';
import { dataAssets, dataAssetColumns } from './data-assets';
import type { StoredDataAssetColumn } from './data-assets';
import { getDataAssetsRepository } from '../db/data-assets.repo';
import { getDataAssetColumnsRepository } from '../db/data-asset-columns.repo';
import { createNotification } from './notifications';
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rate-limit';
import { asyncHandler } from '../middleware/asyncHandler';
import { getConnectorsRepository } from '../db/connectors.repo';
import { getConnectorEventsRepository } from '../db/connector-events.repo';
import { computeDiscoveredAssetHealth } from '../lib/asset-health';
import { computeSchemaFingerprint, hasSchemaDrifted } from '../lib/schema-drift';
import { reconcileSchemaDriftIssues, type SchemaDriftEvent } from './governance-issues';

// ──────────────────────────────────────────────────────────────────────────
// Connectors — the on-prem agent surface.
//
// Two halves:
//   1. Admin-side: register / list / revoke connector instances.
//      Authenticated via the standard Bearer-token middleware mounted
//      by index.ts; only ORG_ADMIN+ should be exposing connector
//      management to the UI.
//   2. Connector-side: pair / heartbeat / report. These take a
//      connector-issued token in the Authorization header rather
//      than a user JWT. Validated against the connector store's
//      hashed token field below — never compare plaintext.
//
// Pairing flow:
//   1. Admin clicks "Add connector" in Settings → POST /pair/start
//      with the desired name. Backend mints a 8-digit pairing code
//      and a placeholder connector row. Code TTLs in 10 minutes.
//   2. Admin runs the agent container; it prints the pairing code in
//      its logs (admin types it back into the UI) OR the admin
//      passes the code as an env var to the container directly.
//      Either way the connector calls POST /pair/claim with the
//      code.
//   3. Backend returns a long-lived token; connector writes it to
//      its local config and starts the steady-state poll loop.
//
// Token shape: 48 bytes of random hex (96 chars) prefixed with
// "pct_" so a leaked one is obviously a Procela connector token
// when it shows up in a logfile or pastebin. Stored as a SHA-256
// hash; the plaintext is only returned at pair-claim time.
// ──────────────────────────────────────────────────────────────────────────

export interface StoredConnector {
  id: string;
  orgId: string;
  /** Human-given name — shown in the registry list. */
  name: string;
  /** SHA-256 hash of the plaintext token. Plaintext is shown to the
   *  admin once at pair-claim time, then never re-displayed. */
  tokenHash: string | null;
  /** 8-digit pairing code awaiting claim. Cleared once the connector
   *  claims it and exchanges for a token. */
  pairingCode: string | null;
  pairingCodeExpiresAt: string | null;
  /** Which Systems this connector is responsible for. Population
   *  happens out of band — admin assigns systems on the connector
   *  detail or on the System edit form. v1 leaves it empty and the
   *  connector reports against any system the admin tags. */
  systemIds: string[];
  /** Reported by the agent on every heartbeat. Drives the offline
   *  notification: when (now - lastHeartbeatAt) > offlineThresholdMs
   *  the row turns amber and a notification fires. */
  lastHeartbeatAt: string | null;
  /** Free-form version string the agent self-reports (e.g. "1.0.0"). */
  agentVersion: string | null;
  /** Whether the row is currently considered offline. Computed at
   *  list time but persisted here so we can fire the notification
   *  exactly once on the transition. */
  status: 'PAIRED' | 'ONLINE' | 'STALE' | 'OFFLINE' | 'REVOKED';
  createdAt: string;
  updatedAt: string;
}

export const connectors: StoredConnector[] = loadStore<StoredConnector>('connectors');
registerStore('connectors', connectors);

// Audit / detail entries the agent posts. Lives in its own store so
// the per-connector activity tab can scan a focused slice rather than
// filter the global audit log.
export interface StoredConnectorEvent {
  id: string;
  connectorId: string;
  orgId: string;
  type: 'PAIRED' | 'HEARTBEAT' | 'SCAN_STARTED' | 'SCAN_COMPLETED' | 'SCAN_FAILED' | 'ASSETS_REPORTED' | 'SYNC_JOBS_FETCHED' | 'SYNC_PUSHED' | 'DQ_RULES_FETCHED' | 'DQ_RESULTS_APPLIED';
  ts: string;
  /** Optional payload — counts, durations, error text. Keep small. */
  data: Record<string, any>;
}
export const connectorEvents: StoredConnectorEvent[] = loadStore<StoredConnectorEvent>('connectorEvents');
registerStore('connectorEvents', connectorEvents);

const connectorsRepo = getConnectorsRepository(connectors);
// Foreign data-asset writes go through the repository (Postgres or JSON) — PR 7b.
const dataAssetsRepo = getDataAssetsRepository(dataAssets);
const dataAssetColumnsRepo = getDataAssetColumnsRepository(dataAssetColumns);
const connectorEventsRepo = getConnectorEventsRepository(connectorEvents);

const router = Router();

// Pairing-code brute force throttle. The codes are 8 digits with a
// 10-min TTL so the search space is small enough that a tight
// per-IP limit is worth the cost. 10 attempts per minute and 100
// per hour keys on IP only — the body has no identity yet.
const pairClaimLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  keyBy: (req) => `pair-claim:${req.ip || 'noip'}`,
  label: 'connector_pair_claim',
});
const pairClaimHourLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 100,
  keyBy: (req) => `pair-claim-hr:${req.ip || 'noip'}`,
  label: 'connector_pair_claim_hour',
});

const PAIRING_TTL_MS = 10 * 60 * 1000;
const STALE_THRESHOLD_MS = 30 * 60 * 1000;   // amber after 30m silence
const OFFLINE_THRESHOLD_MS = 4 * 60 * 60_000; // red after 4h silence

function hashToken(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}
function generatePairingCode(): string {
  // 8 digits, zero-padded. Avoids ambiguous characters by sticking
  // to numerics — admins type these by hand, and 'O' vs '0' is the
  // classic time-waster.
  return String(randomInt(0, 100_000_000)).padStart(8, '0');
}
function generateToken(): string {
  return 'pct_' + randomBytes(48).toString('hex');
}
function nowIso(): string {
  return new Date().toISOString();
}

/** Compute the freshness bucket for a row at read time. We don't
 *  persist this — clients always see the live computation. Persist
 *  status only when the state actually transitions to OFFLINE so we
 *  can fire the notification exactly once. */
function freshnessFor(row: StoredConnector): StoredConnector['status'] {
  if (row.status === 'REVOKED') return 'REVOKED';
  if (!row.lastHeartbeatAt) return 'PAIRED';
  const ms = Date.now() - new Date(row.lastHeartbeatAt).getTime();
  if (ms < STALE_THRESHOLD_MS) return 'ONLINE';
  if (ms < OFFLINE_THRESHOLD_MS) return 'STALE';
  return 'OFFLINE';
}

// Connector-token middleware — used by the agent-side endpoints.
// The admin-side endpoints continue to use the standard authenticateToken
// from index.ts and are mounted under the same /connectors prefix.
export async function requireConnectorToken(req: Request, res: Response, next: () => void): Promise<void> {
  const header = req.header('authorization') || '';
  const m = header.match(/^Bearer\s+(\S+)$/i);
  if (!m) { res.status(401).json({ success: false, error: 'connector token required' }); return; }
  const provided = m[1];
  if (!provided.startsWith('pct_')) { res.status(401).json({ success: false, error: 'not a connector token' }); return; }
  const hash = hashToken(provided);
  const row = (await connectorsRepo.list()).find((c) => c.tokenHash === hash && c.status !== 'REVOKED');
  if (!row) { res.status(401).json({ success: false, error: 'invalid or revoked connector token' }); return; }
  (req as any).connector = row;
  next();
}

/** Append a connector activity event. Exported so the agent-push sync
 *  endpoints (routes/connector-sync.ts) record job fetches / pushes in the
 *  same per-connector activity stream as scans. Best-effort — a failed event
 *  write never fails the request. */
export async function recordConnectorEvent(
  connectorId: string,
  orgId: string,
  type: StoredConnectorEvent['type'],
  data: Record<string, any> = {},
): Promise<void> {
  try {
    await connectorEventsRepo.create({ id: uuid(), connectorId, orgId, type, ts: nowIso(), data });
  } catch (err) {
    logger.warn({ err, connectorId, type }, 'Failed to record connector event');
  }
}

// ── Admin-side: registry CRUD ────────────────────────────────────────────

/** GET /connectors — list every connector in scope. Each row carries
 *  its live freshness bucket so the UI doesn't have to re-derive it. */
router.get('/', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  // Defensive: a single corrupt row shouldn't turn the whole list
  // endpoint into a 500 — the Settings page shows On-prem connectors
  // even when no connectors are paired, and a red "Internal Server
  // Error" banner where an empty list belongs is worse UX than
  // silently skipping a bad row.
  try {
    const { orgId } = req.query;
    const oid = (orgId as string | undefined) || req.user?.orgId;
    const rows = (await connectorsRepo.list(oid ? { orgId: oid } : undefined))
      .map((c) => {
        try {
          return {
            id: c.id,
            orgId: c.orgId,
            name: c.name,
            status: freshnessFor(c),
            lastHeartbeatAt: c.lastHeartbeatAt,
            agentVersion: c.agentVersion,
            systemIds: c.systemIds,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
            // Surface whether a pair code is still active so the UI can
            // prompt the admin to enter it on the connector side.
            pairingCodeActive: !!c.pairingCode && !!c.pairingCodeExpiresAt
              && new Date(c.pairingCodeExpiresAt).getTime() > Date.now(),
          };
        } catch (rowErr) {
          logger.warn({ err: rowErr, connectorId: c?.id }, 'Skipping malformed connector row');
          return null;
        }
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);
    res.json({ success: true, data: rows });
  } catch (err) {
    logger.error({ err }, 'Failed to list connectors');
    res.json({ success: true, data: [] });
  }
});

/** POST /connectors/pair/start — admin creates a connector row and
 *  receives a pairing code. Body: { name, orgId?, systemIds? }. */
router.post('/pair/start', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  const name = String(req.body?.name || '').trim();
  if (!name) { res.status(400).json({ success: false, error: 'name is required' }); return; }
  const orgId = (req.body?.orgId as string | undefined) || req.user?.orgId || '';
  if (!orgId) { res.status(400).json({ success: false, error: 'orgId is required' }); return; }
  const code = generatePairingCode();
  const now = nowIso();
  const row: StoredConnector = {
    id: uuid(),
    orgId,
    name,
    tokenHash: null,
    pairingCode: code,
    pairingCodeExpiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
    systemIds: Array.isArray(req.body?.systemIds) ? req.body.systemIds : [],
    lastHeartbeatAt: null,
    agentVersion: null,
    status: 'PAIRED',
    createdAt: now,
    updatedAt: now,
  };
  await connectorsRepo.create(row);
  auditService.log(orgId, req.user?.sub ?? null, 'Connector', row.id, 'CREATE', null, { name });
  res.status(201).json({
    success: true,
    data: { id: row.id, name: row.name, pairingCode: code, expiresAt: row.pairingCodeExpiresAt },
  });
});

/** PATCH /connectors/:id — update mutable admin fields. v1 only
 *  surfaces name + systemIds; everything else (token, freshness,
 *  agentVersion) is set by the agent or by lifecycle events. */
router.patch('/:id', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  const row = await connectorsRepo.get(String(req.params.id));
  if (!row) { res.status(404).json({ success: false, error: 'connector not found' }); return; }
  const before = { name: row.name, systemIds: [...row.systemIds] };
  const patch: Partial<StoredConnector> = {};
  if (typeof req.body?.name === 'string' && req.body.name.trim()) {
    patch.name = req.body.name.trim();
  }
  if (Array.isArray(req.body?.systemIds)) {
    // Coerce to strings and de-dupe so a sloppy frontend can't
    // wedge the store with duplicate entries.
    patch.systemIds = Array.from(new Set(
      req.body.systemIds.map((s: unknown) => String(s)).filter((s: string) => s.length > 0),
    ));
  }
  patch.updatedAt = nowIso();
  await connectorsRepo.update(row.id, patch);
  auditService.log(row.orgId, req.user?.sub ?? null, 'Connector', row.id, 'UPDATE', before, {
    name: row.name, systemIds: row.systemIds,
  });
  res.json({
    success: true,
    data: { id: row.id, name: row.name, systemIds: row.systemIds, status: freshnessFor(row) },
  });
});

/** DELETE /connectors/:id — revoke a connector. Marks it REVOKED so
 *  the row sticks around for audit, but the token is dead and no
 *  further heartbeats are accepted. */
router.delete('/:id', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  const row = await connectorsRepo.get(String(req.params.id));
  if (!row) { res.status(404).json({ success: false, error: 'connector not found' }); return; }
  await connectorsRepo.update(row.id, {
    status: 'REVOKED',
    tokenHash: null,
    pairingCode: null,
    pairingCodeExpiresAt: null,
    updatedAt: nowIso(),
  });
  auditService.log(row.orgId, req.user?.sub ?? null, 'Connector', row.id, 'REVOKE', null, { name: row.name });
  res.json({ success: true });
});

/** GET /connectors/:id/events — recent activity for one connector.
 *  Reverse chronological, capped at 200. Drives the Activity tab on
 *  the connector detail drawer. */
router.get('/:id/events', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  const events = (await connectorEventsRepo.list())
    .filter((e) => e.connectorId === req.params.id)
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 200);
  res.json({ success: true, data: events });
});

// ── Connector-side: pair / heartbeat / report ────────────────────────────

/** POST /connectors/pair/claim — connector hands in its pairing code,
 *  gets back a long-lived token. The code is one-shot; subsequent
 *  claims with the same code 404. */
router.post('/pair/claim', pairClaimLimiter, pairClaimHourLimiter, asyncHandler(async (req: Request, res: Response) => {
  const code = String(req.body?.code || '').trim();
  const agentVersion = String(req.body?.agentVersion || '').trim();
  if (!code) { res.status(400).json({ success: false, error: 'code is required' }); return; }
  const row = (await connectorsRepo.list()).find((c) => c.pairingCode === code);
  if (!row) { res.status(404).json({ success: false, error: 'pairing code not found' }); return; }
  if (!row.pairingCodeExpiresAt || new Date(row.pairingCodeExpiresAt).getTime() < Date.now()) {
    res.status(410).json({ success: false, error: 'pairing code expired — start a new pair' });
    return;
  }
  const token = generateToken();
  await connectorsRepo.update(row.id, {
    tokenHash: hashToken(token),
    pairingCode: null,
    pairingCodeExpiresAt: null,
    agentVersion: agentVersion || null,
    lastHeartbeatAt: nowIso(),
    status: 'ONLINE',
    updatedAt: nowIso(),
  });
  await connectorEventsRepo.create({
    id: uuid(), connectorId: row.id, orgId: row.orgId,
    type: 'PAIRED', ts: nowIso(), data: { agentVersion: row.agentVersion },
  });
  auditService.log(row.orgId, null, 'Connector', row.id, 'PAIRED', null, { name: row.name });
  res.json({ success: true, data: { connectorId: row.id, token } });
}));

/** POST /connectors/heartbeat — agent says "still here". Plain
 *  freshness ping; no payload required beyond the token. */
router.post('/heartbeat', requireConnectorToken, asyncHandler(async (req: Request, res: Response) => {
  const row = (req as any).connector as StoredConnector;
  const agentVersion = String(req.body?.agentVersion || '').trim();
  const wasOffline = freshnessFor(row) === 'OFFLINE';
  const patch: Partial<StoredConnector> = {
    lastHeartbeatAt: nowIso(),
    updatedAt: nowIso(),
  };
  if (agentVersion) patch.agentVersion = agentVersion;
  await connectorsRepo.update(row.id, patch);
  if (wasOffline) {
    // Transitioned back online — note it; the notification path
    // doesn't need a "we're back" entry but the audit log row helps
    // with forensics.
    auditService.log(row.orgId, null, 'Connector', row.id, 'BACK_ONLINE', null, { name: row.name });
  }
  res.json({ success: true });
}));

/** POST /connectors/report — agent ships a metadata snapshot. Accepts
 *  a flat list of "assets" each with `name`, optional `systemId`,
 *  `description`, `rowCount`, `lastWriteAt`, and (v2) an optional
 *  `columns[]` of { name, dataType, nullable, ordinal }.
 *  Behaviour:
 *    - Upsert assets by (orgId, name): existing get healthScore +
 *      lastWriteAt refreshed; missing ones are created as Bronze.
 *    - Upsert their columns by (dataAssetId, columnName): new columns
 *      are created (with dataType + discovery provenance), a changed
 *      dataType is refreshed. Column-less reports skip this entirely,
 *      so an older agent never wipes a curated schema.
 *    - Audit-only throughout — nothing not reported is deleted.
 *  Returns created/updated counts for both assets and columns. */
router.post('/report', requireConnectorToken, asyncHandler(async (req: Request, res: Response) => {
  const row = (req as any).connector as StoredConnector;
  const incoming = Array.isArray(req.body?.assets) ? req.body.assets : [];
  let created = 0;
  let updated = 0;
  let columnsCreated = 0;
  let columnsUpdated = 0;
  // Snapshot the assets once; new rows are pushed back in so a later same-name
  // asset in this same batch still dedups against them (PR 7b).
  const allAssets = await dataAssetsRepo.list();
  // Snapshot columns too, indexed by (dataAssetId, columnName) so column
  // upserts dedup without an N+1 read. Same audit-only stance as assets:
  // reported columns are created / type-refreshed, never deleted.
  const allColumns = await dataAssetColumnsRepo.list();
  const colKey = (dataAssetId: string, columnName: string) => `${dataAssetId} ${columnName}`;
  const colIndex = new Map<string, StoredDataAssetColumn>();
  for (const c of allColumns) colIndex.set(colKey(c.dataAssetId, c.columnName), c);

  // #422: compute every create/update in memory first (Phase 1), preserving the
  // in-batch dedup, then flush them concurrently (Phase 2). The previous handler
  // awaited each asset + column write in series — ~a thousand serial round-trips
  // for a real schema, slow enough to stall other requests during a report.
  const assetCreates: any[] = [];
  const assetUpdates: typeof allAssets = [];
  const columnCreates: StoredDataAssetColumn[] = [];
  const columnUpdates: StoredDataAssetColumn[] = [];
  // Schema-drift verdicts, reconciled into governance issues after the flush.
  const driftEvents: SchemaDriftEvent[] = [];

  for (const a of incoming) {
    const name = String(a?.name || '').trim();
    if (!name) continue;
    const systemId = String(a?.systemId || '').trim();
    const rowCount = typeof a?.rowCount === 'number' ? a.rowCount : null;
    const lastWriteAt = typeof a?.lastWriteAt === 'string' ? a.lastWriteAt : null;
    // Fingerprint this scan's column set (null when the agent omits columns)
    // so we can compare it against the stored baseline for schema drift.
    const incomingFingerprint = computeSchemaFingerprint(Array.isArray(a?.columns) ? a.columns : null);
    const reportedColumnCount = Array.isArray(a?.columns) ? a.columns.length : undefined;
    const existing = allAssets.find((d) => d.orgId === row.orgId && d.name === name);
    let assetId: string;
    if (existing) {
      // Capture the previous row count BEFORE overwriting it — the delta vs
      // this scan is an "actively maintained" signal for the health score.
      const previousRowCount = typeof (existing as any).rowCount === 'number' ? (existing as any).rowCount : null;
      // Detect schema drift against the stored fingerprint before overwriting
      // it. Only a scan that actually reported columns carries a signal.
      const drifted = hasSchemaDrifted((existing as any).schemaFingerprint, incomingFingerprint);
      if (incomingFingerprint) {
        driftEvents.push({
          asset: { id: existing.id, name, systemId: existing.systemId || null, ownerPersonId: (existing as any).ownerPersonId || null },
          drifted,
          columnCount: reportedColumnCount,
        });
      }
      // Persist the reported row count. Only overwrite when this scan
      // actually reported one, so an older agent that omits rowCount
      // never nulls a value a newer scan recorded.
      if (rowCount !== null) (existing as any).rowCount = rowCount;
      if (lastWriteAt) (existing as any).healthScoreAt = lastWriteAt;
      // Refresh the fingerprint baseline only when this scan reported columns,
      // so an older column-less agent never clears it.
      if (incomingFingerprint) (existing as any).schemaFingerprint = incomingFingerprint;
      // Graded freshness/liveness health: decays by age since last write, caps
      // an empty table low, grades a row-count shrink by magnitude, and applies
      // a penalty when the schema drifted. Falls back to the persisted row
      // count when this scan omitted one, so the empty-table check still holds.
      existing.healthScore = computeDiscoveredAssetHealth({
        lastWriteAt,
        rowCount: rowCount ?? previousRowCount,
        previousRowCount,
        schemaDrift: drifted,
      });
      existing.updatedAt = nowIso();
      // Tag the asset with the connector that owns its freshness
      // signal — surfaced as the "Synced N min ago" chip on the
      // Data Asset detail page.
      (existing as any).lastSyncedByConnectorId = row.id;
      (existing as any).lastSyncedAt = nowIso();
      assetUpdates.push(existing);
      assetId = existing.id;
      updated++;
    } else {
      const now = nowIso();
      const newAsset = {
        id: uuid(), orgId: row.orgId, name,
        description: String(a?.description || ''),
        systemId: systemId || row.systemIds[0] || '',
        owner: '', stewardIds: [],
        governanceTier: 'BRONZE',
        // First sighting — no prior row count, so this grades on freshness
        // (and the empty-table cap) alone.
        healthScore: computeDiscoveredAssetHealth({ lastWriteAt, rowCount }),
        createdAt: now, updatedAt: now,
        lastSyncedByConnectorId: row.id,
        lastSyncedAt: now,
        ...(rowCount !== null ? { rowCount } : {}),
        // First sighting establishes the drift baseline — never itself drift.
        ...(incomingFingerprint ? { schemaFingerprint: incomingFingerprint } : {}),
      } as any;
      assetCreates.push(newAsset);
      allAssets.push(newAsset);
      assetId = newAsset.id;
      created++;
    }

    // Column-level metadata (v2): create new columns, refresh a changed
    // dataType. Audit-only — columns no longer reported are left in
    // place. Skipped entirely when the agent sends no columns (older
    // agents), so it never wipes a manually-curated schema.
    if (Array.isArray(a?.columns)) {
      for (const col of a.columns) {
        const columnName = String(col?.name || '').trim();
        if (!columnName) continue;
        const dataType = typeof col?.dataType === 'string' && col.dataType ? col.dataType : undefined;
        const key = colKey(assetId, columnName);
        const existingCol = colIndex.get(key);
        if (existingCol) {
          if (dataType && existingCol.dataType !== dataType) {
            existingCol.dataType = dataType;
            existingCol.updatedAt = nowIso();
            columnUpdates.push(existingCol);
            columnsUpdated++;
          }
        } else {
          const nowc = nowIso();
          const newCol: StoredDataAssetColumn = {
            id: uuid(), dataAssetId: assetId, columnName,
            ...(dataType ? { dataType } : {}),
            // Record the discovery provenance so a steward can see the
            // column came from this scanned source, not a manual add.
            sourceAsset: name, sourceColumn: columnName,
            createdAt: nowc, updatedAt: nowc,
          };
          columnCreates.push(newCol);
          allColumns.push(newCol);
          colIndex.set(key, newCol);
          columnsCreated++;
        }
      }
    }
  }

  // Phase 2 — flush concurrently. Assets before columns (a column references its
  // asset id); creates before updates so an in-batch duplicate name that became
  // an update of a just-created row still lands.
  await Promise.all(assetCreates.map((a) => dataAssetsRepo.create(a)));
  await Promise.all(assetUpdates.map((a) => dataAssetsRepo.update(a.id, a)));
  await Promise.all(columnCreates.map((c) => dataAssetColumnsRepo.create(c)));
  await Promise.all(columnUpdates.map((c) => dataAssetColumnsRepo.update(c.id, c)));

  // Raise / resolve schema-drift issues for assets whose column set moved (or
  // stabilized) since the last scan. Best-effort: a hiccup here must not fail
  // the report ingest, which is the connector's primary contract.
  try {
    await reconcileSchemaDriftIssues(row.orgId, driftEvents);
  } catch (err) {
    logger.warn({ err, connectorId: row.id }, 'Schema-drift issue reconciliation failed');
  }

  await connectorsRepo.update(row.id, { lastHeartbeatAt: nowIso(), updatedAt: nowIso() });
  await connectorEventsRepo.create({
    id: uuid(), connectorId: row.id, orgId: row.orgId,
    type: 'ASSETS_REPORTED', ts: nowIso(),
    data: { incoming: incoming.length, created, updated, columnsCreated, columnsUpdated, rowCount: incoming.length },
  });
  res.json({ success: true, data: { created, updated, columnsCreated, columnsUpdated, total: incoming.length } });
}));

/** Internal helper used by the scheduled-offline scan (next file).
 *  Lifts the silent connectors into OFFLINE state and writes one
 *  notification per transition. Exposed so the test suite can drive
 *  it directly without waiting on a real timer. */
export async function scanForOfflineConnectors(): Promise<{ transitioned: number }> {
  let transitioned = 0;
  for (const row of await connectorsRepo.list()) {
    if (row.status === 'REVOKED') continue;
    if (!row.lastHeartbeatAt) continue;
    const live = freshnessFor(row);
    if (live === 'OFFLINE' && row.status !== 'OFFLINE') {
      row.status = 'OFFLINE';
      row.updatedAt = nowIso();
      transitioned++;
      await connectorsRepo.update(row.id, { status: 'OFFLINE', updatedAt: row.updatedAt });
      createNotification({
        orgId: row.orgId,
        type: 'WARNING',
        title: `${row.name} connector has been offline for over 4 hours`,
        message: `Last heartbeat ${row.lastHeartbeatAt}. Check the connector host and re-pair if needed.`,
        link: '/settings?tab=connectors',
      });
      logger.warn({ connectorId: row.id, name: row.name }, 'Connector marked OFFLINE');
    }
  }
  return { transitioned };
}

export default router;
