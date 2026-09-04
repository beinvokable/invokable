/**
 * The database seam.
 *
 * Deliberately not a driver. Any client with a `query(text, params)` that
 * returns `{ rows }` satisfies this — `pg`, `postgres.js`,
 * `@neondatabase/serverless`, PGlite. That keeps `@invokable/server` free of a
 * database dependency, and lets the same store run on a serverless platform
 * (where an HTTP driver avoids exhausting connections) and on a plain server.
 */
export interface SqlExecutor {
  query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

/**
 * Timestamps are stored as epoch milliseconds in `bigint` rather than
 * `timestamptz`, because the record types are `number` and a round trip through
 * a date type loses the exact value the fingerprint was signed over.
 */
/**
 * Each statement separately, not one blob.
 *
 * A multi-statement string only works over the simple query protocol. Drivers
 * that use the extended protocol — PGlite, and HTTP drivers such as Neon's
 * serverless client — reject it with "cannot insert multiple commands into a
 * prepared statement", which is exactly the setup this store exists for.
 *
 * Timestamps are epoch milliseconds in `bigint` rather than `timestamptz`,
 * because the record types are `number` and a round trip through a date type
 * loses the exact value the fingerprint was signed over.
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS invokable_devices (
    device_code    TEXT PRIMARY KEY,
    user_code      TEXT NOT NULL,
    state          TEXT NOT NULL,
    client_name    TEXT NOT NULL,
    hostname       TEXT NOT NULL,
    tool_version   TEXT NOT NULL,
    created_at     BIGINT NOT NULL,
    expires_at     BIGINT NOT NULL,
    subject        TEXT,
    org_id         TEXT,
    last_polled_at BIGINT
  )`,
  // One pending device per user code: the code is what a human types, and two
  // live devices answering to it would make approval ambiguous.
  `CREATE UNIQUE INDEX IF NOT EXISTS invokable_devices_user_code_pending
     ON invokable_devices (user_code) WHERE state = 'pending'`,
  `CREATE INDEX IF NOT EXISTS invokable_devices_user_code ON invokable_devices (user_code)`,
  `CREATE INDEX IF NOT EXISTS invokable_devices_expires_at ON invokable_devices (expires_at)`,

  `CREATE TABLE IF NOT EXISTS invokable_tokens (
    token_hash   TEXT PRIMARY KEY,
    token_prefix TEXT NOT NULL,
    subject      TEXT NOT NULL,
    org_id       TEXT,
    client_name  TEXT NOT NULL,
    hostname     TEXT NOT NULL,
    created_at   BIGINT NOT NULL,
    expires_at   BIGINT,
    revoked_at   BIGINT
  )`,
  `CREATE INDEX IF NOT EXISTS invokable_tokens_subject ON invokable_tokens (subject)`,

  `CREATE TABLE IF NOT EXISTS invokable_checkpoints (
    fingerprint  TEXT PRIMARY KEY,
    gate         TEXT NOT NULL,
    subject      TEXT NOT NULL,
    summary_hash TEXT NOT NULL,
    issued_at    BIGINT NOT NULL,
    expires_at   BIGINT NOT NULL,
    consumed     BOOLEAN NOT NULL DEFAULT FALSE,
    consumed_at  BIGINT,
    issued_to    TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS invokable_checkpoints_expires_at ON invokable_checkpoints (expires_at)`,
];

/** The whole schema as one script, for running by hand with psql. */
export const SCHEMA_SQL = SCHEMA_STATEMENTS.join(';\n\n') + ';\n';

/** Creates the tables if they are absent. Safe to run on every boot. */
export async function createSchema(exec: SqlExecutor): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) {
    await exec.query(statement);
  }
}

/**
 * `bigint` arrives as a string from most drivers, because it can exceed
 * `Number.MAX_SAFE_INTEGER`. Epoch milliseconds cannot, so converting is exact.
 */
export function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : Number(value);
}

export function toOptionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  return toNumber(value);
}

export function toOptionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}
