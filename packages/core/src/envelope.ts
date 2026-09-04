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
 * Carried as the `data` of an OkEnvelope when a gate is hit.
 *
 * NOTE: per spec 5.2 a pending checkpoint is `status: "ok"` on stdout while the
 * process exits 10. The exit code is the authoritative signal that the command
 * did NOT complete; `status` describes only whether the envelope itself is
 * well-formed. See docs/adr/0003-checkpoint-envelope.md.
 */
export interface CheckpointPayload {
  kind: 'checkpoint';
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

export type Envelope<T = unknown> = OkEnvelope<T> | ErrorEnvelope;

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

export function isCheckpointEnvelope(
  env: Envelope,
): env is OkEnvelope<CheckpointPayload> {
  return (
    env.status === 'ok' &&
    typeof env.data === 'object' &&
    env.data !== null &&
    (env.data as CheckpointPayload).kind === 'checkpoint' &&
    (env.data as CheckpointPayload).schema === CHECKPOINT_SCHEMA
  );
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
