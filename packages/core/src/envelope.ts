import type { ExitName } from './exit-codes.js';

/**
 * The output contract (spec 5.2). This shape is fixed and is NOT extensible by
 * the tool author — an agent must be able to parse any invokable tool with the
 * same code path.
 *
 * Exactly one JSON document is written to stdout in `--json` mode. Everything
 * else (progress, logs, warnings) goes to stderr.
 */

export const CHECKPOINT_SCHEMA = 'invokable.checkpoint/v1' as const;

export interface OkEnvelope<T = unknown> {
  status: 'ok';
  data: T;
}

export interface ErrorEnvelope {
  status: 'error';
  /** Reserved exit name, or a tool-defined slug for custom codes. */
  code: string;
  message: string;
  /** The literal next command the agent should run. Omitted when none applies. */
  remediation?: string;
  /** Whether an automatic retry is meaningful. Agents must honour `false`. */
  retryable: boolean;
}

export interface SpendInfo {
  estimated: number;
  balance?: number;
  currency?: string;
}

export interface CheckpointChoice {
  id: string;
  label: string;
  detail?: string;
  recommended?: boolean;
}

/**
 * A pending approval gate — the third top-level status.
 *
 * Spec 5.2 originally described this as `status: "ok"` with the payload under
 * `data`, alongside exit 10. That made `status` and the exit code disagree: an
 * agent reading `status` saw success while one reading the exit code saw a
 * non-zero result, and harnesses that treat any non-zero exit as failure would
 * turn an approval prompt into a spurious error. `status: "checkpoint"` makes
 * the two agree. See docs/adr/0003-open-questions-from-spec.md.
 *
 * Fields are flat, matching ErrorEnvelope rather than nesting under `data`.
 */
export interface CheckpointEnvelope {
  status: 'checkpoint';
  schema: typeof CHECKPOINT_SCHEMA;
  gate: string;
  fingerprint: string;
  /** Pre-rendered ASCII panel, safe to print verbatim to a human. */
  display: string;
  question: string;
  explain?: string;
  spend?: SpendInfo;
  choices?: CheckpointChoice[];
  next: {
    approve: string;
    reject?: string;
  };
}

export type Envelope<T = unknown> = OkEnvelope<T> | ErrorEnvelope | CheckpointEnvelope;

export function ok<T>(data: T): OkEnvelope<T> {
  return { status: 'ok', data };
}

export function errorEnvelope(input: {
  code: ExitName | (string & {});
  message: string;
  remediation?: string | undefined;
  retryable?: boolean;
}): ErrorEnvelope {
  const env: ErrorEnvelope = {
    status: 'error',
    code: input.code,
    message: input.message,
    retryable: input.retryable ?? false,
  };
  if (input.remediation !== undefined) env.remediation = input.remediation;
  return env;
}

export function isCheckpointEnvelope(env: Envelope): env is CheckpointEnvelope {
  return env.status === 'checkpoint' && env.schema === CHECKPOINT_SCHEMA;
}

/**
 * Serialise an envelope as the single stdout document.
 *
 * Always compact: agents parse it, humans read the stderr panel. A trailing
 * newline is included so line-buffered readers see a complete record.
 */
export function serializeEnvelope(env: Envelope): string {
  return JSON.stringify(env) + '\n';
}
