/**
 * Deterministic JSON, byte-identical to `@invokable/core`'s implementation.
 *
 * Duplicated rather than imported: the server must not depend on the client
 * package, and the two are pinned together by the shared test in
 * `test/canonical-parity.test.ts`. If they ever diverge, every approval issued
 * by one and verified by the other looks stale — so the parity test is the
 * thing that keeps this honest.
 */
export function stableStringify(value: unknown): string {
  return serialise(value);
}

function serialise(value: unknown): string {
  if (value === null) return 'null';

  const type = typeof value;
  if (type === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new TypeError(`Cannot canonicalise non-finite number: ${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (type === 'string' || type === 'boolean') return JSON.stringify(value);
  if (type === 'undefined' || type === 'function' || type === 'symbol') {
    throw new TypeError(`Cannot canonicalise value of type ${type}`);
  }
  if (type === 'bigint') return JSON.stringify((value as bigint).toString());

  if (Array.isArray(value)) {
    return '[' + value.map((v) => serialise(v === undefined ? null : v)).join(',') + ']';
  }

  if (value instanceof Date) return JSON.stringify(value.toISOString());

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return '{' + keys.map((k) => `${JSON.stringify(k)}:${serialise(obj[k])}`).join(',') + '}';
}
