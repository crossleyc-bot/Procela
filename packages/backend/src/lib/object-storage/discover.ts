// Object-storage discovery orchestrator. Provider-agnostic: given any
// ObjectStore, list a prefix, keep the objects whose extension the file
// analyzer understands, download each within bounds, infer its schema, and
// return one asset per object. Pure w.r.t. the provider — the S3/Azure/GCS/SFTP
// SDK lives in the adapter, so this logic tests against a fake store.

import { analyzeLocalBufferAsync, SUPPORTED_EXTENSIONS } from '../local-file-connector';
import type { ObjectStore, ObjectStoreAsset } from './types';

/** Scan caps: how many objects to inspect, and the per-object byte ceiling
 *  (mirrors the 50 MB local-upload cap). Both keep a huge bucket from turning
 *  one discovery call into an unbounded download. */
export const MAX_OBJECTS_SCANNED = 100;
export const MAX_OBJECT_BYTES = 50 * 1024 * 1024;

const SUPPORTED = new Set<string>(SUPPORTED_EXTENSIONS);

function extensionOf(key: string): string {
  const base = key.slice(key.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot).toLowerCase() : '';
}

export interface DiscoverObjectsOptions {
  prefix?: string;
  /** Overrides for tests / tuning; default to the module caps. */
  maxObjects?: number;
  maxBytes?: number;
}

/**
 * Discover assets from an object store. Objects whose extension isn't a
 * supported data format are skipped; a per-object failure (a corrupt file, a
 * denied download) is logged-by-omission and never fails the whole scan, so one
 * bad object can't hide the rest.
 */
export async function discoverObjectStoreAssets(
  store: ObjectStore,
  opts: DiscoverObjectsOptions = {},
): Promise<ObjectStoreAsset[]> {
  const maxObjects = opts.maxObjects ?? MAX_OBJECTS_SCANNED;
  const maxBytes = opts.maxBytes ?? MAX_OBJECT_BYTES;

  const listing = await store.list(opts.prefix ?? '', maxObjects);
  const parseable = listing
    .filter((o) => SUPPORTED.has(extensionOf(o.key)))
    .filter((o) => o.size === undefined || o.size <= maxBytes)
    .slice(0, maxObjects);

  const assets: ObjectStoreAsset[] = [];
  for (const obj of parseable) {
    try {
      const buf = await store.download(obj.key);
      if (buf.length > maxBytes) continue; // size unknown at list time, caught now
      const { rowCount, columns } = await analyzeLocalBufferAsync(buf, obj.key);
      assets.push({ name: obj.key, type: 'FILE', columns, rowCount });
    } catch {
      // Skip this object — a parse/download error on one file must not fail the
      // scan of the others.
      continue;
    }
  }
  return assets;
}
