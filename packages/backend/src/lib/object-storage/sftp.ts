// SFTP object-store adapter. Unlike S3/Azure/GCS (fixed cloud endpoints), SFTP
// connects to an arbitrary host, so it runs the same SSRF host guard the DB
// drivers use before opening a socket. One connection is opened lazily and
// reused across list + download, then released by close() (the orchestrator
// calls it in a finally). Auth is a password or a private key.

import { assertConnectableHost } from '../db-source/ssrf-guard';
import type { ObjectStore, ObjectRef } from './types';

export interface SftpStoreConfig {
  host: string;
  port?: number;
  username?: string;
  password?: string;
  /** PEM private key (an alternative to the password). */
  privateKey?: string;
}

const CONNECT_TIMEOUT_MS = 10_000;
/** Bound the directory walk so a deep tree can't fan out unboundedly. */
const MAX_DIRS_VISITED = 1000;

export function createSftpStore(cfg: SftpStoreConfig): ObjectStore {
  if (!cfg.host) throw new Error('SFTP connection is missing a host');
  if (!cfg.username) throw new Error('SFTP connection is missing a username');
  if (!cfg.password && !cfg.privateKey) throw new Error('SFTP connection needs a password or a private key');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let clientPromise: Promise<any> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getClient = async (): Promise<any> => {
    if (!clientPromise) {
      clientPromise = (async () => {
        // SSRF guard before the socket — refuse metadata/link-local (and
        // private/loopback when DB_SOURCE_BLOCK_PRIVATE_HOSTS is set).
        await assertConnectableHost(cfg.host);
        const SftpClient = (await import('ssh2-sftp-client')).default;
        const client = new SftpClient();
        await client.connect({
          host: cfg.host,
          port: cfg.port ?? 22,
          username: cfg.username,
          password: cfg.password,
          privateKey: cfg.privateKey,
          readyTimeout: CONNECT_TIMEOUT_MS,
        });
        return client;
      })();
    }
    return clientPromise;
  };

  return {
    async list(prefix: string, max: number): Promise<ObjectRef[]> {
      const client = await getClient();
      const start = prefix && prefix.trim() ? prefix : '.';
      const out: ObjectRef[] = [];
      const queue: string[] = [start];
      let visited = 0;
      // Bounded breadth-first walk: files are collected, sub-directories are
      // enqueued, symlinks skipped (avoids loops), capped by max + dir budget.
      while (queue.length > 0 && out.length < max && visited < MAX_DIRS_VISITED) {
        const dir = queue.shift()!;
        visited++;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let entries: Array<{ name: string; type: string; size?: number }>;
        try { entries = await client.list(dir); } catch { continue; }
        for (const e of entries) {
          const full = dir === '.' ? e.name : `${dir.replace(/\/$/, '')}/${e.name}`;
          if (e.type === 'd') queue.push(full);
          else if (e.type === '-') {
            out.push({ key: full, size: typeof e.size === 'number' ? e.size : undefined });
            if (out.length >= max) break;
          }
        }
      }
      return out;
    },

    async download(key: string): Promise<Buffer> {
      const client = await getClient();
      // With no destination, ssh2-sftp-client returns the file as a Buffer.
      const data = await client.get(key);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return Buffer.isBuffer(data) ? data : Buffer.from(data as any);
    },

    async close(): Promise<void> {
      if (!clientPromise) return;
      const client = await clientPromise.catch(() => null);
      clientPromise = null;
      if (client) await client.end().catch(() => { /* best-effort */ });
    },
  };
}
