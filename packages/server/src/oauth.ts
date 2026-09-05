import { createHash, randomBytes } from 'node:crypto';
import { generateToken, hashToken, safeEqual } from './tokens.js';
import type { AuthStore, TokenRecord } from './store.js';
import type {
  OAuthClientAuthMethod,
  OAuthClientRecord,
  OAuthGrantRecord,
  OAuthRefreshRecord,
  OAuthStore,
} from './oauth-store.js';
import type { SessionUser } from './handler.js';

/**
 * An OAuth 2.1 authorization server for remote MCP clients.
 *
 * The device flow (`invokableAuth`) is how a CLI on the user's machine signs
 * in. ChatGPT, Claude.ai and other hosted MCP clients cannot run a CLI: they
 * discover an authorization server from the resource's metadata, register
 * themselves, send the user through a browser consent step and exchange the
 * resulting code for a bearer token.
 *
 * The only thing that matters about the design: the bearer token that comes
 * out is the same `TokenRecord` the device flow writes, into the same
 * `AuthStore`. `/cli/whoami`, `/cli/logout`, and every resource server that
 * verifies tokens by asking the issuer are unchanged. A tool that supports the
 * CLI path supports the remote path with no change to its API.
 *
 * Implements the pieces MCP clients require in practice:
 *
 *   GET  /.well-known/oauth-authorization-server   RFC 8414 metadata
 *   POST /oauth/register                           RFC 7591 dynamic client registration
 *   GET  /oauth/authorize                          consent page (session required to approve)
 *   POST /oauth/approve                            records the decision, redirects with a code
 *   POST /oauth/token                              authorization_code (PKCE S256) and refresh_token
 *   POST /oauth/revoke                             RFC 7009
 *
 * PKCE is mandatory for every client, public or confidential — OAuth 2.1 makes
 * it so, and it is what protects a code in flight through a browser.
 */

export interface ConsentPageContext {
  /** Carried by the approval form; not the authorization code. */
  requestId: string;
  client: OAuthClientRecord;
  grant: OAuthGrantRecord;
  scopes: string[];
  user: SessionUser | null;
}

export type AuthorizeOutcome =
  | {
      kind: 'consent';
      requestId: string;
      client: OAuthClientRecord;
      grant: OAuthGrantRecord;
      scopes: string[];
    }
  /** A well-formed request from a known client that cannot be granted: send the error back. */
  | { kind: 'redirect'; location: string }
  /** The client or redirect URI could not be verified, so nothing may be redirected. */
  | { kind: 'invalid'; status: number; error: string; message: string };

export interface StaticOAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  /** Plaintext; hashed before use. Omit for a public client. */
  clientSecret?: string;
  clientUri?: string;
  logoUri?: string;
}

export interface InvokableOAuthOptions {
  /** Where access tokens go. Pass the SAME store as `invokableAuth`. */
  store: AuthStore;
  oauthStore: OAuthStore;
  /** Resolves the browser session on the consent page. */
  requireSession: (request: Request) => SessionUser | null | Promise<SessionUser | null>;
  /** Renders the branded consent page. A plain default is used when omitted. */
  consentPage?: (ctx: ConsentPageContext) => string | Promise<string>;
  /**
   * The issuer identifier and base of every advertised endpoint, e.g.
   * `https://auth.example.com`. Defaults to the origin of the incoming request.
   */
  issuer?: string;
  /** Token prefix, e.g. `mtl`. Should match the device flow's. */
  tokenPrefix?: string;
  /** Access token lifetime in ms; `null` means long-lived, revocation only. */
  tokenTtl?: number | null;
  /**
   * Refresh token lifetime in ms; `null` means long-lived. Refresh tokens are
   * only issued when access tokens expire — with `tokenTtl: null` there is
   * nothing to refresh.
   */
  refreshTokenTtl?: number | null;
  /** How long an authorization request and its code stay valid. Default 10 minutes. */
  grantTtlMs?: number;
  /** Clients known ahead of time. Registered on first use. */
  clients?: StaticOAuthClient[];
  /** Accept RFC 7591 registrations at `/oauth/register`. Default true. */
  allowDynamicRegistration?: boolean;
  /** Advertised in metadata and shown on the consent page. */
  scopesSupported?: string[];
  /** Injectable clock, for tests. */
  now?: () => number;
}

