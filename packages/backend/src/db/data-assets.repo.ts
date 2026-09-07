// DataAsset repository — third per-entity migration.
//
// New patterns this repo exercises vs earlier entities:
//   - Native Postgres String[] columns (sensitivityTags). These map
//     1:1 with the JSON array shape, so no join-table dance required —
//     the mapper just hands the array through.
//   - JSONB payload for retentionDuration ({ value, unit }). Kept
//     structured so future WHERE clauses on retention duration are
//     queryable rather than string-parsed.
//   - Multiple string-enum fields (dataType,
//     refreshFrequency, origin) stored as plain String — a customer
//     can extend the vocabulary on their side without a schema
//     migration. The current codebase's fixed lists live in
//     validation code, not on the storage layer.
//   - stewardIds M2M via DataAssetSteward join table — same
//     delete-all + createMany rewrite pattern DataDomain uses.
//   - Field-rename mapping: JSON `ownerPersonId` ↔ schema
//     `ownerPersonId` (we renamed the schema slot to match, so no
//     runtime translation needed on that field any more).
//
// Deprecated JSON fields (owner, sourceConnectionId, sourceAsset,
// sourceColumn, category, retentionPolicy) are intentionally NOT
// carried through the Prisma path. If the JSON row still has them,
// they're preserved on the JSON path (via jsonRepository), but the
// Prisma path writes only the current-shape fields. This is
// consistent with the strip-on-load migrations the route already
// runs — the schema is the target, not the legacy shape.

import type { StoredDataAsset } from '../routes/data-assets';
import { saveStore } from '../lib/persistence';
import { jsonRepository, Repository } from './repository';
import { getPrisma, hasDatabase } from './prisma';

// ── JSON path ──

export function jsonDataAssetsRepository(store: StoredDataAsset[]): Repository<StoredDataAsset> {
  return jsonRepository<StoredDataAsset>(store, () => saveStore('dataAssets', store));
}

// ── Postgres path ──

type PrismaAssetRow = {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  systemId: string | null;
  ownerPersonId: string | null;
  dataDomainId: string | null;
  governanceTier: 'BRONZE' | 'SILVER' | 'GOLD';
  healthScore: number;
  healthScoreAt: Date | null;
  isSystemOfRecord?: boolean;
  sensitivityTags: string[];
  dataType: string | null;
  refreshFrequency: string | null;
  origin: string | null;
  retentionDuration: unknown; // JSONB
  retentionReason: string | null;
  lastSyncedByConnectorId: string | null;
  lastSyncedAt: Date | null;
  // Prisma returns BigInt columns as JS bigint; the app layer narrows it
  // back to a plain number (row counts are far below 2^53).
  rowCount: bigint | null;
  schemaFingerprint?: string | null;
  createdAt: Date;
  updatedAt: Date;
  stewards?: Array<{ personId: string }>;
};

export interface PrismaAssetDelegate {
  findMany(arg?: {
    where?: { orgId?: string };
    include?: { stewards?: boolean };
  }): Promise<PrismaAssetRow[]>;
  findUnique(arg: {
    where: { id: string };
    include?: { stewards?: boolean };
  }): Promise<PrismaAssetRow | null>;
  create(arg: { data: Record<string, unknown> }): Promise<PrismaAssetRow>;
  update(arg: { where: { id: string }; data: Record<string, unknown> }): Promise<PrismaAssetRow>;
  delete(arg: { where: { id: string } }): Promise<PrismaAssetRow>;
}

