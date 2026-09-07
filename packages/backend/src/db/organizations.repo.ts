// Organizations repository — the reference migration for the
// JSON→Postgres adapter pattern.
//
// This file exists to demonstrate the shape every other entity will
// take when it's migrated. Three layers:
//
//   1. `StoredOrg` — the entity type (imported from routes so the
//      shape stays single-source-of-truth for now).
//   2. `jsonOrganizationsRepository()` — the JSON adapter, wraps the
//      existing in-memory array + saveStore('organizations', …).
//   3. `prismaOrganizationsRepository()` — the Postgres adapter,
//      maps StoredOrg ↔ Prisma's Organization row.
//   4. `getOrganizationsRepository()` — factory that returns the
//      Postgres path when DATABASE_URL is set, JSON otherwise.
//
// The mapper between StoredOrg and the Prisma row lives here so the
// entity type stays JSON-friendly (dates as ISO strings, empty
// strings instead of nulls where appropriate) and the DB row keeps
// the Prisma-native shape (Date objects, real nullable columns).

import type { StoredOrg } from '../routes/organizations';
import { saveStore } from '../lib/persistence';
import { jsonRepository, Repository } from './repository';
import { getPrisma, hasDatabase } from './prisma';

// ── JSON path ──

export function jsonOrganizationsRepository(store: StoredOrg[]): Repository<StoredOrg> {
  return jsonRepository<StoredOrg>(store, () => saveStore('organizations', store));
}

// ── Postgres path ──

// Row shape as Prisma returns it. Typed loosely here so we don't
// depend on the generated types being present in a fresh checkout
// (they only exist after `prisma generate` has been run against a
// live database). When the generated client is available, replace
// `Record<string, unknown>` with `Prisma.OrganizationGetPayload<...>`
// for full type safety.
// Minimal delegate shape the repository calls on the Prisma client.
// Kept structural so tests can pass a plain object stub without
// depending on the generated Prisma types (which only exist after
// `prisma generate` has been run against a live database).
export interface PrismaOrgDelegate {
  findMany(arg?: { where?: { id?: string } }): Promise<PrismaOrgRow[]>;
  findUnique(arg: { where: { id: string } }): Promise<PrismaOrgRow | null>;
  create(arg: { data: Record<string, unknown> }): Promise<PrismaOrgRow>;
  update(arg: { where: { id: string }; data: Record<string, unknown> }): Promise<PrismaOrgRow>;
  delete(arg: { where: { id: string } }): Promise<PrismaOrgRow>;
}

