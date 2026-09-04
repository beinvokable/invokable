import { describe, expect, it } from 'vitest';
import { stableStringify as coreStable, summaryHash as coreHash } from '@invokable/core';
import {
  CheckpointVerifier,
  computeFingerprint,
  hashSummary,
  memoryCheckpointStore,
  parseCheckpointHeader,
} from '../src/checkpoints.js';
import { stableStringify as serverStable } from '../src/stable-json.js';

describe('canonical JSON parity between core and server', () => {
  // If these two ever diverge, every approval issued by one and verified by the
  // other looks stale. This test is the only thing preventing that.
  const cases: unknown[] = [
    { b: 1, a: 2 },
    { nested: { z: [1, 2, { y: 'x', a: null }], a: true } },
    [1, 'two', false, null],
    { unicode: 'שלום', emoji: '🚀', quote: '"' },
    { dropped: undefined, kept: 0 },
    { date: new Date('2026-01-01T00:00:00.000Z') },
    'plain string',
    42,
    null,
  ];

  for (const value of cases) {
    it(`serialises ${JSON.stringify(value) ?? 'undefined'} identically`, () => {
      expect(serverStable(value)).toBe(coreStable(value));
    });
  }

  it('is insensitive to key insertion order', () => {
    expect(serverStable({ a: 1, b: 2 })).toBe(serverStable({ b: 2, a: 1 }));
  });

  it('produces the same summary hash on both sides', () => {
    const summary = { env: 'prod', replicas: 3, image: 'app:1.2.3' };
    expect(hashSummary(serverStable(summary))).toBe(coreHash(summary));
  });

  it('refuses non-finite numbers rather than hashing them as null', () => {
    expect(() => serverStable({ n: NaN })).toThrow(/non-finite/);
    expect(() => coreStable({ n: Infinity })).toThrow(/non-finite/);
  });
});

describe('fingerprint', () => {
  const input = { gate: 'deploy', subject: 'svc-1', summaryHash: 'a'.repeat(64), issuedAt: 1_700_000_000_000 };

  it('is 16 base32 characters', () => {
    expect(computeFingerprint('s3cret', input)).toMatch(/^[A-Z2-7]{16}$/);
  });

  it('is deterministic for the same inputs', () => {
    expect(computeFingerprint('s3cret', input)).toBe(computeFingerprint('s3cret', input));
  });

  it('cannot be computed without the secret', () => {
    expect(computeFingerprint('s3cret', input)).not.toBe(computeFingerprint('other', input));
  });

  it('changes when any bound field changes', () => {
    const base = computeFingerprint('s3cret', input);
    expect(computeFingerprint('s3cret', { ...input, gate: 'other' })).not.toBe(base);
    expect(computeFingerprint('s3cret', { ...input, subject: 'svc-2' })).not.toBe(base);
    expect(computeFingerprint('s3cret', { ...input, summaryHash: 'b'.repeat(64) })).not.toBe(base);
    expect(computeFingerprint('s3cret', { ...input, issuedAt: input.issuedAt + 1 })).not.toBe(base);
  });
});

