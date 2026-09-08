// At-rest encryption for ConnectionProfile.credentials (B4 #3).
//
// A connection's credentials blob holds the secrets that let the server open a
// real socket to a customer system — password / apiKey / token. Those were
// persisted (JSON store and Prisma jsonb) in cleartext; the two other secrets
// the GA audit flagged (dbt token, OIDC clientSecret) are already enveloped
// via crypto.service, and this brings connection credentials to parity.
//
// Model (mirrors routes/dbt-cloud-connections.ts): encrypt on write, store the
// envelope everywhere (in-memory + persisted), and decrypt just-in-time at the
// point the driver actually authenticates. `encryptSecret`/`decryptSecret` are
// no-ops until a KMS/local key is configured (the default noop-passthrough
// provider), so dev, tests and the connector integration suite keep round-
// tripping cleartext unchanged; a legacy plaintext row also passes through
// decrypt untouched, so no migration is required — rows re-encrypt on next
// write.

import { encryptSecret, decryptSecret, isEncrypted } from './crypto.service';

/** Credential fields that carry a secret (masked in API responses too). */
const SECRET_FIELDS = ['password', 'apiKey', 'token'] as const;

type Credentials = Record<string, unknown> | null | undefined;

/** Return a copy of the credentials with each secret field enveloped. Skips
 *  empty values and anything already enveloped, so it's idempotent — a PUT
 *  that keeps an existing (already-encrypted) secret won't double-wrap it. */
export async function encryptCredentials<T extends Credentials>(creds: T): Promise<T> {
  if (!creds || typeof creds !== 'object') return creds;
  const out: Record<string, unknown> = { ...creds };
  for (const field of SECRET_FIELDS) {
    const v = out[field];
    if (typeof v === 'string' && v !== '' && !isEncrypted(v)) {
      out[field] = await encryptSecret(v);
    }
  }
  return out as T;
}

/** Return a copy of the credentials with each enveloped secret field decrypted
 *  back to plaintext for use by a driver. Plaintext / legacy values pass
 *  through unchanged. */
export async function decryptCredentials<T extends Credentials>(creds: T): Promise<T> {
  if (!creds || typeof creds !== 'object') return creds;
  const out: Record<string, unknown> = { ...creds };
  for (const field of SECRET_FIELDS) {
    const v = out[field];
    if (typeof v === 'string' && isEncrypted(v)) {
      out[field] = await decryptSecret(v);
    }
  }
  return out as T;
}