const DEFAULT_GRANT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_REFRESH_TTL: number | null = null;

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      pragma: 'no-cache',
      ...CORS_HEADERS,
      ...headers,
    },
  });
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status);
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function randomId(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

/** RFC 7636 §4.6: `BASE64URL(SHA256(code_verifier)) == code_challenge`. */
function pkceMatches(verifier: string, challenge: string): boolean {
  if (verifier.length < 43 || verifier.length > 128) return false;
  const computed = base64url(createHash('sha256').update(verifier, 'ascii').digest());
  return safeEqual(computed, challenge);
}

/**
 * Where a client may be sent back to. `https` anywhere, or plain `http` on the
 * loopback interface for native clients that open a local port (RFC 8252 §7.3).
 */
export function isAcceptableRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') {
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  }
  return false;
}

function hostOf(value: string): string {
  try {
    return new URL(value).host || 'unknown';
  } catch {
    return 'unknown';
  }
}

async function readBody(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get('content-type') ?? '';
  const out: Record<string, string> = {};
  if (contentType.includes('application/json')) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    for (const [k, v] of Object.entries(body)) {
      if (typeof v === 'string') out[k] = v;
      else if (v !== undefined && v !== null && typeof v !== 'object') out[k] = String(v);
    }
    return out;
  }
  const form = await request.formData().catch(() => null);
  if (form) {
    for (const [k, v] of form.entries()) {
      if (typeof v === 'string') out[k] = v;
    }
  }
  return out;
}

function parseBasicAuth(request: Request): { id: string; secret: string } | null {
  const header = request.headers.get('authorization') ?? '';
  if (!/^Basic\s+/i.test(header)) return null;
  try {
    const decoded = Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    return {
      id: decodeURIComponent(decoded.slice(0, colon)),
      secret: decodeURIComponent(decoded.slice(colon + 1)),
    };
  } catch {
    return null;
  }
}

function defaultConsentPage(ctx: ConsentPageContext): string {
  const { client, grant, user, requestId, scopes } = ctx;
  const target = hostOf(grant.redirectUri);

  if (!user) {
    return `<!doctype html><meta charset="utf-8"><title>Sign in required</title>
<h1>Sign in required</h1>
<p><strong>${escapeHtml(client.clientName)}</strong> is asking to act as you. Sign in, then return to this page to decide.</p>`;
  }

  return `<!doctype html><meta charset="utf-8"><title>Allow access?</title>
<h1>Allow ${escapeHtml(client.clientName)} to act as you?</h1>
<dl>
  <dt>Application</dt><dd>${escapeHtml(client.clientName)}</dd>
  <dt>Returns to</dt><dd><code>${escapeHtml(target)}</code></dd>
  ${scopes.length ? `<dt>Access</dt><dd>${escapeHtml(scopes.join(', '))}</dd>` : ''}
  <dt>Signed in as</dt><dd>${escapeHtml(user.displayName ?? user.subject)}</dd>
</dl>
<p><strong>Only continue if you started this from ${escapeHtml(client.clientName)} yourself.</strong>
Anything it does with this access is done as you and billed to you.</p>
<form method="post" action="./approve">
  <input type="hidden" name="requestId" value="${escapeHtml(requestId)}">
  <button type="submit" name="decision" value="approve">Allow</button>
  <button type="submit" name="decision" value="deny">Deny</button>
</form>`;
}

