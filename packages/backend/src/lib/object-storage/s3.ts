// S3 object-store adapter. Thin wrapper over @aws-sdk/client-s3 implementing the
// ObjectStore interface; all discovery logic lives in discover.ts. Credentials
// are optional — when an access key + secret are configured they're used
// explicitly, otherwise the AWS default provider chain applies (an IAM role /
// env / shared config), which is the recommended way to reach S3 in production.

import type { ObjectStore, ObjectRef } from './types';

export interface S3StoreConfig {
  bucket: string;
  region?: string;
  /** Access key id (maps from the connection's apiKey credential). */
  accessKeyId?: string;
  /** Secret access key (maps from the connection's password credential). */
  secretAccessKey?: string;
}

export function createS3Store(cfg: S3StoreConfig): ObjectStore {
  if (!cfg.bucket) throw new Error('S3 connection is missing a bucket');

  // The client is built lazily on first use so importing this module never
  // requires the SDK to initialise a client (mirrors the DB drivers).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let clientPromise: Promise<any> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getClient = async (): Promise<any> => {
    if (!clientPromise) {
      clientPromise = (async () => {
        const { S3Client } = await import('@aws-sdk/client-s3');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const opts: any = { region: cfg.region || process.env.AWS_REGION || 'us-east-1' };
        if (cfg.accessKeyId && cfg.secretAccessKey) {
          opts.credentials = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
        }
        return new S3Client(opts);
      })();
    }
    return clientPromise;
  };

  return {
    async list(prefix: string, max: number): Promise<ObjectRef[]> {
      const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
      const client = await getClient();
      const out: ObjectRef[] = [];
      let token: string | undefined;
      // Page until we have `max` keys or the listing ends.
      do {
        const res = await client.send(new ListObjectsV2Command({
          Bucket: cfg.bucket,
          Prefix: prefix || undefined,
          ContinuationToken: token,
          MaxKeys: Math.min(1000, max - out.length),
        }));
        for (const o of res.Contents ?? []) {
          if (o.Key && !o.Key.endsWith('/')) out.push({ key: o.Key, size: typeof o.Size === 'number' ? o.Size : undefined });
          if (out.length >= max) break;
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token && out.length < max);
      return out;
    },

    async download(key: string): Promise<Buffer> {
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      const client = await getClient();
      const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
      // The v3 SDK Body is a stream in Node; transformToByteArray collects it.
      const bytes = await res.Body.transformToByteArray();
      return Buffer.from(bytes);
    },
  };
}
