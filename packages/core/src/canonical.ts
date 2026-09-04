import { createHash } from 'node:crypto';

/**
 * Deterministic JSON: object keys sorted, no insignificant whitespace.
 *
 * The fingerprint is an HMAC over this string, computed independently by the
 * client (when summarising) and the server (when verifying). If the two sides
 * serialise the same value differently — key order, spacing — every approval
 * looks stale. Sorting is what makes the comparison meaningful.
 */
export function stableStringify(value: unknown): string {
  return serialise(value);
}

function serialise(value: unknown): string {
  if (value === null) return 'null';

  const type = typeof value;
  if (type === 'number') {
    // NaN and ±Infinity have no JSON representation; JSON.stringify emits
    // `null` for them, so a summary containing one would silently compare equal
    // to a summary containing another. Reject rather than hash a lie.
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
  return (
    '{' + keys.map((k) => `${JSON.stringify(k)}:${serialise(obj[k])}`).join(',') + '}'
  );
}

export function summaryHash(summary: unknown): string {
  return createHash('sha256').update(stableStringify(summary), 'utf8').digest('hex');
}
