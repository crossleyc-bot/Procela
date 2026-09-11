// Azure Blob Storage object-store adapter. Thin wrapper over
// @azure/storage-blob implementing the ObjectStore interface; the discovery
// logic lives in discover.ts. Auth is a storage-account key or a SAS token —
// managed-identity would add @azure/identity and is a follow-on.

import type { ObjectStore, ObjectRef } from './types';

export interface AzureBlobStoreConfig {
  /** Storage account name (the `<account>` in `<account>.blob.core.windows.net`). */
  account: string;
  /** Container to scan (maps from the connection's bucket field). */
  container: string;
  /** Account key (maps from the apiKey credential). */
  accountKey?: string;
  /** SAS token (maps from the token credential) — an alternative to the key. */
  sasToken?: string;
}

export function createAzureBlobStore(cfg: AzureBlobStoreConfig): ObjectStore {
  if (!cfg.account) throw new Error('Azure Blob connection is missing a storage account');
  if (!cfg.container) throw new Error('Azure Blob connection is missing a container');
  if (!cfg.accountKey && !cfg.sasToken) {
    throw new Error('Azure Blob connection needs an account key or a SAS token');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let containerPromise: Promise<any> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getContainer = async (): Promise<any> => {
    if (!containerPromise) {
      containerPromise = (async () => {
        const azure = await import('@azure/storage-blob');
        const base = `https://${cfg.account}.blob.core.windows.net`;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let service: any;
        if (cfg.accountKey) {
          const cred = new azure.StorageSharedKeyCredential(cfg.account, cfg.accountKey);
          service = new azure.BlobServiceClient(base, cred);
        } else {
          // SAS token carries its own auth in the query string.
          const sas = cfg.sasToken!.startsWith('?') ? cfg.sasToken! : `?${cfg.sasToken!}`;
          service = new azure.BlobServiceClient(`${base}${sas}`);
        }
        return service.getContainerClient(cfg.container);
      })();
    }
    return containerPromise;
  };

  return {
    async list(prefix: string, max: number): Promise<ObjectRef[]> {
      const container = await getContainer();
      const out: ObjectRef[] = [];
      for await (const blob of container.listBlobsFlat({ prefix: prefix || undefined })) {
        if (!blob.name.endsWith('/')) {
          out.push({ key: blob.name, size: typeof blob.properties?.contentLength === 'number' ? blob.properties.contentLength : undefined });
        }
        if (out.length >= max) break;
      }
      return out;
    },

    async download(key: string): Promise<Buffer> {
      const container = await getContainer();
      return container.getBlockBlobClient(key).downloadToBuffer();
    },
  };
}