describe('CheckpointVerifier', () => {
  function make(opts: { now?: () => number; previousSecret?: string; secret?: string } = {}) {
    const store = memoryCheckpointStore();
    const verifier = new CheckpointVerifier({
      secret: opts.secret ?? 'secret-one',
      ...(opts.previousSecret !== undefined ? { previousSecret: opts.previousSecret } : {}),
      store,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
    return { store, verifier };
  }

  const plan = { env: 'prod', replicas: 3 };

  it('issues then verifies a fingerprint', async () => {
    const { verifier } = make();
    const rec = await verifier.issue({
      gate: 'deploy',
      subject: 'svc-1',
      summaryHash: hashSummary(serverStable(plan)),
    });

    const result = await verifier.verify({
      gate: 'deploy',
      subject: 'svc-1',
      fingerprint: rec.fingerprint,
    });
    expect(result.ok).toBe(true);
  });

  it('names a gate or subject mismatch instead of calling it unknown', async () => {
    // These are wiring mistakes — the `subject` passed to checkpoint() not
    // matching what `subjectFor` returns. Reporting them as "no such
    // fingerprint" sends the integrator hunting for a forgery that isn't there.
    const { verifier } = make();
    const rec = await verifier.issue({
      gate: 'deploy',
      subject: 'svc-1',
      summaryHash: hashSummary(serverStable(plan)),
    });

    const wrongGate = await verifier.verify({
      gate: 'destroy',
      subject: 'svc-1',
      fingerprint: rec.fingerprint,
    });
    expect(wrongGate).toMatchObject({ ok: false, reason: 'gate_mismatch' });
    expect(wrongGate.detail).toContain('deploy');

    const wrongSubject = await verifier.verify({
      gate: 'deploy',
      subject: 'svc-2',
      fingerprint: rec.fingerprint,
    });
    expect(wrongSubject).toMatchObject({ ok: false, reason: 'subject_mismatch' });
    expect(wrongSubject.detail).toContain('subjectFor');
  });

  it('still reports a genuinely unknown fingerprint as not_found', async () => {
    const { verifier } = make();
    const result = await verifier.verify({
      gate: 'deploy',
      subject: 'svc-1',
      fingerprint: 'ZZZZZZZZZZZZZZZZ',
    });
    expect(result).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('rejects a fabricated fingerprint', async () => {
    const { verifier } = make();
    await verifier.issue({ gate: 'deploy', subject: 'svc-1', summaryHash: hashSummary(serverStable(plan)) });

    const result = await verifier.verify({
      gate: 'deploy',
      subject: 'svc-1',
      fingerprint: 'AAAAAAAAAAAAAAAA',
    });
    expect(result.ok).toBe(false);
  });

  it('reports a changed plan as stale, not as valid', async () => {
    const { verifier } = make();
    const rec = await verifier.issue({
      gate: 'deploy',
      subject: 'svc-1',
      summaryHash: hashSummary(serverStable(plan)),
    });

    const changed = hashSummary(serverStable({ ...plan, replicas: 300 }));
    const result = await verifier.verify({
      gate: 'deploy',
      subject: 'svc-1',
      fingerprint: rec.fingerprint,
      expectedSummaryHash: changed,
    });
    expect(result).toMatchObject({ ok: false, reason: 'mismatch' });
  });

  it('consumes an approval exactly once', async () => {
    const { verifier } = make();
    const rec = await verifier.issue({
      gate: 'deploy',
      subject: 'svc-1',
      summaryHash: hashSummary(serverStable(plan)),
    });

    expect((await verifier.consume({ gate: 'deploy', subject: 'svc-1', fingerprint: rec.fingerprint })).ok).toBe(true);
    const second = await verifier.consume({ gate: 'deploy', subject: 'svc-1', fingerprint: rec.fingerprint });
    expect(second).toMatchObject({ ok: false, reason: 'consumed' });
  });

  it('expires an approval after its TTL', async () => {
    let clock = 1_000_000;
    const store = memoryCheckpointStore();
    const verifier = new CheckpointVerifier({ secret: 's', store, ttlMs: 1000, now: () => clock });

    const rec = await verifier.issue({ gate: 'deploy', subject: 'svc-1', summaryHash: 'h' });
    clock += 1001;

    expect(await verifier.verify({ gate: 'deploy', subject: 'svc-1', fingerprint: rec.fingerprint })).toMatchObject({
      ok: false,
      reason: 'expired',
    });
  });

  it('still accepts a fingerprint issued under the previous secret', async () => {
    // Rotation: a fingerprint minted before the swap must keep working.
    const store = memoryCheckpointStore();
    const old = new CheckpointVerifier({ secret: 'old-secret', store });
    const rec = await old.issue({ gate: 'deploy', subject: 'svc-1', summaryHash: 'h' });

    const rotated = new CheckpointVerifier({
      secret: 'new-secret',
      previousSecret: 'old-secret',
      store,
    });
    expect((await rotated.verify({ gate: 'deploy', subject: 'svc-1', fingerprint: rec.fingerprint })).ok).toBe(true);

    const withoutPrevious = new CheckpointVerifier({ secret: 'new-secret', store });
    expect((await withoutPrevious.verify({ gate: 'deploy', subject: 'svc-1', fingerprint: rec.fingerprint })).ok).toBe(false);
  });
});

describe('parseCheckpointHeader', () => {
  it('splits gate@fingerprint', () => {
    expect(parseCheckpointHeader('deploy_review@ABCD1234ABCD1234')).toEqual({
      gate: 'deploy_review',
      fingerprint: 'ABCD1234ABCD1234',
    });
  });

  it('rejects malformed values', () => {
    for (const bad of [null, '', 'nofingerprint', '@fp', 'gate@']) {
      expect(parseCheckpointHeader(bad)).toBeNull();
    }
  });
});