export interface InvokableOAuthHandler {
  (request: Request): Promise<Response | null>;
  /**
   * Validates an authorization request and records it, without rendering.
   * For host applications that draw the consent page themselves.
   */
  begin(source: Request | URL | URLSearchParams): Promise<AuthorizeOutcome>;
  /** The RFC 8414 document, for serving from somewhere else. */
  metadata(origin: string): Record<string, unknown>;
}

export function invokableOAuth(options: InvokableOAuthOptions): InvokableOAuthHandler {
  const {
    store,
    oauthStore,
    requireSession,
    consentPage = defaultConsentPage,
    issuer,
    tokenPrefix = 'ivk',
    tokenTtl = null,
    refreshTokenTtl = DEFAULT_REFRESH_TTL,
    grantTtlMs = DEFAULT_GRANT_TTL_MS,
    clients = [],
    allowDynamicRegistration = true,
    scopesSupported = [],
    now = () => Date.now(),
  } = options;

  const issuesRefreshTokens = tokenTtl !== null;

  // Static clients are written on first use so lookups have one code path.
  let staticsRegistered: Promise<void> | undefined;
  function ensureStaticClients(): Promise<void> {
    staticsRegistered ??= (async () => {
      for (const c of clients) {
        if (await oauthStore.findClient(c.clientId)) continue;
        await oauthStore.createClient({
          clientId: c.clientId,
          ...(c.clientSecret !== undefined ? { clientSecretHash: hashToken(c.clientSecret) } : {}),
          clientName: c.clientName,
          redirectUris: c.redirectUris,
          tokenEndpointAuthMethod: c.clientSecret !== undefined ? 'client_secret_post' : 'none',
          createdAt: now(),
          ...(c.clientUri !== undefined ? { clientUri: c.clientUri } : {}),
          ...(c.logoUri !== undefined ? { logoUri: c.logoUri } : {}),
        });
      }
    })();
    return staticsRegistered;
  }

  function base(origin: string): string {
    return (issuer ?? origin).replace(/\/+$/, '');
  }

  function metadata(origin: string): Record<string, unknown> {
    const b = base(origin);
    return {
      issuer: b,
      authorization_endpoint: `${b}/oauth/authorize`,
      token_endpoint: `${b}/oauth/token`,
      revocation_endpoint: `${b}/oauth/revoke`,
      ...(allowDynamicRegistration ? { registration_endpoint: `${b}/oauth/register` } : {}),
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: issuesRefreshTokens
        ? ['authorization_code', 'refresh_token']
        : ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      ...(scopesSupported.length ? { scopes_supported: scopesSupported } : {}),
    };
  }

  // ---- authorize ----------------------------------------------------------

  async function begin(source: Request | URL | URLSearchParams): Promise<AuthorizeOutcome> {
    await ensureStaticClients();
    const params =
      source instanceof URLSearchParams
        ? source
        : source instanceof URL
          ? source.searchParams
          : new URL(source.url).searchParams;

    const clientId = params.get('client_id') ?? '';
    const redirectUri = params.get('redirect_uri') ?? '';

    // Nothing is redirected until both the client and its redirect URI are
    // verified: an open redirector is the classic authorization-server bug.
    const client = clientId ? await oauthStore.findClient(clientId) : null;
    if (!client) {
      return { kind: 'invalid', status: 400, error: 'invalid_client', message: 'Unknown client_id.' };
    }
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      return {
        kind: 'invalid',
        status: 400,
        error: 'invalid_request',
        message: 'redirect_uri is not registered for this client.',
      };
    }

    const state = params.get('state') ?? undefined;
    const back = (error: string, description: string): AuthorizeOutcome => {
      const location = new URL(redirectUri);
      location.searchParams.set('error', error);
      location.searchParams.set('error_description', description);
      if (state !== undefined) location.searchParams.set('state', state);
      return { kind: 'redirect', location: location.toString() };
    };

    if (params.get('response_type') !== 'code') {
      return back('unsupported_response_type', 'Only response_type=code is supported.');
    }
    const codeChallenge = params.get('code_challenge') ?? '';
    const method = params.get('code_challenge_method') ?? '';
    if (!codeChallenge) return back('invalid_request', 'code_challenge is required (PKCE).');
    if (method !== 'S256') return back('invalid_request', 'code_challenge_method must be S256.');
    if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
      return back('invalid_request', 'code_challenge is not a base64url SHA-256 digest.');
    }

    const resource = params.get('resource') ?? undefined;
    if (resource !== undefined) {
      try {
        const r = new URL(resource);
        if (r.hash) throw new Error('fragment');
      } catch {
        return back('invalid_target', 'resource must be an absolute URI without a fragment.');
      }
    }

    const scope = (params.get('scope') ?? '').trim().split(/\s+/).filter(Boolean);
    if (scopesSupported.length) {
      const unknown = scope.filter((s) => !scopesSupported.includes(s));
      if (unknown.length) return back('invalid_scope', `Unknown scope: ${unknown.join(' ')}.`);
    }

    const at = now();
    const grant: OAuthGrantRecord = {
      id: randomId(),
      clientId: client.clientId,
      redirectUri,
      scope: scope.join(' '),
      ...(state !== undefined ? { state } : {}),
      codeChallenge,
      codeChallengeMethod: 'S256',
      ...(resource !== undefined ? { resource } : {}),
      status: 'pending',
      createdAt: at,
      expiresAt: at + grantTtlMs,
    };
    await oauthStore.createGrant(grant);

    return { kind: 'consent', requestId: grant.id, client, grant, scopes: scope };
  }

  async function approve(
    request: Request,
    body: Record<string, string>,
  ): Promise<Response> {
    const user = await requireSession(request);
    if (!user) return json({ error: 'unauthorized', message: 'Sign in first.' }, 401);

    const requestId = body['requestId'] ?? '';
    const decision = body['decision'] === 'deny' ? 'deny' : 'approve';
    const grant = requestId ? await oauthStore.findGrant(requestId) : null;
    if (!grant) return json({ error: 'not_found', message: 'Unknown authorization request.' }, 404);

    const at = now();
    if (grant.expiresAt <= at) {
      return json({ error: 'expired', message: 'This request expired. Start again from the application.' }, 410);
    }
    if (grant.status !== 'pending') {
      return json({ error: 'conflict', message: 'This request was already decided.' }, 409);
    }

    const location = new URL(grant.redirectUri);
    if (grant.state !== undefined) location.searchParams.set('state', grant.state);

    if (decision === 'deny') {
      await oauthStore.updateGrant(grant.id, { status: 'denied', subject: user.subject });
      location.searchParams.set('error', 'access_denied');
      location.searchParams.set('error_description', 'The user declined.');
      return Response.redirect(location.toString(), 303);
    }

    // The code is random and stored hashed, like a token: it is a credential
    // for the next ten minutes.
    const code = randomId();
    await oauthStore.updateGrant(grant.id, {
      status: 'approved',
      subject: user.subject,
      ...(user.orgId !== undefined ? { orgId: user.orgId } : {}),
      codeHash: hashToken(code),
    });
    location.searchParams.set('code', code);
    return Response.redirect(location.toString(), 303);
  }

  // ---- token --------------------------------------------------------------

  /**
   * Identifies the client and checks its credential. A public client proves
   * nothing here — PKCE is its proof — but it must still name itself.
   */
  async function authenticateClient(
    request: Request,
    body: Record<string, string>,
  ): Promise<{ client: OAuthClientRecord } | { response: Response }> {
    await ensureStaticClients();
    const basic = parseBasicAuth(request);
    const clientId = basic?.id ?? body['client_id'] ?? '';
    const secret = basic?.secret ?? body['client_secret'];

    const client = clientId ? await oauthStore.findClient(clientId) : null;
    if (!client) {
      return {
        response: oauthError('invalid_client', 'Unknown client.', 401),
      };
    }
    if (client.clientSecretHash) {
      if (!secret || !safeEqual(hashToken(secret), client.clientSecretHash)) {
        return { response: oauthError('invalid_client', 'Client authentication failed.', 401) };
      }
    }
    return { client };
  }

  async function issueTokens(
    client: OAuthClientRecord,
    subject: string,
    orgId: string | undefined,
    scope: string,
    hostname: string,
  ): Promise<Record<string, unknown>> {
    const at = now();
    const { token, tokenHash } = generateToken(tokenPrefix);
    const record: TokenRecord = {
      tokenHash,
      tokenPrefix,
      subject,
      ...(orgId !== undefined ? { orgId } : {}),
      clientName: client.clientName,
      hostname,
      createdAt: at,
      expiresAt: tokenTtl === null ? null : at + tokenTtl,
    };
    await store.createToken(record);

    const response: Record<string, unknown> = {
      access_token: token,
      token_type: 'Bearer',
      ...(tokenTtl !== null ? { expires_in: Math.floor(tokenTtl / 1000) } : {}),
      ...(scope ? { scope } : {}),
    };

    if (issuesRefreshTokens) {
      const refreshToken = `${tokenPrefix}r_${randomId(32)}`;
      const refresh: OAuthRefreshRecord = {
        refreshHash: hashToken(refreshToken),
        tokenHash,
        clientId: client.clientId,
        subject,
        ...(orgId !== undefined ? { orgId } : {}),
        scope,
        createdAt: at,
        expiresAt: refreshTokenTtl === null ? null : at + refreshTokenTtl,
      };
      await oauthStore.createRefresh(refresh);
      response['refresh_token'] = refreshToken;
    }
    return response;
  }

  async function token(request: Request): Promise<Response> {
    const body = await readBody(request);
    const auth = await authenticateClient(request, body);
    if ('response' in auth) return auth.response;
    const { client } = auth;
    const at = now();

    if (body['grant_type'] === 'authorization_code') {
      const code = body['code'] ?? '';
      const verifier = body['code_verifier'] ?? '';
      if (!code) return oauthError('invalid_request', 'code is required.');
      if (!verifier) return oauthError('invalid_request', 'code_verifier is required.');

      const grant = await oauthStore.findGrantByCodeHash(hashToken(code));
      if (!grant || grant.status !== 'approved') {
        return oauthError('invalid_grant', 'The authorization code is invalid or was already used.');
      }
      if (grant.expiresAt <= at) return oauthError('invalid_grant', 'The authorization code expired.');
      if (grant.clientId !== client.clientId) {
        return oauthError('invalid_grant', 'The code was issued to a different client.');
      }
      // redirect_uri is optional in OAuth 2.1 when PKCE is used, but if sent it
      // must match what the code was issued against.
      if (body['redirect_uri'] !== undefined && body['redirect_uri'] !== grant.redirectUri) {
        return oauthError('invalid_grant', 'redirect_uri does not match the authorization request.');
      }
      if (!pkceMatches(verifier, grant.codeChallenge)) {
        return oauthError('invalid_grant', 'code_verifier does not match code_challenge.');
      }

      // Burned before the token is minted: a replayed code cannot produce a
      // second credential even if the first exchange raced it.
      await oauthStore.updateGrant(grant.id, { status: 'consumed' });

      return json(
        await issueTokens(
          client,
          grant.subject ?? 'unknown',
          grant.orgId,
          grant.scope,
          hostOf(grant.redirectUri),
        ),
      );
    }

    if (body['grant_type'] === 'refresh_token') {
      if (!issuesRefreshTokens) {
        return oauthError('unsupported_grant_type', 'This server does not issue refresh tokens.');
      }
      const presented = body['refresh_token'] ?? '';
      if (!presented) return oauthError('invalid_request', 'refresh_token is required.');

      const refresh = await oauthStore.findRefreshByHash(hashToken(presented));
      if (!refresh || refresh.clientId !== client.clientId) {
        return oauthError('invalid_grant', 'The refresh token is invalid.');
      }
      if (refresh.revokedAt !== undefined) {
        // A rotated-out refresh token coming back is either a bug or a theft.
        // Either way the access token it guarded stops working now.
        await store.revokeToken(refresh.tokenHash, at);
        return oauthError('invalid_grant', 'The refresh token was already used.');
      }
      if (refresh.expiresAt !== null && refresh.expiresAt <= at) {
        return oauthError('invalid_grant', 'The refresh token expired.');
      }

      const requested = (body['scope'] ?? '').trim();
      if (requested) {
        const have = new Set(refresh.scope.split(' ').filter(Boolean));
        const asked = requested.split(/\s+/).filter(Boolean);
        if (asked.some((s) => !have.has(s))) {
          return oauthError('invalid_scope', 'A refresh cannot widen the granted scope.');
        }
      }

      // Rotation: the old pair dies together.
      await oauthStore.revokeRefresh(refresh.refreshHash, at);
      await store.revokeToken(refresh.tokenHash, at);

      const previous = await store.findTokenByHash(refresh.tokenHash);
      return json(
        await issueTokens(
          client,
          refresh.subject,
          refresh.orgId,
          requested || refresh.scope,
          previous?.hostname ?? 'unknown',
        ),
      );
    }

    return oauthError(
      'unsupported_grant_type',
      'grant_type must be authorization_code or refresh_token.',
    );
  }

  // ---- revoke -------------------------------------------------------------

  async function revoke(request: Request): Promise<Response> {
    const body = await readBody(request);
    const auth = await authenticateClient(request, body);
    if ('response' in auth) return auth.response;

    const presented = body['token'] ?? '';
    if (presented) {
      const at = now();
      const hash = hashToken(presented);
      // RFC 7009 §2.1: the hint is a hint. Try both.
      const refresh = await oauthStore.findRefreshByHash(hash);
      if (refresh && refresh.clientId === auth.client.clientId) {
        await oauthStore.revokeRefresh(hash, at);
        await store.revokeToken(refresh.tokenHash, at);
      } else {
        const record = await store.findTokenByHash(hash);
        if (record && record.clientName === auth.client.clientName) {
          await store.revokeToken(hash, at);
        }
      }
    }
    // Always 200: the endpoint must not reveal whether a token existed.
    return json({});
  }

  // ---- register -----------------------------------------------------------

  async function register(request: Request): Promise<Response> {
    if (!allowDynamicRegistration) {
      return oauthError('invalid_request', 'Dynamic registration is disabled.', 403);
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return oauthError('invalid_client_metadata', 'Expected a JSON body.');

    const redirectUris = Array.isArray(body['redirect_uris'])
      ? body['redirect_uris'].filter((u): u is string => typeof u === 'string')
      : [];
    if (!redirectUris.length) {
      return oauthError('invalid_redirect_uri', 'redirect_uris must list at least one URI.');
    }
    const bad = redirectUris.find((u) => !isAcceptableRedirectUri(u));
    if (bad) {
      return oauthError(
        'invalid_redirect_uri',
        `${bad} is not acceptable: use https, or http on localhost.`,
      );
    }

    const grantTypes = Array.isArray(body['grant_types'])
      ? body['grant_types'].filter((g): g is string => typeof g === 'string')
      : ['authorization_code'];
    // `refresh_token` is accepted even when none will be issued: most clients
    // list it by default, and a registration that fails over a grant the
    // client can simply never use helps nobody.
    const allowedGrants = new Set(['authorization_code', 'refresh_token']);
    const unsupportedGrant = grantTypes.find((g) => !allowedGrants.has(g));
    if (unsupportedGrant) {
      return oauthError('invalid_client_metadata', `grant_type ${unsupportedGrant} is not supported.`);
    }
    const responseTypes = Array.isArray(body['response_types'])
      ? body['response_types'].filter((r): r is string => typeof r === 'string')
      : ['code'];
    if (responseTypes.some((r) => r !== 'code')) {
      return oauthError('invalid_client_metadata', 'Only response_type code is supported.');
    }

    const requestedAuth = body['token_endpoint_auth_method'];
    const authMethod: OAuthClientAuthMethod =
      requestedAuth === 'client_secret_post' || requestedAuth === 'client_secret_basic'
        ? requestedAuth
        : 'none';
    if (requestedAuth !== undefined && requestedAuth !== authMethod) {
      return oauthError(
        'invalid_client_metadata',
        'token_endpoint_auth_method must be none, client_secret_post or client_secret_basic.',
      );
    }

    const clientName =
      typeof body['client_name'] === 'string' && body['client_name'].trim()
        ? body['client_name'].trim().slice(0, 120)
        : hostOf(redirectUris[0]!);
    const clientUri = typeof body['client_uri'] === 'string' ? body['client_uri'] : undefined;
    const logoUri = typeof body['logo_uri'] === 'string' ? body['logo_uri'] : undefined;

    const at = now();
    const clientId = `oc_${randomId(16)}`;
    const clientSecret = authMethod === 'none' ? undefined : `ocs_${randomId(32)}`;

    await oauthStore.createClient({
      clientId,
      ...(clientSecret !== undefined ? { clientSecretHash: hashToken(clientSecret) } : {}),
      clientName,
      redirectUris,
      tokenEndpointAuthMethod: authMethod,
      createdAt: at,
      ...(clientUri !== undefined ? { clientUri } : {}),
      ...(logoUri !== undefined ? { logoUri } : {}),
    });

    return json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(at / 1000),
        ...(clientSecret !== undefined
          ? { client_secret: clientSecret, client_secret_expires_at: 0 }
          : {}),
        client_name: clientName,
        redirect_uris: redirectUris,
        grant_types: grantTypes,
        response_types: ['code'],
        token_endpoint_auth_method: authMethod,
        ...(clientUri !== undefined ? { client_uri: clientUri } : {}),
        ...(logoUri !== undefined ? { logo_uri: logoUri } : {}),
      },
      201,
    );
  }

  // ---- routing ------------------------------------------------------------

  const handle = async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method.toUpperCase();

    const isMetadata = path.includes('/.well-known/oauth-authorization-server');
    const isRegister = path.endsWith('/oauth/register');
    const isAuthorize = path.endsWith('/oauth/authorize');
    const isApprove = path.endsWith('/oauth/approve');
    const isToken = path.endsWith('/oauth/token');
    const isRevoke = path.endsWith('/oauth/revoke');

    if (method === 'OPTIONS' && (isMetadata || isRegister || isToken || isRevoke)) {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (isMetadata && method === 'GET') return json(metadata(url.origin));
    if (isRegister && method === 'POST') return register(request);
    if (isToken && method === 'POST') return token(request);
    if (isRevoke && method === 'POST') return revoke(request);

    if (isAuthorize && method === 'GET') {
      const outcome = await begin(request);
      if (outcome.kind === 'redirect') return Response.redirect(outcome.location, 302);
      if (outcome.kind === 'invalid') {
        return html(
          `<!doctype html><meta charset="utf-8"><title>Cannot continue</title>
<h1>Cannot continue</h1><p>${escapeHtml(outcome.message)}</p>`,
          outcome.status,
        );
      }
      const user = await requireSession(request);
      return html(
        await consentPage({
          requestId: outcome.requestId,
          client: outcome.client,
          grant: outcome.grant,
          scopes: outcome.scopes,
          user,
        }),
      );
    }

    if (isApprove && method === 'POST') {
      return approve(request, await readBody(request));
    }

    return null;
  } as InvokableOAuthHandler;

  handle.begin = begin;
  handle.metadata = metadata;
  return handle;
}
