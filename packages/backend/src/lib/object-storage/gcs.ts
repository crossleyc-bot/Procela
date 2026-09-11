// Google Cloud Storage object-store adapter. Thin wrapper over
// @google-cloud/storage implementing the ObjectStore interface; discovery logic
// lives in discover.ts. Auth is a service-account JSON key or Application
// Default Credentials (GOOGLE_APPLICATION_CREDENTIALS / the metadata server) —
// the GCP-native equivalent of an S3 IAM role.

import type { ObjectStore, ObjectRef } from './types';

export interface GcsStoreConfig {
  bucket: string;
  /** Optional project id; inferred from the key JSON or ADC when omitted. */
  projectId?: string;
  /** Inline service-account JSON key (maps from the token credential). Absent
   *  → Application Default Credentials. */
  serviceAccountJson?: string;
}

export function createGcsStore(cfg: GcsStoreConfig): ObjectStore {
  if (!cfg.bucket) throw new Error('GCS connection is missing a bucket');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let bucketPromise: Promise<any> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getBucket = async (): Promise<any> => {
    if (!bucketPromise) {
      bucketPromise = (async () => {
        const { Storage } = await import('@google-cloud/storage');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const opts: any = {};
        if (cfg.projectId) opts.projectId = cfg.projectId;
        if (cfg.serviceAccountJson) {
          let creds: { client_email?: string; private_key?: string; project_id?: string };
          try { creds = JSON.parse(cfg.serviceAccountJson); }
          catch { throw new Error('GCS service-account key is not valid JSON'); }
          opts.credentials = creds;
          if (!opts.projectId && creds.project_id) opts.projectId = creds.project_id;
        }
        return new Storage(opts).bucket(cfg.bucket);
      })();
    }
    return bucketPromise;
  };

  return {
    async list(prefix: string, max: number): Promise<ObjectRef[]> {
      const bucket = await getBucket();
      // autoPaginate off + maxResults bounds the listing to one page of `max`.
      const [files] = await bucket.getFiles({ prefix: prefix || undefined, maxResults: max, autoPaginate: false });
      return (files as Array<{ name: string; metadata?: { size?: string | number } }>)
        .filter((f) => !f.name.endsWith('/'))
        .slice(0, max)
        .map((f) => ({ key: f.name, size: f.metadata?.size !== undefined ? Number(f.metadata.size) : undefined }));
    },

    async download(key: string): Promise<Buffer> {
      const bucket = await getBucket();
      const [buf] = await bucket.file(key).download();
      return buf as Buffer;
    },
  };
}
