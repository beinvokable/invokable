import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryStore, type AuthStore } from '../src/store.js';
import { memoryCheckpointStore, type CheckpointStore } from '../src/checkpoints.js';
import {
  createSchema,
  postgresAuthStore,
  postgresCheckpointStore,
  purgeExpired,
} from '../src/postgres-store.js';
import type { SqlExecutor } from '../src/sql.js';

/**
 * One behavioural suite, run against every store implementation.
 *
 * The handlers are written against the interface, so a Postgres store that
 * differs from the memory store in any observable way is a bug that would only
 * surface in production. Running the identical assertions against both is what
 * makes swapping them safe.
 *
 * The SQL is exercised against real Postgres (PGlite, compiled to WASM), not a
 * mock — a fake would not catch a syntax error, a wrong column, or a predicate
 * that quietly matches nothing.
 */

const pg = new PGlite();
const exec: SqlExecutor = {
  async query(text, params) {
    const result = await pg.query(text, params ? [...params] : undefined);
    return { rows: result.rows as never[] };
  },
};

beforeAll(async () => {
  await createSchema(exec);
});
afterAll(async () => {
  await pg.close();
});

interface Implementation {
  name: string;
  auth: () => AuthStore;
  checkpoints: () => CheckpointStore;
  /** Postgres shares one database, so keys are namespaced per test run. */
  key: (s: string) => string;
}

let counter = 0;
const implementations: Implementation[] = [
  {
    name: 'memory',
    auth: () => memoryStore(),
    checkpoints: () => memoryCheckpointStore(),
    key: (s) => s,
  },
  {
    name: 'postgres',
    auth: () => postgresAuthStore({ exec }),
    checkpoints: () => postgresCheckpointStore({ exec }),
    key: (s) => `${s}-${++counter}`,
  },
];

function device(k: (s: string) => string, over: Partial<Parameters<AuthStore['createDevice']>[0]> = {}) {
  const id = k('dc');
  return {
    deviceCode: id,
    userCode: k('CODE').toUpperCase(),
    state: 'pending' as const,
    clientName: 'demo-tool',
    hostname: 'laptop',
    toolVersion: '1.0.0',
    createdAt: 1_700_000_000_000,
    expiresAt: 1_700_000_900_000,
    ...over,
  };
}

