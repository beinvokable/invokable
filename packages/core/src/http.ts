import { InvokableError } from './errors.js';
import { detectAgent } from './agent.js';

export type FetchLike = typeof globalThis.fetch;

export interface ApiClientOptions {
  baseUrl: string;
  token?: string | undefined;
  toolName: string;
  toolVersion: string;
  /** Reported as `X-Invokable-Command`; set per invocation. */
  commandName?: string | undefined;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
}

export interface RequestOptions {
  /** Extra headers, merged over the automatic ones. */
  headers?: Record<string, string>;
  /** Per-request timeout override. */
  timeoutMs?: number;
  /** Do not attach the Authorization header (used by the device flow). */
  anonymous?: boolean;
  signal?: AbortSignal;
}

interface ApiErrorBody {
  error?: string;
  code?: string;
  message?: string;
  remediation?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Maps an HTTP response onto the exit-code contract, so a tool author never has
 * to translate status codes by hand and every invokable tool reports the same
 * condition the same way (spec 5.2).
 */
function errorForStatus(status: number, body: ApiErrorBody, loginCommand: string): InvokableError {
  const message = body.message ?? body.error ?? `Request failed with status ${status}.`;
  const remediation = body.remediation;

  const make = (
    code: string,
    retryable: boolean,
    fallbackRemediation?: string,
  ): InvokableError =>
    new InvokableError({
      code,
      message,
      retryable,
      ...(remediation ?? fallbackRemediation
        ? { remediation: remediation ?? fallbackRemediation! }
        : {}),
    });

  switch (status) {
    case 401:
    case 403:
      return make('auth', false, loginCommand);
    case 402:
      return make('insufficient_spend', false);
    case 404:
      return make('not_found', false);
    case 409:
      // A stale checkpoint is signalled by the server as a 409 with this code.
      return body.code === 'checkpoint_stale'
        ? make('checkpoint_stale', false)
        : make('conflict', false);
    case 408:
      return make('timeout', true);
    case 429:
      // Deliberately not retryable: an agent hammering a rate limit makes it
      // worse. The user decides when to try again.
      return make('rate_limited', false);
    default:
      if (status >= 500) return make('error', true);
      return make('error', false);
  }
}

export class ApiClient {
  readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly toolName: string;
  private readonly toolVersion: string;
  private readonly commandName: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly agent: string;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.toolName = opts.toolName;
    this.toolVersion = opts.toolVersion;
    this.commandName = opts.commandName;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.agent = detectAgent(opts.env);
  }

  /** A copy of this client bound to a different base URL (e.g. the auth server). */
  withBaseUrl(baseUrl: string): ApiClient {
    return new ApiClient({
      baseUrl,
      token: this.token,
      toolName: this.toolName,
      toolVersion: this.toolVersion,
      commandName: this.commandName,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
  }

  get hasToken(): boolean {
    return Boolean(this.token);
  }

  private headers(opts: RequestOptions | undefined, hasBody: boolean): Record<string, string> {
    const h: Record<string, string> = {
      accept: 'application/json',
      'x-invokable-client': `${this.toolName}/${this.toolVersion}`,
      'x-invokable-agent': this.agent,
    };
    if (hasBody) h['content-type'] = 'application/json';
    if (this.commandName) h['x-invokable-command'] = this.commandName;
    if (this.token && !opts?.anonymous) h['authorization'] = `Bearer ${this.token}`;
    return { ...h, ...(opts?.headers ?? {}) };
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts?: RequestOptions,
  ): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    const hasBody = body !== undefined;
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (opts?.signal) {
      opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: this.headers(opts, hasBody),
        ...(hasBody ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) {
        throw new InvokableError({
          code: 'timeout',
          message: `Request to ${url} timed out after ${timeoutMs}ms.`,
          retryable: true,
          cause: e,
        });
      }
      throw new InvokableError({
        code: 'network',
        message: `Could not reach ${url}: ${e instanceof Error ? e.message : String(e)}`,
        retryable: true,
        cause: e,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: unknown;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) {
      const bodyObj: ApiErrorBody =
        typeof parsed === 'object' && parsed !== null ? (parsed as ApiErrorBody) : {};
      if (!bodyObj.message && text && parsed === undefined) {
        bodyObj.message = text.slice(0, 500);
      }
      throw errorForStatus(response.status, bodyObj, `${this.toolName} login`);
    }

    return parsed as T;
  }

  get<T = unknown>(path: string, opts?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, undefined, opts);
  }

  post<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, body, opts);
  }

  delete<T = unknown>(path: string, opts?: RequestOptions): Promise<T> {
    return this.request<T>('DELETE', path, undefined, opts);
  }
}

/**
 * Stands in for `client` when a tool declares no `api`. Every call fails with a
 * clear message rather than a `undefined is not a function` deep in user code.
 */
export function unconfiguredClient(toolName: string): ApiClient {
  const client = new ApiClient({
    baseUrl: 'http://invalid.invalid',
    toolName,
    toolVersion: '0.0.0',
  });
  const fail = (): never => {
    throw new InvokableError({
      code: 'error',
      message:
        `${toolName} did not declare an \`api.baseUrl\`, so \`client\` cannot be used. ` +
        'Add `api: { baseUrl: "https://…" }` to defineTool().',
      retryable: false,
    });
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proxied = client as any;
  proxied.request = fail;
  proxied.get = fail;
  proxied.post = fail;
  proxied.delete = fail;
  return client;
}
