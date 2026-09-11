// Flatten a semi-structured value (a JSON row or a MongoDB document) into
// dotted leaf paths, so a catalog column list reflects a document's real
// nested shape — `{ address: { city, zip } }` becomes `address.city`,
// `address.zip` instead of a single opaque `address` blob.
//
// Scope (deliberate): nested PLAIN objects flatten into dotted paths; arrays
// and non-plain objects (Date, and BSON wrappers like ObjectId / Decimal128)
// are LEAVES at their own path — an array is catalogued as one column, not one
// per element. Descending into array elements would produce many values per
// (row, column), which breaks the one-value-per-row contract the data-quality
// reader relies on; element-level flattening is a separate future step.
//
// Pure and dependency-free (BSON wrappers are duck-typed by prototype), so it
// unit-tests without a driver and is shared by the local-file connector and
// the Mongo introspection.

/** Guard against pathological nesting / cycles. Combined with the caller's
 *  column cap, this bounds the work a single document can trigger. */
export const MAX_FLATTEN_DEPTH = 12;

/**
 * True for a `{}` object we should descend into. Arrays, `null`, primitives,
 * `Date`, and class instances (a BSON ObjectId / Decimal128 / Long, a RegExp)
 * are leaves — only a plain object literal (or a null-prototype object) flattens.
 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  // A BSON wrapper (ObjectId, Decimal128, Long, …) is a leaf, never descended.
  // Its instances carry a `_bsontype` tag; checking it — rather than only the
  // prototype — also treats a serialized/plain-object form as a leaf, matching
  // how mongoFieldType identifies these values.
  if (typeof (v as { _bsontype?: unknown })._bsontype === 'string') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Visit every leaf of `value`, calling `visit(path, leaf)` with the dotted path
 * and the leaf value. A non-empty plain object recurses; an empty plain object
 * is itself a leaf (so a column like `metadata` still appears when it's `{}`).
 * The top-level value is walked field-by-field — a bare primitive/array at the
 * root yields nothing (there's no field name to give it), matching how a row
 * without object shape carries no columns.
 */
export function walkLeafPaths(
  value: unknown,
  visit: (path: string, leaf: unknown) => void,
  prefix = '',
  depth = 0,
): void {
  if (depth < MAX_FLATTEN_DEPTH && isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      if (prefix) visit(prefix, value); // an empty {} is a leaf, but only if named
      return;
    }
    for (const key of keys) {
      walkLeafPaths(value[key], visit, prefix ? `${prefix}.${key}` : key, depth + 1);
    }
    return;
  }
  if (prefix) visit(prefix, value);
}

/** Collect the dotted leaf-path names of one object (order preserved). */
export function leafPaths(value: unknown): string[] {
  const out: string[] = [];
  walkLeafPaths(value, (path) => out.push(path));
  return out;
}

/**
 * Resolve a dotted path to its value on one object, descending only through
 * plain objects (so a path can't accidentally index into an array or a BSON
 * wrapper). Returns `undefined` when any segment is missing or non-object. A
 * path with no dots is a plain key lookup, so existing top-level callers are
 * unaffected.
 */
export function resolveLeafPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const part of path.split('.')) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}