function fromPrisma(r: PrismaAssetRow): StoredDataAsset {
  return {
    id: r.id,
    orgId: r.orgId,
    name: r.name,
    description: r.description ?? '',
    systemId: r.systemId ?? '',
    // Legacy `owner` string kept blank — the Prisma path doesn't
    // round-trip the deprecated field.
    owner: '',
    ownerPersonId: r.ownerPersonId,
    stewardIds: (r.stewards ?? []).map((s) => s.personId),
    governanceTier: r.governanceTier,
    healthScore: r.healthScore,
    ...(r.healthScoreAt ? { healthScoreAt: r.healthScoreAt.toISOString() } : {}),
    ...(r.isSystemOfRecord ? { isSystemOfRecord: true } : {}),
    ...(r.sensitivityTags.length > 0 ? { sensitivityTags: r.sensitivityTags as StoredDataAsset['sensitivityTags'] } : {}),
    ...(r.dataType ? { dataType: r.dataType as StoredDataAsset['dataType'] } : {}),
    ...(r.refreshFrequency ? { refreshFrequency: r.refreshFrequency as StoredDataAsset['refreshFrequency'] } : {}),
    ...(r.origin ? { origin: r.origin as StoredDataAsset['origin'] } : {}),
    ...(r.retentionDuration ? { retentionDuration: r.retentionDuration as StoredDataAsset['retentionDuration'] } : {}),
    ...(r.retentionReason ? { retentionReason: r.retentionReason } : {}),
    ...(r.lastSyncedByConnectorId ? { lastSyncedByConnectorId: r.lastSyncedByConnectorId } : {}),
    ...(r.lastSyncedAt ? { lastSyncedAt: r.lastSyncedAt.toISOString() } : {}),
    ...(r.rowCount !== null && r.rowCount !== undefined ? { rowCount: Number(r.rowCount) } : {}),
    ...(r.schemaFingerprint ? { schemaFingerprint: r.schemaFingerprint } : {}),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// Scalar-only Prisma data payload. stewardIds is handled by a
// separate join-table rewrite in update() (delete-all + createMany).
function toPrismaData(row: Partial<StoredDataAsset>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (row.id !== undefined) data.id = row.id;
  if (row.orgId !== undefined) data.orgId = row.orgId;
  if (row.name !== undefined) data.name = row.name;
  if (row.description !== undefined) data.description = row.description || null;
  if (row.systemId !== undefined) data.systemId = row.systemId || null;
  if (row.ownerPersonId !== undefined) data.ownerPersonId = row.ownerPersonId ?? null;
  if (row.governanceTier !== undefined) data.governanceTier = row.governanceTier;
  if (row.healthScore !== undefined) data.healthScore = row.healthScore;
  if (row.healthScoreAt !== undefined) {
    data.healthScoreAt = row.healthScoreAt ? new Date(row.healthScoreAt) : null;
  }
  if (row.isSystemOfRecord !== undefined) data.isSystemOfRecord = !!row.isSystemOfRecord;
  if (row.sensitivityTags !== undefined) data.sensitivityTags = row.sensitivityTags ?? [];
  if (row.dataType !== undefined) data.dataType = row.dataType ?? null;
  if (row.refreshFrequency !== undefined) data.refreshFrequency = row.refreshFrequency ?? null;
  if (row.origin !== undefined) data.origin = row.origin ?? null;
  if (row.retentionDuration !== undefined) data.retentionDuration = row.retentionDuration ?? null;
  if (row.retentionReason !== undefined) data.retentionReason = row.retentionReason ?? null;
  if (row.lastSyncedByConnectorId !== undefined) data.lastSyncedByConnectorId = row.lastSyncedByConnectorId ?? null;
  if (row.lastSyncedAt !== undefined) {
    data.lastSyncedAt = row.lastSyncedAt ? new Date(row.lastSyncedAt) : null;
  }
  if (row.rowCount !== undefined) {
    // BigInt column — coerce the app-layer number, truncating any
    // fractional noise. null clears it.
    data.rowCount = row.rowCount === null ? null : BigInt(Math.trunc(row.rowCount));
  }
  if (row.schemaFingerprint !== undefined) data.schemaFingerprint = row.schemaFingerprint ?? null;
  if (row.createdAt !== undefined) data.createdAt = new Date(row.createdAt);
  // updatedAt is Prisma-managed via @updatedAt.
  return data;
}

const includeRelations = { stewards: true } as const;

export function prismaDataAssetsRepository(
  clientFactory: () => { dataAsset: PrismaAssetDelegate } = getPrisma as unknown as () => { dataAsset: PrismaAssetDelegate },
): Repository<StoredDataAsset> {
  return {
    async list(filter) {
      const client = clientFactory();
      const where = filter?.orgId ? { orgId: filter.orgId } : undefined;
      const rows = await client.dataAsset.findMany({
        ...(where ? { where } : {}),
        include: includeRelations,
      });
      return rows.map(fromPrisma);
    },
    async get(id) {
      const client = clientFactory();
      const row = await client.dataAsset.findUnique({ where: { id }, include: includeRelations });
      return row ? fromPrisma(row) : null;
    },
    async create(row) {
      const client = clientFactory();
      const created = await client.dataAsset.create({ data: toPrismaData(row) });
      if (row.stewardIds && row.stewardIds.length > 0) {
        await this.update(created.id, { stewardIds: row.stewardIds });
      }
      const fresh = await this.get(created.id);
      return fresh ?? fromPrisma(created);
    },
    async update(id, patch) {
      const client = clientFactory();
      try {
        const scalarData = toPrismaData(patch);
        if (Object.keys(scalarData).length > 0) {
          await client.dataAsset.update({ where: { id }, data: scalarData });
        }
        if (patch.stewardIds !== undefined) {
          const c = client as unknown as {
            dataAssetSteward: {
              deleteMany(arg: { where: { dataAssetId: string } }): Promise<{ count: number }>;
              createMany(arg: { data: Array<{ dataAssetId: string; personId: string }> }): Promise<{ count: number }>;
            };
          };
          await c.dataAssetSteward.deleteMany({ where: { dataAssetId: id } });
          if (patch.stewardIds.length > 0) {
            await c.dataAssetSteward.createMany({
              data: patch.stewardIds.map((personId) => ({ dataAssetId: id, personId })),
            });
          }
        }
        const fresh = await this.get(id);
        return fresh;
      } catch (err) {
        if ((err as { code?: string }).code === 'P2025') return null;
        throw err;
      }
    },
    async delete(id) {
      const client = clientFactory();
      try {
        await client.dataAsset.delete({ where: { id } });
        return true;
      } catch (err) {
        if ((err as { code?: string }).code === 'P2025') return false;
        throw err;
      }
    },
  };
}

// ── Factory ──

/**
 * Pick the right DataAsset repository for the current runtime.
 * Postgres when DATABASE_URL is set; JSON otherwise. Routes call
 * this once at module-load and cache the result.
 */
export function getDataAssetsRepository(store: StoredDataAsset[]): Repository<StoredDataAsset> {
  return hasDatabase()
    ? prismaDataAssetsRepository()
    : jsonDataAssetsRepository(store);
}
