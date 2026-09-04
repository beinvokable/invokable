import { EXIT, assertCustomExitCode, type ExitName } from './exit-codes.js';
import { errorEnvelope, type ErrorEnvelope } from './envelope.js';

export interface InvokableErrorInit {
  /** Reserved exit name, or a tool-defined slug when `exitCode` is custom. */
  code: ExitName | (string & {});
  message: string;
  /** The literal next command the agent should run. */
  remediation?: string;
  retryable?: boolean;
  /** Only for tool-defined conditions; must be 30-99. */
  exitCode?: number;
  cause?: unknown;
}

/**
 * The one error type the runtime understands. Anything else thrown by a
 * command is treated as an unexpected failure (exit 1) with the stack sent to
 * stderr, never to stdout.
 */
export class InvokableError extends Error {
  readonly code: string;
  readonly remediation: string | undefined;
  readonly retryable: boolean;
  readonly exitCode: number;

  constructor(init: InvokableErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'InvokableError';
    this.code = init.code;
    this.remediation = init.remediation;
    this.retryable = init.retryable ?? false;

    if (init.exitCode !== undefined) {
      assertCustomExitCode(init.exitCode);
      this.exitCode = init.exitCode;
    } else {
      const reserved = (EXIT as Record<string, number | undefined>)[init.code];
      if (reserved === undefined) {
        throw new TypeError(
          `Unknown error code "${init.code}". Use a reserved code name, or pass ` +
            `an explicit \`exitCode\` in 30-99 for a tool-defined condition.`,
        );
      }
      this.exitCode = reserved;
    }
  }

  toEnvelope(): ErrorEnvelope {
    return errorEnvelope({
      code: this.code,
      message: this.message,
      remediation: this.remediation,
      retryable: this.retryable,
    });
  }
}

/** Narrow helpers for the conditions the runtime itself raises. */

export function usageError(message: string, remediation?: string): InvokableError {
  return new InvokableError({
    code: 'usage',
    message,
    ...(remediation !== undefined ? { remediation } : {}),
    retryable: false,
  });
}

export function authError(remediation: string, message = 'Not authenticated.'): InvokableError {
  return new InvokableError({ code: 'auth', message, remediation, retryable: false });
}

export function notFoundError(message: string, remediation?: string): InvokableError {
  return new InvokableError({
    code: 'not_found',
    message,
    ...(remediation !== undefined ? { remediation } : {}),
    retryable: false,
  });
}

export function networkError(message: string, cause?: unknown): InvokableError {
  return new InvokableError({
    code: 'network',
    message,
    retryable: true,
    ...(cause !== undefined ? { cause } : {}),
  });
}

export function declinedError(message = 'Declined by the user.'): InvokableError {
  return new InvokableError({ code: 'declined', message, retryable: false });
}

export function isInvokableError(e: unknown): e is InvokableError {
  return e instanceof InvokableError;
}
