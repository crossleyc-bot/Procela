// MongoDB schema discovery for direct-connect DATABASE connections whose
// engine is MONGODB.
//
// A document store has no fixed schema, so "discovery" here means: list the
// collections, sample a bounded number of documents from each, and INFER a
// field → type shape from that sample. The result is the same DiscoveredAsset
// shape the SQL introspection path produces ({ name, type, columns,
// columnTypes, rowCount }), so a Mongo source reconciles into the governed
// catalog through exactly the same downstream path as a relational one.
//
// The inference (inferMongoAssets / mongoFieldType) is kept PURE — no driver,
// no live connection — so it unit-tests without a running MongoDB, mirroring
// the sql.ts / introspect.ts split. Only discoverMongoSchema() opens a socket.

import { assertConnectableHost } from './ssrf-guard';
import { MAX_DISCOVERED_TABLES, MAX_DISCOVERED_COLUMNS, type DiscoveredAsset } from './introspect';

/** Everything the Mongo driver needs to connect and sample. Auth is optional —
 *  a no-auth dev instance connects with host + database alone. */
export interface MongoSourceRequest {
  host: string;
  port?: number;
  database: string;
  username?: string;
  password?: string;
  /** Documents to sample per collection for type inference (default 100). */
  sampleSize?: number;
}

/** One collection's sampled documents, as handed to the pure inference. */
export interface MongoCollectionSample {
  name: string;
  /** 'collection' → TABLE, 'view' → VIEW. Defaults to a table. */
  kind?: 'collection' | 'view';
  docs: Array<Record<string, unknown>>;
  /** estimatedDocumentCount() — approximate, from collection metadata, so it
   *  stays cheap on large collections (mirrors the SQL path's catalog stats). */
  estimatedCount?: number;
}

const DEFAULT_SAMPLE_SIZE = 100;
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Infer the BSON-ish type of a single sampled value. Dependency-free: Mongo's
 * wrapper types (ObjectId, Decimal128, Long, Binary, …) are duck-typed by their
 * `_bsontype` tag / constructor name so this stays a pure function that needs no
 * `mongodb` import. Distinguishes integer from double so a numeric field's type
 * is meaningful, and reports 'object' / 'array' for nested structure (a deep
 * flatten into dotted paths is the separate E4 refinement, not this).
 */
export function mongoFieldType(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  const t = typeof value;
  if (t === 'string') return 'string';
  if (t === 'boolean') return 'bool';
  if (t === 'bigint') return 'long';
  if (t === 'number') return Number.isInteger(value as number) ? 'int' : 'double';
  if (t === 'object') {
    const o = value as { _bsontype?: unknown; constructor?: { name?: string } };
    // BSON wrapper types carry a `_bsontype` tag; fall back to the constructor
    // name for driver builds that expose it differently.
    const tag = typeof o._bsontype === 'string' ? o._bsontype : o.constructor?.name;
    switch (tag) {
      case 'ObjectID':
      case 'ObjectId': return 'objectId';
      case 'Decimal128': return 'decimal';
      case 'Long': return 'long';
      case 'Int32': return 'int';
      case 'Double': return 'double';
      case 'Binary': return 'binary';
      case 'Timestamp': return 'timestamp';
      case 'UUID': return 'uuid';
      default: return 'object';
    }
  }
  return t;
}

/**
 * Turn sampled collections into DiscoveredAssets. Pure: the driver does the
 * sampling, this unions field names across the sample and collapses each
 * field's observed types into a single descriptor ('string', or 'int|string'
 * when a field is polymorphic across documents — a genuine signal for a
 * document store). `_id`, always present, sorts first; the rest are
 * alphabetical for a stable fingerprint. Bounded by MAX_DISCOVERED_COLUMNS.
 */
