import type { AuthStore, DeviceRecord, DeviceState, TokenRecord } from './store.js';
import type { CheckpointRecord, CheckpointStore } from './checkpoints.js';
import {
  createSchema,
  toNumber,
  toOptionalNumber,
  toOptionalString,
  type SqlExecutor,
} from './sql.js';

interface DeviceRow {
  device_code: string;
  user_code: string;
  state: string;
  client_name: string;
  hostname: string;
  tool_version: string;
  created_at: unknown;
  expires_at: unknown;
  subject: string | null;
  org_id: string | null;
  last_polled_at: unknown;
}

interface TokenRow {
  token_hash: string;
  token_prefix: string;
  subject: string;
  org_id: string | null;
  client_name: string;
  hostname: string;
  created_at: unknown;
  expires_at: unknown;
  revoked_at: unknown;
}

interface CheckpointRow {
  fingerprint: string;
  gate: string;
  subject: string;
  summary_hash: string;
  issued_at: unknown;
  expires_at: unknown;
  consumed: boolean;
  consumed_at: unknown;
  issued_to: string | null;
}

function toDevice(row: DeviceRow): DeviceRecord {
  const record: DeviceRecord = {
    deviceCode: row.device_code,
    userCode: row.user_code,
    state: row.state as DeviceState,
    clientName: row.client_name,
    hostname: row.hostname,
    toolVersion: row.tool_version,
    createdAt: toNumber(row.created_at),
    expiresAt: toNumber(row.expires_at),
  };
  const subject = toOptionalString(row.subject);
  const orgId = toOptionalString(row.org_id);
  const lastPolledAt = toOptionalNumber(row.last_polled_at);
  if (subject !== undefined) record.subject = subject;
  if (orgId !== undefined) record.orgId = orgId;
  if (lastPolledAt !== undefined) record.lastPolledAt = lastPolledAt;
  return record;
}

function toToken(row: TokenRow): TokenRecord {
  const record: TokenRecord = {
    tokenHash: row.token_hash,
    tokenPrefix: row.token_prefix,
    subject: row.subject,
    clientName: row.client_name,
    hostname: row.hostname,
    createdAt: toNumber(row.created_at),
    expiresAt: row.expires_at === null || row.expires_at === undefined ? null : toNumber(row.expires_at),
  };
  const orgId = toOptionalString(row.org_id);
  const revokedAt = toOptionalNumber(row.revoked_at);
  if (orgId !== undefined) record.orgId = orgId;
  if (revokedAt !== undefined) record.revokedAt = revokedAt;
  return record;
}

function toCheckpoint(row: CheckpointRow): CheckpointRecord {
  const record: CheckpointRecord = {
    fingerprint: row.fingerprint,
    gate: row.gate,
    subject: row.subject,
    summaryHash: row.summary_hash,
    issuedAt: toNumber(row.issued_at),
    expiresAt: toNumber(row.expires_at),
    consumed: Boolean(row.consumed),
  };
  const consumedAt = toOptionalNumber(row.consumed_at);
  const issuedTo = toOptionalString(row.issued_to);
  if (consumedAt !== undefined) record.consumedAt = consumedAt;
  if (issuedTo !== undefined) record.issuedTo = issuedTo;
  return record;
}

/** Column name for each patchable device field, for the partial UPDATE. */
const DEVICE_COLUMNS: Record<keyof DeviceRecord, string> = {
  deviceCode: 'device_code',
  userCode: 'user_code',
  state: 'state',
  clientName: 'client_name',
  hostname: 'hostname',
  toolVersion: 'tool_version',
  createdAt: 'created_at',
  expiresAt: 'expires_at',
  subject: 'subject',
  orgId: 'org_id',
  lastPolledAt: 'last_polled_at',
};

export interface PostgresStoreOptions {
  exec: SqlExecutor;
}

export interface PurgeResult {
  devices: number;
  checkpoints: number;
}

/**
 * Durable auth store.
 *
 * Required anywhere the process is not the only one holding state: a restart,
 * a second instance behind a load balancer, or a serverless platform where
 * every request may reach a fresh worker. With the in-memory store, a login
 * started on one instance and polled on another simply never completes.
 */
