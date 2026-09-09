// Digest-preferences repository — a user's weekly-digest settings. The
// `categories` field is a JSONB string array; everything else is scalar.

import type { DigestPreference, DigestCategory, DigestFrequency } from '../services/digest-preferences';
import { saveStore } from '../lib/persistence';
import { jsonRepository, Repository } from './repository';
import { getPrisma, hasDatabase } from './prisma';

export function jsonDigestPreferencesRepository(store: DigestPreference[]): Repository<DigestPreference> {
  return jsonRepository<DigestPreference>(store, () => saveStore('digest-preferences', store));
}

type PrismaDigestPreferenceRow = {
  id: string;
  orgId: string;
  userId: string;
  email: string;
  name: string;
  frequency: string;
  categories: unknown;
  emailEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export interface PrismaDigestPreferenceDelegate {
  findMany(arg?: { where?: { orgId?: string } }): Promise<PrismaDigestPreferenceRow[]>;
  findUnique(arg: { where: { id: string } }): Promise<PrismaDigestPreferenceRow | null>;
  create(arg: { data: Record<string, unknown> }): Promise<PrismaDigestPreferenceRow>;
  update(arg: { where: { id: string }; data: Record<string, unknown> }): Promise<PrismaDigestPreferenceRow>;
  delete(arg: { where: { id: string } }): Promise<PrismaDigestPreferenceRow>;
}

function fromPrisma(r: PrismaDigestPreferenceRow): DigestPreference {
  return {
    id: r.id,
    orgId: r.orgId,
    userId: r.userId,
    email: r.email,
    name: r.name ?? '',
    frequency: r.frequency as DigestFrequency,
    categories: (Array.isArray(r.categories) ? r.categories : []) as DigestCategory[],
    emailEnabled: r.emailEnabled,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toPrismaData(row: Partial<DigestPreference>): Record<string, unknown> {
  const d: Record<string, unknown> = {};
  if (row.id !== undefined) d.id = row.id;
  if (row.orgId !== undefined) d.orgId = row.orgId;
  if (row.userId !== undefined) d.userId = row.userId;
  if (row.email !== undefined) d.email = row.email;
  if (row.name !== undefined) d.name = row.name;
  if (row.frequency !== undefined) d.frequency = row.frequency;
  if (row.categories !== undefined) d.categories = row.categories;
  if (row.emailEnabled !== undefined) d.emailEnabled = row.emailEnabled;
  if (row.createdAt !== undefined) d.createdAt = new Date(row.createdAt);
  return d;
}

export function prismaDigestPreferencesRepository(
  clientFactory: () => { digestPreference: PrismaDigestPreferenceDelegate } =
    getPrisma as unknown as () => { digestPreference: PrismaDigestPreferenceDelegate },
): Repository<DigestPreference> {
  return {
    async list(filter) {
      const client = clientFactory();
      const rows = filter?.orgId
        ? await client.digestPreference.findMany({ where: { orgId: filter.orgId } })
        : await client.digestPreference.findMany();
      return rows.map(fromPrisma);
    },
    async get(id) {
      const client = clientFactory();
      const row = await client.digestPreference.findUnique({ where: { id } });
      return row ? fromPrisma(row) : null;
    },
    async create(row) {
      const client = clientFactory();
      const created = await client.digestPreference.create({ data: toPrismaData(row) });
      return fromPrisma(created);
    },
    async update(id, patch) {
      const client = clientFactory();
      try {
        const data = toPrismaData(patch);
        delete data.updatedAt;
        const updated = await client.digestPreference.update({ where: { id }, data });
        return fromPrisma(updated);
      } catch (err) {
        if ((err as { code?: string }).code === 'P2025') return null;
        throw err;
      }
    },
    async delete(id) {
      const client = clientFactory();
      try {
        await client.digestPreference.delete({ where: { id } });
        return true;
      } catch (err) {
        if ((err as { code?: string }).code === 'P2025') return false;
        throw err;
      }
    },
  };
}

export function getDigestPreferencesRepository(store: DigestPreference[]): Repository<DigestPreference> {
  return hasDatabase()
    ? prismaDigestPreferencesRepository()
    : jsonDigestPreferencesRepository(store);
}