export function inferMongoAssets(collections: MongoCollectionSample[]): DiscoveredAsset[] {
  const out: DiscoveredAsset[] = [];
  for (const coll of collections.slice(0, MAX_DISCOVERED_TABLES)) {
    // field name → set of observed types across the sampled documents.
    const types = new Map<string, Set<string>>();
    for (const doc of coll.docs) {
      if (!doc || typeof doc !== 'object') continue;
      for (const key of Object.keys(doc)) {
        (types.get(key) ?? types.set(key, new Set()).get(key)!).add(mongoFieldType(doc[key]));
      }
    }
    // Stable order: _id first, then alphabetical. Cap the field list.
    const names = [...types.keys()].sort((a, b) =>
      a === '_id' ? -1 : b === '_id' ? 1 : a.localeCompare(b));
    const columns = names.slice(0, MAX_DISCOVERED_COLUMNS);
    const columnTypes: Record<string, string> = {};
    for (const name of columns) {
      // A field seen as null in some docs and typed in others reports the real
      // type(s), not 'null' — null is only informative when it's all we saw.
      const seen = [...(types.get(name) as Set<string>)];
      const meaningful = seen.filter((t) => t !== 'null');
      columnTypes[name] = (meaningful.length ? meaningful : seen).sort().join('|');
    }
    const count = coll.estimatedCount;
    out.push({
      name: coll.name,
      type: coll.kind === 'view' ? 'VIEW' : 'TABLE',
      columns,
      columnTypes,
      rowCount: Number.isFinite(count) && (count as number) >= 0 ? Math.trunc(count as number) : undefined,
    });
  }
  return out;
}

/**
 * Run real discovery against a live MongoDB and return the inferred assets.
 * Throws on connection / auth failure so the caller surfaces the real error
 * (fail-loud — never a silent fallback to sample assets), matching
 * discoverDbSchema. The `mongodb` driver is imported lazily so this module can
 * be loaded (and its pure inference unit-tested) without the driver resolving.
 */
export async function discoverMongoSchema(req: MongoSourceRequest): Promise<DiscoveredAsset[]> {
  if (!req.host || !req.host.trim()) throw new Error('MongoDB source is missing a host');
  if (!req.database || !req.database.trim()) throw new Error('MongoDB source is missing a database name');

  // SSRF guard: refuse cloud-metadata / link-local (and private/loopback when
  // DB_SOURCE_BLOCK_PRIVATE_HOSTS is set) before opening a socket — same guard
  // the SQL driver layer applies.
  await assertConnectableHost(req.host);

  const sampleSize = req.sampleSize && req.sampleSize > 0 ? req.sampleSize : DEFAULT_SAMPLE_SIZE;
  const { MongoClient } = await import('mongodb');

  const host = req.host.trim();
  const port = req.port ?? 27017;
  const auth = req.username ? `${encodeURIComponent(req.username)}:${encodeURIComponent(req.password ?? '')}@` : '';
  const uri = `mongodb://${auth}${host}:${port}/${encodeURIComponent(req.database)}`;

  const client = new MongoClient(uri, {
    connectTimeoutMS: CONNECT_TIMEOUT_MS,
    serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
    // A discovery scan only reads a sample; never let it wedge a run forever.
    socketTimeoutMS: 30_000,
  });

  try {
    await client.connect();
    const db = client.db(req.database);
    const infos = (await db.listCollections().toArray()).slice(0, MAX_DISCOVERED_TABLES);

    const samples: MongoCollectionSample[] = [];
    for (const info of infos) {
      const name = String((info as { name?: unknown }).name ?? '');
      if (!name) continue;
      const kind = (info as { type?: unknown }).type === 'view' ? 'view' : 'collection';
      try {
        const coll = db.collection(name);
        // $sample gives a spread across the collection; fall back to a plain
        // bounded find when the collection can't be aggregated (e.g. a view).
        let docs: Array<Record<string, unknown>>;
        try {
          docs = await coll.aggregate([{ $sample: { size: sampleSize } }]).toArray() as Array<Record<string, unknown>>;
        } catch {
          docs = await coll.find({}).limit(sampleSize).toArray() as Array<Record<string, unknown>>;
        }
        let estimatedCount: number | undefined;
        try { estimatedCount = await coll.estimatedDocumentCount(); }
        catch { estimatedCount = undefined; }
        samples.push({ name, kind, docs, estimatedCount });
      } catch {
        // One unreadable collection must not fail the whole scan — surface it
        // as an asset with no inferred fields, exactly as an empty sample would.
        samples.push({ name, kind, docs: [] });
      }
    }
    return inferMongoAssets(samples);
  } finally {
    await client.close().catch(() => { /* best-effort close */ });
  }
}
