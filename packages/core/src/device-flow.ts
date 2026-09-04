import { hostname } from 'node:os';
import { InvokableError } from './errors.js';
import type { ApiClient } from './http.js';

/** Response to `POST /device/start` (spec 5.4). */
export interface DeviceStartResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  /** Seconds between polls. */
  interval: number;
  /** Seconds until the device code expires. */
  expiresIn: number;
}

/** Successful response to `POST /device/token`. */
export interface DeviceTokenResponse {
  token: string;
  tokenPrefix?: string;
  orgId?: string;
  subject?: string;
  webOrigin?: string;
}

export type PendingReason = 'authorization_pending' | 'slow_down';
export type TerminalReason = 'expired_token' | 'access_denied';

export interface DeviceFlowHooks {
  /** Called once with the code and URL to show the user. */
  onPrompt?: (start: DeviceStartResponse) => void;
  /** Called before each poll attempt. */
  onPoll?: (attempt: number) => void;
}

export interface DeviceFlowOptions {
  client: ApiClient;
  toolName: string;
  toolVersion: string;
  hooks?: DeviceFlowHooks;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; defaults to `Date.now`. */
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Drives the device-code flow to completion: start, show the user a code, then
 * poll until the token is issued or the attempt terminates.
 *
 * The server signals "not yet" with a 400 carrying an `error` field, which the
 * ApiClient surfaces as an InvokableError. Those are unwrapped here rather than
 * propagated, since polling is the normal path, not a failure.
 */
export async function deviceLogin(options: DeviceFlowOptions): Promise<DeviceTokenResponse> {
  const { client, toolName, toolVersion, hooks } = options;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());

  const start = await client.post<DeviceStartResponse>(
    '/device/start',
    { clientName: toolName, hostname: hostname(), toolVersion },
    { anonymous: true },
  );

  if (!start?.deviceCode || !start.userCode || !start.verificationUri) {
    throw new InvokableError({
      code: 'error',
      message: 'The auth server returned an incomplete /device/start response.',
      retryable: false,
    });
  }

  hooks?.onPrompt?.(start);

  let intervalMs = Math.max(1, start.interval || 5) * 1000;
  const deadline = now() + Math.max(1, start.expiresIn || 900) * 1000;
  let attempt = 0;

  while (now() < deadline) {
    await sleep(intervalMs);
    attempt += 1;
    hooks?.onPoll?.(attempt);

    try {
      const token = await client.post<DeviceTokenResponse>(
        '/device/token',
        { deviceCode: start.deviceCode },
        { anonymous: true },
      );
      if (!token?.token) {
        throw new InvokableError({
          code: 'error',
          message: 'The auth server approved the device but returned no token.',
          retryable: false,
        });
      }
      return token;
    } catch (e) {
      const reason = pendingReason(e);
      if (reason === 'slow_down') {
        // The server is asking us to back off; honour it rather than hammering.
        intervalMs = Math.min(intervalMs * 2, 60_000);
        continue;
      }
      if (reason === 'authorization_pending') continue;
      throw e;
    }
  }

  throw new InvokableError({
    code: 'timeout',
    message: 'Login timed out: the code was not approved in time.',
    remediation: `${toolName} login`,
    retryable: true,
  });
}

/**
 * Extracts the OAuth-style `error` field from a rejected poll, translating the
 * two terminal reasons into contract errors and returning the two "keep going"
 * reasons to the caller.
 */
function pendingReason(e: unknown): PendingReason | undefined {
  const detail = errorDetail(e);
  if (detail === 'authorization_pending' || detail === 'slow_down') return detail;
  if (detail === 'access_denied') {
    throw new InvokableError({
      code: 'declined',
      message: 'The login request was denied.',
      retryable: false,
    });
  }
  if (detail === 'expired_token') {
    throw new InvokableError({
      code: 'timeout',
      message: 'The login code expired before it was approved.',
      retryable: true,
    });
  }
  return undefined;
}

function errorDetail(e: unknown): string | undefined {
  if (!(e instanceof InvokableError)) return undefined;
  // The ApiClient puts the server's `error`/`message` field into `message`
  // when no richer mapping applies.
  const text = e.message;
  for (const candidate of [
    'authorization_pending',
    'slow_down',
    'expired_token',
    'access_denied',
  ]) {
    if (text.includes(candidate)) return candidate;
  }
  return undefined;
}

export interface WhoamiResponse {
  subject?: string;
  orgId?: string;
  tokenPrefix?: string;
  [key: string]: unknown;
}

export function whoami(client: ApiClient): Promise<WhoamiResponse> {
  return client.get<WhoamiResponse>('/cli/whoami');
}

export function revokeToken(client: ApiClient): Promise<unknown> {
  return client.post('/cli/logout');
}

/** Used by `isRecord` consumers in tests; kept exported for the server package. */
export { isRecord as _isRecord };
