// Per-user weekly-digest preferences.
//
// The weekly digest (services/digest.service) writes org-level in-app
// notifications for everyone. These preferences layer per-user control on
// top of that: which gap-signal categories a user wants, and whether the
// digest should also reach them by email (opt-in — email is off by default,
// so behaviour is unchanged until a user turns it on).
//
// email/name are snapshotted from the caller's token when they save, so the
// digest email sender can address the user without joining back to the
// directory (and keeps working even if the person record is later renamed).

import { v4 as uuid } from 'uuid';
import { loadStore, registerStore } from '../lib/persistence';
import { getDigestPreferencesRepository } from '../db/digest-preferences.repo';

export type DigestCategory = 'orphans' | 'coverage' | 'ungoverned' | 'ownerless';
export type DigestFrequency = 'weekly' | 'off';

export const ALL_DIGEST_CATEGORIES: DigestCategory[] = ['orphans', 'coverage', 'ungoverned', 'ownerless'];

export interface DigestPreference {
  id: string;
  orgId: string;
  userId: string;
  email: string;
  name: string;
  frequency: DigestFrequency;
  categories: DigestCategory[];
  emailEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export const digestPreferences: DigestPreference[] = loadStore<DigestPreference>('digest-preferences');
registerStore('digest-preferences', digestPreferences);

const repo = getDigestPreferencesRepository(digestPreferences);

/** Coerce an arbitrary categories payload to the known set (drops junk,
 *  de-dupes, preserves canonical order). */
export function normalizeCategories(input: unknown): DigestCategory[] {
  const wanted = new Set(Array.isArray(input) ? input : []);
  return ALL_DIGEST_CATEGORIES.filter((c) => wanted.has(c));
}

/** The effective preference for a user, or the sensible default when they've
 *  never saved one: weekly, all categories, email off (opt-in). */
export function defaultPreference(orgId: string, userId: string, email = '', name = ''): DigestPreference {
  const now = new Date().toISOString();
  return {
    id: '', orgId, userId, email, name,
    frequency: 'weekly',
    categories: [...ALL_DIGEST_CATEGORIES],
    emailEnabled: false,
    createdAt: now, updatedAt: now,
  };
}

export async function getPreference(orgId: string, userId: string): Promise<DigestPreference | null> {
  const all = await repo.list({ orgId });
  return all.find((p) => p.userId === userId) ?? null;
}

export async function listPreferencesForOrg(orgId: string): Promise<DigestPreference[]> {
  return repo.list({ orgId });
}

/** Create or update a user's preference (unique per org+user). Snapshots the
 *  caller's email/name so the digest sender can address them later. */
export async function upsertPreference(input: {
  orgId: string;
  userId: string;
  email: string;
  name: string;
  frequency: DigestFrequency;
  categories: DigestCategory[];
  emailEnabled: boolean;
}): Promise<DigestPreference> {
  const existing = await getPreference(input.orgId, input.userId);
  const now = new Date().toISOString();
  if (existing) {
    const updated = await repo.update(existing.id, {
      email: input.email || existing.email,
      name: input.name || existing.name,
      frequency: input.frequency,
      categories: input.categories,
      emailEnabled: input.emailEnabled,
      updatedAt: now,
    });
    return updated ?? existing;
  }
  const created: DigestPreference = {
    id: uuid(),
    orgId: input.orgId,
    userId: input.userId,
    email: input.email,
    name: input.name,
    frequency: input.frequency,
    categories: input.categories,
    emailEnabled: input.emailEnabled,
    createdAt: now,
    updatedAt: now,
  };
  await repo.create(created);
  return created;
}