type PrismaOrgRow = {
  id: string;
  parentId: string | null;
  name: string;
  type: string;
  industry: string | null;
  description: string | null;
  headCount: number;
  statusMode: string | null;
  tenantSlug: string | null;
  brandDisplayName: string | null;
  brandGlyph: string | null;
  ssoButtonLabel: string | null;
  brandPrimaryColor: string | null;
  activeSensitivityRegimes?: string[] | null;
  activeComplianceFrameworks?: string[] | null;
  scorecardTargets?: unknown | null;
  syncConnectionId?: string | null;
  syncStatus?: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function fromPrisma(r: PrismaOrgRow): StoredOrg {
  return {
    id: r.id,
    parentId: r.parentId,
    name: r.name,
    // JSON store uses lowercase org types ("company", "division", …);
    // the Prisma OrgType enum stores them upper-case. Translate on
    // the way out so downstream code sees the shape it expects.
    type: r.type.toLowerCase(),
    industry: r.industry ?? '',
    description: r.description ?? '',
    headCount: r.headCount,
    ...(r.statusMode ? { statusMode: r.statusMode.toLowerCase() as StoredOrg['statusMode'] } : {}),
    ...(r.tenantSlug ? { tenantSlug: r.tenantSlug } : {}),
    ...(r.brandDisplayName ? { brandDisplayName: r.brandDisplayName } : {}),
    ...(r.brandGlyph ? { brandGlyph: r.brandGlyph } : {}),
    ...(r.ssoButtonLabel ? { ssoButtonLabel: r.ssoButtonLabel } : {}),
    ...(r.brandPrimaryColor ? { brandPrimaryColor: r.brandPrimaryColor } : {}),
    ...(r.activeSensitivityRegimes ? { activeSensitivityRegimes: r.activeSensitivityRegimes } : {}),
    ...(r.activeComplianceFrameworks ? { activeComplianceFrameworks: r.activeComplianceFrameworks } : {}),
    ...(r.scorecardTargets ? { scorecardTargets: r.scorecardTargets as StoredOrg['scorecardTargets'] } : {}),
    syncConnectionId: r.syncConnectionId ?? null,
    syncStatus: r.syncStatus ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toPrismaData(row: StoredOrg): Record<string, unknown> {
  return {
    id: row.id,
    // Prisma models the parent link through the `parent` relation
    // rather than exposing the scalar `parentId` directly on the
    // create/update input. When we have a parent id, connect it;
    // when null, omit the field entirely so Prisma leaves the FK
    // at NULL. Setting `parent: { disconnect: true }` would be the
    // idiomatic "clear the link" on update; we don't use that here
    // because organizations are never re-parented in practice.
    ...(row.parentId ? { parent: { connect: { id: row.parentId } } } : {}),
    name: row.name,
    // Mirror of the case translation in fromPrisma() — Prisma's
    // OrgType enum accepts only the upper-case variants, but the
    // JSON store uses lower-case throughout. Upshift on write.
    // Guarded because update() passes a partial patch that may not
    // include `type` at all.
    ...(row.type ? { type: row.type.toUpperCase() } : {}),
    industry: row.industry || null,
    description: row.description || null,
    headCount: row.headCount,
    // statusMode: same case dance as type — Prisma enum wants
    // upper-case (SIMPLE / REVIEW / ADVANCED), JSON stores lower.
    ...(row.statusMode ? { statusMode: row.statusMode.toUpperCase() } : {}),
    tenantSlug: row.tenantSlug ?? null,
    brandDisplayName: row.brandDisplayName ?? null,
    brandGlyph: row.brandGlyph ?? null,
    ssoButtonLabel: row.ssoButtonLabel ?? null,
    brandPrimaryColor: row.brandPrimaryColor ?? null,
    ...(row.activeSensitivityRegimes !== undefined ? { activeSensitivityRegimes: row.activeSensitivityRegimes ?? [] } : {}),
    ...(row.activeComplianceFrameworks !== undefined ? { activeComplianceFrameworks: row.activeComplianceFrameworks ?? [] } : {}),
    ...(row.scorecardTargets !== undefined ? { scorecardTargets: row.scorecardTargets ?? null } : {}),
    // Data-sync tracking — presence-guarded so a partial update that doesn't
    // mention them preserves the stored value (only the sync engine sets them).
    ...(row.syncConnectionId !== undefined ? { syncConnectionId: row.syncConnectionId } : {}),
    ...(row.syncStatus !== undefined ? { syncStatus: row.syncStatus } : {}),
    // createdAt / updatedAt are Prisma-managed via @default(now()) /
    // @updatedAt on create, but we still forward incoming timestamps
    // (e.g., during a JSON-imported bulk migration) so the audit
    // trail is preserved.
    ...(row.createdAt ? { createdAt: new Date(row.createdAt) } : {}),
    ...(row.updatedAt ? { updatedAt: new Date(row.updatedAt) } : {}),
  };
}

export function prismaOrganizationsRepository(
  // Injectable Prisma client — defaults to the real one from
  // db/prisma.ts. Tests pass a stub delegate that mimics only the
  // organization slice they need.
  clientFactory: () => { organization: PrismaOrgDelegate } = getPrisma as unknown as () => { organization: PrismaOrgDelegate },
): Repository<StoredOrg> {
  return {
    async list(filter) {
      const client = clientFactory();
      // Organizations don't have their own orgId — they ARE the org
      // — so the `filter.orgId` argument is effectively a "get by
      // id" shortcut when supplied. The generic Repository interface
      // has to accommodate every entity so we handle it here rather
      // than pushing a special case up to the caller.
      const rows = filter?.orgId
        ? await client.organization.findMany({ where: { id: filter.orgId } })
        : await client.organization.findMany();
      return rows.map(fromPrisma);
    },
    async get(id) {
      const client = clientFactory();
      const row = await client.organization.findUnique({ where: { id } });
      return row ? fromPrisma(row) : null;
    },
    async create(row) {
      const client = clientFactory();
      const created = await client.organization.create({ data: toPrismaData(row) });
      return fromPrisma(created);
    },
    async update(id, patch) {
      const client = clientFactory();
      try {
        const data = toPrismaData({ ...patch, id } as StoredOrg);
        // updatedAt is auto-managed via @updatedAt so drop any inbound
        // value to let Prisma stamp fresh.
        delete data.updatedAt;
        const updated = await client.organization.update({ where: { id }, data });
        return fromPrisma(updated);
      } catch (err) {
        // Prisma raises P2025 when the record isn't found. Return
        // null to match the JSON adapter's behaviour rather than
        // propagating the exception.
        if ((err as { code?: string }).code === 'P2025') return null;
        throw err;
      }
    },
    async delete(id) {
      const client = clientFactory();
      try {
        await client.organization.delete({ where: { id } });
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
 * Pick the right organizations repository for the current runtime.
 * Postgres when DATABASE_URL is set; JSON otherwise. Routes call
 * this once at module-load and cache the result.
 */
export function getOrganizationsRepository(store: StoredOrg[]): Repository<StoredOrg> {
  return hasDatabase()
    ? prismaOrganizationsRepository()
    : jsonOrganizationsRepository(store);
}
