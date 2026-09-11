// Provider-agnostic object-storage interface. A concrete adapter (S3 today;
// Azure Blob / GCS / SFTP are follow-ons behind this same shape) knows how to
// list and download objects; the discovery orchestrator (discover.ts) does the
// rest — filtering to parseable formats, inferring each object's schema, and
// assembling assets — so it unit-tests against a fake store with no SDK or
// network.

/** One object in a bucket/prefix listing. */
export interface ObjectRef {
  /** Full key/path of the object within the store. */
  key: string;
  /** Size in bytes when the listing reported it (used to skip oversized files
   *  before downloading). Undefined when the provider didn't include it. */
  size?: number;
}

export interface ObjectStore {
  /** List objects under `prefix`, newest-or-any order, capped at `max`. */
  list(prefix: string, max: number): Promise<ObjectRef[]>;
  /** Download one object's full bytes. */
  download(key: string): Promise<Buffer>;
}

/** A discovered object-storage asset — the same loose shape the local-file and
 *  mock paths emit (type 'FILE'), so it flows through discoverAssets unchanged. */
export interface ObjectStoreAsset {
  name: string;
  type: 'FILE';
  columns: string[];
  rowCount: number;
}