export function postgresAuthStore(options: PostgresStoreOptions): AuthStore {
  const { exec } = options;

  return {
    async createDevice(record) {
      await exec.query(
        `INSERT INTO invokable_devices
           (device_code, user_code, state, client_name, hostname, tool_version,
            created_at, expires_at, subject, org_id, last_polled_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          record.deviceCode,
          record.userCode,
          record.state,
          record.clientName,
          record.hostname,
          record.toolVersion,
          record.createdAt,
          record.expiresAt,
          record.subject ?? null,
          record.orgId ?? null,
          record.lastPolledAt ?? null,
        ],
      );
    },

    async findDeviceByDeviceCode(deviceCode) {
      const { rows } = await exec.query<DeviceRow>(
        'SELECT * FROM invokable_devices WHERE device_code = $1',
        [deviceCode],
      );
      return rows[0] ? toDevice(rows[0]) : null;
    },

    async findDeviceByUserCode(userCode) {
      // Newest first: an expired code may linger until the sweeper runs, and the
      // live one is the one a person is looking at.
      const { rows } = await exec.query<DeviceRow>(
        'SELECT * FROM invokable_devices WHERE user_code = $1 ORDER BY created_at DESC LIMIT 1',
        [userCode],
      );
      return rows[0] ? toDevice(rows[0]) : null;
    },

    async updateDevice(deviceCode, patch) {
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [key, value] of Object.entries(patch)) {
        const column = DEVICE_COLUMNS[key as keyof DeviceRecord];
        if (!column) continue;
        params.push(value ?? null);
        sets.push(`${column} = $${params.length}`);
      }
      if (sets.length === 0) return;
      params.push(deviceCode);
      await exec.query(
        `UPDATE invokable_devices SET ${sets.join(', ')} WHERE device_code = $${params.length}`,
        params,
      );
    },

    async createToken(record) {
      await exec.query(
        `INSERT INTO invokable_tokens
           (token_hash, token_prefix, subject, org_id, client_name, hostname,
            created_at, expires_at, revoked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          record.tokenHash,
          record.tokenPrefix,
          record.subject,
          record.orgId ?? null,
          record.clientName,
          record.hostname,
          record.createdAt,
          record.expiresAt,
          record.revokedAt ?? null,
        ],
      );
    },

    async findTokenByHash(tokenHash) {
      const { rows } = await exec.query<TokenRow>(
        'SELECT * FROM invokable_tokens WHERE token_hash = $1',
        [tokenHash],
      );
      return rows[0] ? toToken(rows[0]) : null;
    },

    async revokeToken(tokenHash, at) {
      await exec.query(
        'UPDATE invokable_tokens SET revoked_at = $1 WHERE token_hash = $2 AND revoked_at IS NULL',
        [at, tokenHash],
      );
    },
  };
}

/** Durable checkpoint store. See `consumeCheckpoint` for the part that matters. */
export function postgresCheckpointStore(options: PostgresStoreOptions): CheckpointStore {
  const { exec } = options;

  return {
    async createCheckpoint(record) {
      await exec.query(
        `INSERT INTO invokable_checkpoints
           (fingerprint, gate, subject, summary_hash, issued_at, expires_at,
            consumed, consumed_at, issued_to)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          record.fingerprint,
          record.gate,
          record.subject,
          record.summaryHash,
          record.issuedAt,
          record.expiresAt,
          record.consumed,
          record.consumedAt ?? null,
          record.issuedTo ?? null,
        ],
      );
    },

    async findCheckpoint(fingerprint) {
      const { rows } = await exec.query<CheckpointRow>(
        'SELECT * FROM invokable_checkpoints WHERE fingerprint = $1',
        [fingerprint],
      );
      return rows[0] ? toCheckpoint(rows[0]) : null;
    },

    /**
     * One statement, not a read followed by a write.
     *
     * `WHERE consumed = FALSE` makes the database the arbiter: of two concurrent
     * requests carrying the same approval, exactly one UPDATE matches a row and
     * the other returns nothing. A SELECT-then-UPDATE would let both pass and
     * bill the user twice for one approval — the precise thing the gate exists
     * to prevent. The in-memory store gets away without this only because a
     * single Node process cannot interleave.
     */
    async consumeCheckpoint(fingerprint, at) {
      const { rows } = await exec.query<{ fingerprint: string }>(
        `UPDATE invokable_checkpoints
            SET consumed = TRUE, consumed_at = $2
          WHERE fingerprint = $1 AND consumed = FALSE
          RETURNING fingerprint`,
        [fingerprint, at],
      );
      return rows.length === 1;
    },
  };
}

/**
 * Deletes rows that can no longer be used. Nothing depends on this for
 * correctness — expiry is enforced on read — but without it the tables grow
 * forever. Run it from a scheduled job.
 */
export async function purgeExpired(
  exec: SqlExecutor,
  options: { now?: number; graceMs?: number } = {},
): Promise<PurgeResult> {
  const now = options.now ?? Date.now();
  // Kept past expiry so a recently expired approval can still be explained to
  // whoever asks why it was refused.
  const cutoff = now - (options.graceMs ?? 24 * 60 * 60 * 1000);

  const devices = await exec.query<{ device_code: string }>(
    'DELETE FROM invokable_devices WHERE expires_at < $1 RETURNING device_code',
    [cutoff],
  );
  const checkpoints = await exec.query<{ fingerprint: string }>(
    'DELETE FROM invokable_checkpoints WHERE expires_at < $1 RETURNING fingerprint',
    [cutoff],
  );

  return { devices: devices.rows.length, checkpoints: checkpoints.rows.length };
}

export { createSchema };
export type { SqlExecutor };