for (const impl of implementations) {
  describe(`${impl.name} store: devices`, () => {
    it('round-trips a device', async () => {
      const store = impl.auth();
      const rec = device(impl.key);
      await store.createDevice(rec);

      expect(await store.findDeviceByDeviceCode(rec.deviceCode)).toEqual(rec);
      expect(await store.findDeviceByUserCode(rec.userCode)).toEqual(rec);
    });

    it('returns null for an unknown device', async () => {
      const store = impl.auth();
      expect(await store.findDeviceByDeviceCode('nope')).toBeNull();
      expect(await store.findDeviceByUserCode('NOPE')).toBeNull();
    });

    it('applies a partial update without clobbering other fields', async () => {
      const store = impl.auth();
      const rec = device(impl.key);
      await store.createDevice(rec);

      await store.updateDevice(rec.deviceCode, { state: 'approved', subject: 'ida@example.com' });

      const found = await store.findDeviceByDeviceCode(rec.deviceCode);
      expect(found).toMatchObject({
        state: 'approved',
        subject: 'ida@example.com',
        clientName: 'demo-tool',
        hostname: 'laptop',
        createdAt: rec.createdAt,
      });
    });

    it('records the poll timestamp', async () => {
      const store = impl.auth();
      const rec = device(impl.key);
      await store.createDevice(rec);

      await store.updateDevice(rec.deviceCode, { lastPolledAt: 1_700_000_005_000 });
      expect((await store.findDeviceByDeviceCode(rec.deviceCode))?.lastPolledAt).toBe(
        1_700_000_005_000,
      );
    });

    it('ignores an update for a device that does not exist', async () => {
      const store = impl.auth();
      await expect(store.updateDevice('missing', { state: 'approved' })).resolves.toBeUndefined();
    });
  });

  describe(`${impl.name} store: tokens`, () => {
    const token = (k: (s: string) => string) => ({
      tokenHash: k('hash'),
      tokenPrefix: 'tst',
      subject: 'ida@example.com',
      orgId: 'org_1',
      clientName: 'demo-tool',
      hostname: 'laptop',
      createdAt: 1_700_000_000_000,
      expiresAt: null,
    });

    it('round-trips a token', async () => {
      const store = impl.auth();
      const rec = token(impl.key);
      await store.createToken(rec);
      expect(await store.findTokenByHash(rec.tokenHash)).toEqual(rec);
    });

    it('keeps a null expiry as null rather than zero', async () => {
      // `expiresAt: null` means long-lived. Coercing it to 0 would make every
      // token read as expired the moment it was issued.
      const store = impl.auth();
      const rec = token(impl.key);
      await store.createToken(rec);
      expect((await store.findTokenByHash(rec.tokenHash))?.expiresAt).toBeNull();
    });

    it('preserves a real expiry', async () => {
      const store = impl.auth();
      const rec = { ...token(impl.key), expiresAt: 1_700_003_600_000 };
      await store.createToken(rec);
      expect((await store.findTokenByHash(rec.tokenHash))?.expiresAt).toBe(1_700_003_600_000);
    });

    it('revokes a token', async () => {
      const store = impl.auth();
      const rec = token(impl.key);
      await store.createToken(rec);

      await store.revokeToken(rec.tokenHash, 1_700_000_100_000);
      expect((await store.findTokenByHash(rec.tokenHash))?.revokedAt).toBe(1_700_000_100_000);
    });

    it('keeps the first revocation time when revoked twice', async () => {
      const store = impl.auth();
      const rec = token(impl.key);
      await store.createToken(rec);

      await store.revokeToken(rec.tokenHash, 1_700_000_100_000);
      await store.revokeToken(rec.tokenHash, 1_700_000_200_000);
      expect((await store.findTokenByHash(rec.tokenHash))?.revokedAt).toBe(1_700_000_100_000);
    });

    it('returns null for an unknown token', async () => {
      expect(await impl.auth().findTokenByHash('nope')).toBeNull();
    });
  });

  describe(`${impl.name} store: checkpoints`, () => {
    const checkpoint = (k: (s: string) => string) => ({
      fingerprint: k('FP').toUpperCase(),
      gate: 'deploy_review',
      subject: 'svc-1',
      summaryHash: 'a'.repeat(64),
      issuedAt: 1_700_000_000_000,
      expiresAt: 1_700_086_400_000,
      consumed: false,
      issuedTo: 'ida@example.com',
    });

    it('round-trips a checkpoint', async () => {
      const store = impl.checkpoints();
      const rec = checkpoint(impl.key);
      await store.createCheckpoint(rec);
      expect(await store.findCheckpoint(rec.fingerprint)).toEqual(rec);
    });

    it('looks up by fingerprint alone, so a mismatch can be diagnosed', async () => {
      const store = impl.checkpoints();
      const rec = checkpoint(impl.key);
      await store.createCheckpoint(rec);

      const found = await store.findCheckpoint(rec.fingerprint);
      expect(found?.gate).toBe('deploy_review');
      expect(found?.subject).toBe('svc-1');
    });

    it('consumes exactly once', async () => {
      const store = impl.checkpoints();
      const rec = checkpoint(impl.key);
      await store.createCheckpoint(rec);

      expect(await store.consumeCheckpoint(rec.fingerprint, 1_700_000_100_000)).toBe(true);
      expect(await store.consumeCheckpoint(rec.fingerprint, 1_700_000_200_000)).toBe(false);
    });

    it('marks when it was consumed', async () => {
      const store = impl.checkpoints();
      const rec = checkpoint(impl.key);
      await store.createCheckpoint(rec);
      await store.consumeCheckpoint(rec.fingerprint, 1_700_000_100_000);

      const found = await store.findCheckpoint(rec.fingerprint);
      expect(found?.consumed).toBe(true);
      expect(found?.consumedAt).toBe(1_700_000_100_000);
    });

    it('refuses to consume an unknown fingerprint', async () => {
      expect(await impl.checkpoints().consumeCheckpoint('NOPE', 1)).toBe(false);
    });

    it('lets only one of several simultaneous consumers win', async () => {
      // The guarantee the whole gate rests on: an approval authorises one
      // action. Concurrency here is bounded by the driver, so this asserts the
      // statement's semantics rather than proving a race under real parallelism
      // — but a SELECT-then-UPDATE implementation fails it outright.
      const store = impl.checkpoints();
      const rec = checkpoint(impl.key);
      await store.createCheckpoint(rec);

      const results = await Promise.all(
        Array.from({ length: 5 }, () => store.consumeCheckpoint(rec.fingerprint, 1_700_000_100_000)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });
}

let purgeCounter = 0;
const purgeKey = (s: string): string => `${s}-purge-${++purgeCounter}`;

describe('postgres housekeeping', () => {
  it('purges expired rows and leaves live ones', async () => {
    const now = 2_000_000_000_000;
    const auth = postgresAuthStore({ exec });
    const checkpoints = postgresCheckpointStore({ exec });

    const stale = device(purgeKey, { expiresAt: now - 48 * 60 * 60 * 1000 });
    const live = device(purgeKey, { expiresAt: now + 60_000 });
    await auth.createDevice(stale);
    await auth.createDevice(live);

    await checkpoints.createCheckpoint({
      fingerprint: `OLD-${Date.now()}`,
      gate: 'g',
      subject: 's',
      summaryHash: 'b'.repeat(64),
      issuedAt: now - 72 * 60 * 60 * 1000,
      expiresAt: now - 48 * 60 * 60 * 1000,
      consumed: true,
    });

    const purged = await purgeExpired(exec, { now });
    expect(purged.devices).toBeGreaterThanOrEqual(1);
    expect(purged.checkpoints).toBeGreaterThanOrEqual(1);

    // Anything still valid must survive.
    expect(await auth.findDeviceByDeviceCode(live.deviceCode)).not.toBeNull();
    expect(await auth.findDeviceByDeviceCode(stale.deviceCode)).toBeNull();
  });
});

