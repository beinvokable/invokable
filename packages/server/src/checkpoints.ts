import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Server-issued checkpoint fingerprints (spec 5.8).
 *
 * The fingerprint is an HMAC, not a hash of the summary, so it cannot be
 * computed by anyone who merely saw the summary — including the agent. What it
 * buys is freshness (an approval cannot outlive the state it described) and
 * single use (an approval cannot be replayed). It does not contain a hostile
 * agent: see the security note in the package README.
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export interface FingerprintInput {
  gate: string;
  subject: string;
  summaryHash: string;
  issuedAt: number;
}

/**
 * 16 base32 characters = 80 bits. Sufficient because a fingerprint is scoped to
 * (gate, subject), is consumed once, and expires — it is not a bearer secret.
 */
export function computeFingerprint(secret: string, input: FingerprintInput): string {
  const mac = createHmac('sha256', secret)
    .update(`${input.gate}|${input.subject}|${input.summaryHash}|${input.issuedAt}`, 'utf8')
    .digest();
  return base32(mac).slice(0, 16);
}

export function hashSummary(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface CheckpointRecord {
  fingerprint: string;
  gate: string;
  subject: string;
  summaryHash: string;
  issuedAt: number;
  expiresAt: number;
  consumed: boolean;
  consumedAt?: number;
  /** Whoever the token belonged to when the checkpoint was issued. */
  issuedTo?: string;
}

export interface CheckpointStore {
  createCheckpoint(record: CheckpointRecord): Promise<void>;
  /**
   * Looks up by fingerprint alone. The gate and subject are compared by the
   * verifier rather than folded into the query, so that an approval issued for
   * a different target can be reported as such instead of as "unknown".
   */
  findCheckpoint(fingerprint: string): Promise<CheckpointRecord | null>;
  consumeCheckpoint(fingerprint: string, at: number): Promise<boolean>;
}

export function memoryCheckpointStore(): CheckpointStore & {
  _records: Map<string, CheckpointRecord>;
} {
  const records = new Map<string, CheckpointRecord>();
  return {
    _records: records,
    async createCheckpoint(record) {
      records.set(record.fingerprint, record);
    },
    async findCheckpoint(fingerprint) {
      return records.get(fingerprint) ?? null;
    },
    async consumeCheckpoint(fingerprint, at) {
      const found = records.get(fingerprint);
      // Consumption must be atomic: two concurrent requests carrying the same
      // fingerprint must not both succeed. A real store does this with a
      // conditional update; the Map is single-threaded, so the check suffices.
      if (!found || found.consumed) return false;
      records.set(fingerprint, { ...found, consumed: true, consumedAt: at });
      return true;
    },
  };
}

export type CheckpointFailure =
  | 'not_found'
  | 'gate_mismatch'
  | 'subject_mismatch'
  | 'mismatch'
  | 'expired'
  | 'consumed';

export interface VerifyResult {
  ok: boolean;
  reason?: CheckpointFailure;
  record?: CheckpointRecord;
  /** Extra context for a mismatch, safe to show a developer. */
  detail?: string;
}

export interface CheckpointVerifierOptions {
  secret: string;
  /** Honoured for 24h after rotation, so in-flight approvals keep working. */
  previousSecret?: string;
  store: CheckpointStore;
  /** Default 24 hours (spec 5.8). */
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class CheckpointVerifier {
  private readonly secret: string;
  private readonly previousSecret: string | undefined;
  private readonly store: CheckpointStore;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: CheckpointVerifierOptions) {
    if (!options.secret) {
      throw new TypeError('CheckpointVerifier requires a secret.');
    }
    this.secret = options.secret;
    this.previousSecret = options.previousSecret;
    this.store = options.store;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  async issue(input: {
    gate: string;
    subject: string;
    summaryHash: string;
    issuedTo?: string;
  }): Promise<CheckpointRecord> {
    const issuedAt = this.now();
    const fingerprint = computeFingerprint(this.secret, {
      gate: input.gate,
      subject: input.subject,
      summaryHash: input.summaryHash,
      issuedAt,
    });

    const record: CheckpointRecord = {
      fingerprint,
      gate: input.gate,
      subject: input.subject,
      summaryHash: input.summaryHash,
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
      consumed: false,
      ...(input.issuedTo !== undefined ? { issuedTo: input.issuedTo } : {}),
    };
    await this.store.createCheckpoint(record);
    return record;
  }

  /**
   * Steps 1-3 of spec 5.8: the record exists, the MAC still recomputes from
   * stored state, and it is neither expired nor already consumed.
   *
   * `expectedSummaryHash` is the caller's view of current state. Supplying it
   * is what makes an approval *stale* when the plan changed underneath.
   */
  async verify(input: {
    gate: string;
    subject: string;
    fingerprint: string;
    expectedSummaryHash?: string;
  }): Promise<VerifyResult> {
    const record = await this.store.findCheckpoint(input.fingerprint);
    if (!record) return { ok: false, reason: 'not_found' };

    // Reported separately from "not found". A gate or subject that disagrees
    // between the CLI and the middleware is a wiring mistake, and calling it an
    // unknown fingerprint sends the integrator looking in the wrong place.
    if (record.gate !== input.gate) {
      return {
        ok: false,
        reason: 'gate_mismatch',
        record,
        detail: `issued for gate "${record.gate}", presented for "${input.gate}"`,
      };
    }
    if (record.subject !== input.subject) {
      return {
        ok: false,
        reason: 'subject_mismatch',
        record,
        detail:
          `issued for subject ${JSON.stringify(record.subject)}, presented for ` +
          `${JSON.stringify(input.subject)} — the \`subject\` passed to checkpoint() must ` +
          'equal what `subjectFor` returns in verifyCheckpoint()',
      };
    }

    const recomputes = [this.secret, this.previousSecret]
      .filter((s): s is string => Boolean(s))
      .some((secret) =>
        constantTimeEqual(
          computeFingerprint(secret, {
            gate: record.gate,
            subject: record.subject,
            summaryHash: record.summaryHash,
            issuedAt: record.issuedAt,
          }),
          input.fingerprint,
        ),
      );
    if (!recomputes) return { ok: false, reason: 'mismatch', record };

    if (
      input.expectedSummaryHash !== undefined &&
      !constantTimeEqual(record.summaryHash, input.expectedSummaryHash)
    ) {
      return { ok: false, reason: 'mismatch', record };
    }

    if (record.expiresAt <= this.now()) return { ok: false, reason: 'expired', record };
    if (record.consumed) return { ok: false, reason: 'consumed', record };

    return { ok: true, record };
  }

  /** Step 4: verify, then burn. Returns false if it could not be consumed. */
  async consume(input: {
    gate: string;
    subject: string;
    fingerprint: string;
    expectedSummaryHash?: string;
  }): Promise<VerifyResult> {
    const result = await this.verify(input);
    if (!result.ok) return result;
    const consumed = await this.store.consumeCheckpoint(input.fingerprint, this.now());
    if (!consumed) return { ok: false, reason: 'consumed', ...(result.record ? { record: result.record } : {}) };
    return result;
  }
}

export function parseCheckpointHeader(
  value: string | null,
): { gate: string; fingerprint: string } | null {
  if (!value) return null;
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return null;
  return { gate: value.slice(0, at), fingerprint: value.slice(at + 1) };
}
