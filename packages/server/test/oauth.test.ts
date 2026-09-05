import { createServer, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClient, deviceLogin } from '@invokable/core';
import {
  invokableAuth,
  invokableOAuth,
  memoryOAuthStore,
  memoryStore,
  oauthProtectedResource,
} from '../src/index.js';
import { nodeListener } from '../src/node.js';
import type { SessionUser } from '../src/handler.js';
import { PGlite } from '@electric-sql/pglite';
import { createSchema, postgresAuthStore, postgresOAuthStore } from '../src/postgres-store.js';
import type { SqlExecutor } from '../src/sql.js';

/**
 * The remote-client path, end to end, over a real socket: an MCP host
 * discovers the server from the resource's metadata, registers itself, sends
 * the user through consent, exchanges the code with PKCE, and ends up with a
 * token that `/cli/whoami` — the same endpoint the CLI uses — accepts.
 *
 * The device flow is exercised alongside in the same process against the same
 * store, because the whole point is that adding OAuth changed nothing there.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

interface Harness {
  url: string;
  store: ReturnType<typeof memoryStore>;
  oauthStore: ReturnType<typeof memoryOAuthStore>;
  setUser: (user: SessionUser | null) => void;
  now: { value: number };
}

async function harness(opts: { tokenTtl?: number | null; refreshTokenTtl?: number | null } = {}): Promise<Harness> {
  const store = memoryStore();
  const oauthStore = memoryOAuthStore();
  let user: SessionUser | null = { subject: 'ido@example.com', orgId: 'org_acme', displayName: 'Ido' };
  const now = { value: Date.now() };

  const auth = invokableAuth({
    store,
    requireSession: () => user,
    tokenPrefix: 'tst',
    pollIntervalSeconds: 0,
    now: () => now.value,
  });
  const oauth = invokableOAuth({
    store,
    oauthStore,
    requireSession: () => user,
    tokenPrefix: 'tst',
    tokenTtl: opts.tokenTtl ?? null,
    ...(opts.refreshTokenTtl !== undefined ? { refreshTokenTtl: opts.refreshTokenTtl } : {}),
    scopesSupported: ['tools'],
    clients: [
      {
        clientId: 'static-client',
        clientName: 'Static Host',
        redirectUris: ['https://host.example/callback'],
      },
    ],
    now: () => now.value,
  });

  const handler = async (request: Request) => (await auth(request)) ?? (await oauth(request));
  const server: Server = createServer(nodeListener(handler));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    store,
    oauthStore,
    setUser: (u) => {
      user = u;
    },
    now,
  };
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

async function register(url: string, over: Record<string, unknown> = {}) {
  const res = await fetch(`${url}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'ChatGPT',
      redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      ...over,
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Sends the user through /oauth/authorize and /oauth/approve; returns the redirect the client sees. */
async function consent(
  url: string,
  params: Record<string, string>,
  decision: 'approve' | 'deny' = 'approve',
): Promise<{ page: string; pageStatus: number; redirect: URL | null; approveStatus: number }> {
  const authorize = new URL(`${url}/oauth/authorize`);
  for (const [k, v] of Object.entries(params)) authorize.searchParams.set(k, v);

  const page = await fetch(authorize, { redirect: 'manual' });
  const pageStatus = page.status;
  if (page.status === 302) {
    return { page: '', pageStatus, redirect: new URL(page.headers.get('location')!), approveStatus: 0 };
  }
  const body = await page.text();
  const requestId = /name="requestId" value="([^"]+)"/.exec(body)?.[1];
  if (!requestId) return { page: body, pageStatus, redirect: null, approveStatus: 0 };

  const form = new URLSearchParams({ requestId, decision });
  const approve = await fetch(`${url}/oauth/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    redirect: 'manual',
  });
  const location = approve.headers.get('location');
  return {
    page: body,
    pageStatus,
    redirect: location ? new URL(location) : null,
    approveStatus: approve.status,
  };
}

async function exchange(url: string, body: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await fetch(`${url}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function whoami(url: string, token: string) {
  const res = await fetch(`${url}/cli/whoami`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The whole dance, for tests that need a token and do not care how. */
async function login(h: Harness, over: Record<string, string> = {}) {
  const { body: client } = await register(h.url);
  const { verifier, challenge } = pkce();
  const { redirect } = await consent(h.url, {
    response_type: 'code',
    client_id: String(client['client_id']),
    redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    ...over,
  });
  const code = redirect!.searchParams.get('code')!;
  const token = await exchange(h.url, {
    grant_type: 'authorization_code',
    client_id: String(client['client_id']),
    code,
    code_verifier: verifier,
    redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
  });
  return { client, token, code, verifier };
}

describe('discovery', () => {
  it('serves RFC 8414 metadata with PKCE and registration advertised', async () => {
    const h = await harness();
    const res = await fetch(`${h.url}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta).toMatchObject({
      issuer: h.url,
      authorization_endpoint: `${h.url}/oauth/authorize`,
      token_endpoint: `${h.url}/oauth/token`,
      registration_endpoint: `${h.url}/oauth/register`,
      revocation_endpoint: `${h.url}/oauth/revoke`,
      code_challenge_methods_supported: ['S256'],
      response_types_supported: ['code'],
      scopes_supported: ['tools'],
    });
  });

  it('answers CORS preflight on the JSON endpoints', async () => {
    const h = await harness();
    const res = await fetch(`${h.url}/oauth/token`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });
});

describe('dynamic client registration', () => {
  it('registers a public client', async () => {
    const h = await harness();
    const { status, body } = await register(h.url);
    expect(status).toBe(201);
    expect(body['client_id']).toMatch(/^oc_/);
    expect(body['client_secret']).toBeUndefined();
    expect(body['token_endpoint_auth_method']).toBe('none');
    expect(body['redirect_uris']).toEqual(['https://chatgpt.com/connector_platform_oauth_redirect']);
    expect(body['client_name']).toBe('ChatGPT');
  });

  it('issues a secret when the client asks for one, and stores only its hash', async () => {
    const h = await harness();
    const { body } = await register(h.url, { token_endpoint_auth_method: 'client_secret_post' });
    expect(body['client_secret']).toMatch(/^ocs_/);
    const stored = h.oauthStore._clients.get(String(body['client_id']))!;
    expect(stored.clientSecretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(String(body['client_secret']));
  });

  it('refuses redirect URIs that are not https or loopback', async () => {
    const h = await harness();
    expect((await register(h.url, { redirect_uris: ['http://evil.example/cb'] })).status).toBe(400);
    expect((await register(h.url, { redirect_uris: [] })).status).toBe(400);
    expect((await register(h.url, { redirect_uris: ['http://localhost:3000/cb'] })).status).toBe(201);
    expect((await register(h.url, { redirect_uris: ['http://127.0.0.1:8080/cb'] })).status).toBe(201);
  });

  it('refuses unsupported grant and response types', async () => {
    const h = await harness();
    expect((await register(h.url, { grant_types: ['implicit'] })).status).toBe(400);
    expect((await register(h.url, { response_types: ['token'] })).status).toBe(400);
    // Refresh tokens are not issued with tokenTtl: null, but most clients list
    // the grant by default and must still be able to register.
    expect((await register(h.url, { grant_types: ['authorization_code', 'refresh_token'] })).status).toBe(201);
  });

  it('can be disabled', async () => {
    const store = memoryStore();
    const oauth = invokableOAuth({
      store,
      oauthStore: memoryOAuthStore(),
      requireSession: () => null,
      allowDynamicRegistration: false,
    });
    const res = await oauth(
      new Request('http://x/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: ['https://a.example/cb'] }),
      }),
    );
    expect(res?.status).toBe(403);
    const meta = await oauth(new Request('http://x/.well-known/oauth-authorization-server'));
    expect(((await meta!.json()) as Record<string, unknown>)['registration_endpoint']).toBeUndefined();
  });
});

describe('authorization code + PKCE', () => {
  it('issues a token that /cli/whoami accepts, exactly like a device-flow token', async () => {
    const h = await harness();
    const { token } = await login(h);

    expect(token.status).toBe(200);
    expect(token.body).toMatchObject({ token_type: 'Bearer' });
    expect(token.body['access_token']).toMatch(/^tst_[A-Za-z0-9]{32}$/);
    expect(token.body['expires_in']).toBeUndefined();
    expect(token.body['refresh_token']).toBeUndefined();

    const who = await whoami(h.url, String(token.body['access_token']));
    expect(who.status).toBe(200);
    expect(who.body).toMatchObject({
      subject: 'ido@example.com',
      orgId: 'org_acme',
      tokenPrefix: 'tst',
      clientName: 'ChatGPT',
      hostname: 'chatgpt.com',
    });
  });

  it('echoes state and never stores the code or token in plaintext', async () => {
    const h = await harness();
    const { body: client } = await register(h.url);
    const { challenge } = pkce();
    const { redirect } = await consent(h.url, {
      response_type: 'code',
      client_id: String(client['client_id']),
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'opaque-state',
    });
    expect(redirect!.origin + redirect!.pathname).toBe('https://chatgpt.com/connector_platform_oauth_redirect');
    expect(redirect!.searchParams.get('state')).toBe('opaque-state');
    const code = redirect!.searchParams.get('code')!;
    expect(code.length).toBeGreaterThan(30);
    expect(JSON.stringify([...h.oauthStore._grants.values()])).not.toContain(code);
  });

  it('shows the consent page only to a signed-in user', async () => {
    const h = await harness();
    h.setUser(null);
    const { body: client } = await register(h.url);
    const { challenge } = pkce();
    const result = await consent(h.url, {
      response_type: 'code',
      client_id: String(client['client_id']),
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    expect(result.pageStatus).toBe(200);
    expect(result.page).toContain('Sign in required');
    expect(result.redirect).toBeNull();
  });

  it('refuses to approve without a session', async () => {
    const h = await harness();
    const { body: client } = await register(h.url);
    const outcome = await fetch(
      `${h.url}/oauth/authorize?` +
        new URLSearchParams({
          response_type: 'code',
          client_id: String(client['client_id']),
          redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
          code_challenge: pkce().challenge,
          code_challenge_method: 'S256',
        }),
    );
    const requestId = /name="requestId" value="([^"]+)"/.exec(await outcome.text())![1]!;
    h.setUser(null);
    const approve = await fetch(`${h.url}/oauth/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, decision: 'approve' }),
      redirect: 'manual',
    });
    expect(approve.status).toBe(401);
    expect(h.oauthStore._grants.get(requestId)!.status).toBe('pending');
  });

  it('returns access_denied to the client when the user declines', async () => {
    const h = await harness();
    const { body: client } = await register(h.url);
    const { redirect, approveStatus } = await consent(
      h.url,
      {
        response_type: 'code',
        client_id: String(client['client_id']),
        redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
        state: 's',
      },
      'deny',
    );
    expect(approveStatus).toBe(303);
    expect(redirect!.searchParams.get('error')).toBe('access_denied');
    expect(redirect!.searchParams.get('state')).toBe('s');
    expect(redirect!.searchParams.get('code')).toBeNull();
    expect(h.store._tokens.size).toBe(0);
  });

  it('never redirects to an unregistered redirect_uri', async () => {
    const h = await harness();
    const { body: client } = await register(h.url);
    const result = await consent(h.url, {
      response_type: 'code',
      client_id: String(client['client_id']),
      redirect_uri: 'https://evil.example/steal',
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
    });
    expect(result.pageStatus).toBe(400);
    expect(result.redirect).toBeNull();

    const unknown = await consent(h.url, {
      response_type: 'code',
      client_id: 'oc_nobody',
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
    });
    expect(unknown.pageStatus).toBe(400);
    expect(unknown.redirect).toBeNull();
  });

  it('sends protocol errors back to a verified redirect_uri', async () => {
    const h = await harness();
    const { body: client } = await register(h.url);
    const base = {
      client_id: String(client['client_id']),
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      state: 'k',
    };

    const noPkce = await consent(h.url, { ...base, response_type: 'code' });
    expect(noPkce.pageStatus).toBe(302);
    expect(noPkce.redirect!.searchParams.get('error')).toBe('invalid_request');
    expect(noPkce.redirect!.searchParams.get('state')).toBe('k');

    const plain = await consent(h.url, {
      ...base,
      response_type: 'code',
      code_challenge: pkce().challenge,
      code_challenge_method: 'plain',
    });
    expect(plain.redirect!.searchParams.get('error')).toBe('invalid_request');

    const badType = await consent(h.url, {
      ...base,
      response_type: 'token',
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
    });
    expect(badType.redirect!.searchParams.get('error')).toBe('unsupported_response_type');

    const badScope = await consent(h.url, {
      ...base,
      response_type: 'code',
      scope: 'admin',
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
    });
    expect(badScope.redirect!.searchParams.get('error')).toBe('invalid_scope');
  });

  it('rejects a wrong code_verifier and keeps the code usable for the right one', async () => {
    const h = await harness();
    const { body: client } = await register(h.url);
    const { verifier, challenge } = pkce();
    const { redirect } = await consent(h.url, {
      response_type: 'code',
      client_id: String(client['client_id']),
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const code = redirect!.searchParams.get('code')!;
    const clientId = String(client['client_id']);

    const wrong = await exchange(h.url, {
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: pkce().verifier,
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body['error']).toBe('invalid_grant');
    expect(h.store._tokens.size).toBe(0);

    const right = await exchange(h.url, {
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
    });
    expect(right.status).toBe(200);
  });

  it('burns the code: a replay yields no second token', async () => {
    const h = await harness();
    const { client, code, verifier } = await login(h);
    const again = await exchange(h.url, {
      grant_type: 'authorization_code',
      client_id: String(client['client_id']),
      code,
      code_verifier: verifier,
    });
    expect(again.status).toBe(400);
    expect(again.body['error']).toBe('invalid_grant');
    expect(h.store._tokens.size).toBe(1);
  });

  it('refuses a code presented by a different client', async () => {
    const h = await harness();
    const { body: client } = await register(h.url);
    const { verifier, challenge } = pkce();
    const { redirect } = await consent(h.url, {
      response_type: 'code',
      client_id: String(client['client_id']),
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const other = await register(h.url, { client_name: 'Other' });
    const res = await exchange(h.url, {
      grant_type: 'authorization_code',
      client_id: String(other.body['client_id']),
      code: redirect!.searchParams.get('code')!,
      code_verifier: verifier,
    });
    expect(res.status).toBe(400);
    expect(res.body['error']).toBe('invalid_grant');
  });

  it('refuses an expired code', async () => {
    const h = await harness();
    const { body: client } = await register(h.url);
    const { verifier, challenge } = pkce();
    const { redirect } = await consent(h.url, {
      response_type: 'code',
      client_id: String(client['client_id']),
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    h.now.value += 11 * 60 * 1000;
    const res = await exchange(h.url, {
      grant_type: 'authorization_code',
      client_id: String(client['client_id']),
      code: redirect!.searchParams.get('code')!,
      code_verifier: verifier,
    });
    expect(res.status).toBe(400);
    expect(res.body['error_description']).toContain('expired');
  });

  it('authenticates confidential clients by secret, over POST and Basic', async () => {
    const h = await harness();
    const { body: client } = await register(h.url, { token_endpoint_auth_method: 'client_secret_basic' });
    const clientId = String(client['client_id']);
    const secret = String(client['client_secret']);
    const { verifier, challenge } = pkce();

    const grantFor = async () =>
      (
        await consent(h.url, {
          response_type: 'code',
          client_id: clientId,
          redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        })
      ).redirect!.searchParams.get('code')!;

    const noSecret = await exchange(h.url, {
      grant_type: 'authorization_code',
      client_id: clientId,
      code: await grantFor(),
      code_verifier: verifier,
    });
    expect(noSecret.status).toBe(401);
    expect(noSecret.body['error']).toBe('invalid_client');

    const viaPost = await exchange(h.url, {
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: secret,
      code: await grantFor(),
      code_verifier: verifier,
    });
    expect(viaPost.status).toBe(200);

    const basic = Buffer.from(`${clientId}:${secret}`).toString('base64');
    const viaBasic = await exchange(
      h.url,
      { grant_type: 'authorization_code', code: await grantFor(), code_verifier: verifier },
      { authorization: `Basic ${basic}` },
    );
    expect(viaBasic.status).toBe(200);
  });

  it('works for a statically configured client', async () => {
    const h = await harness();
    const { verifier, challenge } = pkce();
    const { redirect } = await consent(h.url, {
      response_type: 'code',
      client_id: 'static-client',
      redirect_uri: 'https://host.example/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: 'https://tool.example/mcp',
    });
    const res = await exchange(h.url, {
      grant_type: 'authorization_code',
      client_id: 'static-client',
      code: redirect!.searchParams.get('code')!,
      code_verifier: verifier,
    });
    expect(res.status).toBe(200);
    const who = await whoami(h.url, String(res.body['access_token']));
    expect(who.body['clientName']).toBe('Static Host');
    expect(who.body['hostname']).toBe('host.example');
  });

  it('accepts a JSON body at the token endpoint', async () => {
    const h = await harness();
    const { body: client } = await register(h.url);
    const { verifier, challenge } = pkce();
    const { redirect } = await consent(h.url, {
      response_type: 'code',
      client_id: String(client['client_id']),
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const res = await fetch(`${h.url}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: client['client_id'],
        code: redirect!.searchParams.get('code'),
        code_verifier: verifier,
      }),
    });
    expect(res.status).toBe(200);
  });
});

describe('refresh tokens', () => {
  it('are issued when access tokens expire, and rotate on use', async () => {
    const h = await harness({ tokenTtl: 60_000 });
    const { client, token } = await login(h);
    expect(token.body['expires_in']).toBe(60);
    const refresh = String(token.body['refresh_token']);
    expect(refresh).toMatch(/^tstr_/);
    const first = String(token.body['access_token']);

    h.now.value += 61_000;
    expect((await whoami(h.url, first)).status).toBe(401);

    const rotated = await exchange(h.url, {
      grant_type: 'refresh_token',
      client_id: String(client['client_id']),
      refresh_token: refresh,
    });
    expect(rotated.status).toBe(200);
    const second = String(rotated.body['access_token']);
    expect(second).not.toBe(first);
    expect(rotated.body['refresh_token']).not.toBe(refresh);
    expect((await whoami(h.url, second)).status).toBe(200);
    expect((await whoami(h.url, second)).body['hostname']).toBe('chatgpt.com');

    // The old refresh token is dead; presenting it again kills the new access
    // token too, since someone other than the client evidently holds it.
    const replay = await exchange(h.url, {
      grant_type: 'refresh_token',
      client_id: String(client['client_id']),
      refresh_token: refresh,
    });
    expect(replay.status).toBe(400);
    expect(replay.body['error']).toBe('invalid_grant');
  });

  it('cannot widen scope and are bound to their client', async () => {
    const h = await harness({ tokenTtl: 60_000 });
    const { client, token } = await login(h, { scope: 'tools' });
    const refresh = String(token.body['refresh_token']);

    const other = await register(h.url, { client_name: 'Other' });
    const stolen = await exchange(h.url, {
      grant_type: 'refresh_token',
      client_id: String(other.body['client_id']),
      refresh_token: refresh,
    });
    expect(stolen.status).toBe(400);

    const wider = await exchange(h.url, {
      grant_type: 'refresh_token',
      client_id: String(client['client_id']),
      refresh_token: refresh,
      scope: 'tools admin',
    });
    expect(wider.status).toBe(400);
    expect(wider.body['error']).toBe('invalid_scope');
  });

  it('expire', async () => {
    const h = await harness({ tokenTtl: 60_000, refreshTokenTtl: 120_000 });
    const { client, token } = await login(h);
    h.now.value += 121_000;
    const res = await exchange(h.url, {
      grant_type: 'refresh_token',
      client_id: String(client['client_id']),
      refresh_token: String(token.body['refresh_token']),
    });
    expect(res.status).toBe(400);
    expect(res.body['error_description']).toContain('expired');
  });
});

describe('revocation', () => {
  it('revokes an access token and answers 200 regardless', async () => {
    const h = await harness();
    const { client, token } = await login(h);
    const access = String(token.body['access_token']);
    expect((await whoami(h.url, access)).status).toBe(200);

    const res = await fetch(`${h.url}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: String(client['client_id']), token: access }),
    });
    expect(res.status).toBe(200);
    expect((await whoami(h.url, access)).status).toBe(401);

    const unknown = await fetch(`${h.url}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: String(client['client_id']), token: 'tst_nothing' }),
    });
    expect(unknown.status).toBe(200);
  });

  it('revoking a refresh token also kills its access token', async () => {
    const h = await harness({ tokenTtl: 60_000 });
    const { client, token } = await login(h);
    await fetch(`${h.url}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: String(client['client_id']),
        token: String(token.body['refresh_token']),
      }),
    });
    expect((await whoami(h.url, String(token.body['access_token']))).status).toBe(401);
  });

  it('the CLI logout endpoint revokes an OAuth-issued token too', async () => {
    const h = await harness();
    const { token } = await login(h);
    const access = String(token.body['access_token']);
    const res = await fetch(`${h.url}/cli/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${access}` },
    });
    expect(res.status).toBe(200);
    expect((await whoami(h.url, access)).status).toBe(401);
  });
});

describe('coexistence with the device flow', () => {
  it('both flows write to one token store and the CLI client reads either', async () => {
    const h = await harness();

    const cli = new ApiClient({ baseUrl: h.url, toolName: 'demo-tool', toolVersion: '1.0.0' });
    const device = await deviceLogin({
      client: cli,
      toolName: 'demo-tool',
      toolVersion: '1.0.0',
      sleep: async () => {},
      hooks: {
        onPrompt: (start) =>
          void fetch(`${h.url}/device/approve`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ userCode: start.userCode, decision: 'approve' }),
          }),
      },
    });
    const { token } = await login(h);

    expect(h.store._tokens.size).toBe(2);
    for (const t of [device.token, String(token.body['access_token'])]) {
      const who = await new ApiClient({
        baseUrl: h.url,
        toolName: 'demo-tool',
        toolVersion: '1.0.0',
        token: t,
      }).get<{ subject: string; tokenPrefix: string }>('/cli/whoami');
      expect(who.subject).toBe('ido@example.com');
      expect(who.tokenPrefix).toBe('tst');
    }
  });

  it('the OAuth handler returns null for device-flow paths', async () => {
    const oauth = invokableOAuth({
      store: memoryStore(),
      oauthStore: memoryOAuthStore(),
      requireSession: () => null,
    });
    expect(await oauth(new Request('http://x/device/start', { method: 'POST' }))).toBeNull();
    expect(await oauth(new Request('http://x/cli/whoami'))).toBeNull();
  });
});

describe('protected resource metadata', () => {
  it('serves RFC 9728 metadata and a 401 that points at it', async () => {
    const resource = oauthProtectedResource({
      authorizationServers: ['https://auth.example/'],
      scopesSupported: ['tools'],
      resourceName: 'demo',
      fetch: async () => new Response(JSON.stringify({ issuer: 'https://auth.example' })),
    });

    const meta = await resource(new Request('https://tool.example/.well-known/oauth-protected-resource'));
    expect(meta?.status).toBe(200);
    expect(await meta!.json()).toEqual({
      resource: 'https://tool.example/mcp',
      authorization_servers: ['https://auth.example'],
      bearer_methods_supported: ['header'],
      scopes_supported: ['tools'],
      resource_name: 'demo',
    });

    // The path-suffixed form for a resource with a path.
    const suffixed = await resource(
      new Request('https://tool.example/.well-known/oauth-protected-resource/mcp'),
    );
    expect(suffixed?.status).toBe(200);

    const relayed = await resource(
      new Request('https://tool.example/.well-known/oauth-authorization-server'),
    );
    expect(await relayed!.json()).toEqual({ issuer: 'https://auth.example' });

    const denied = resource.unauthorized(new Request('https://tool.example/mcp'), {
      error: 'invalid_token',
      description: 'Token "rejected"',
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://tool.example/.well-known/oauth-protected-resource/mcp", ' +
        'error="invalid_token", error_description="Token \'rejected\'"',
    );

    expect(await resource(new Request('https://tool.example/api/v1/balance'))).toBeNull();
  });
});

describe('on postgres', () => {
  it('runs the whole flow against the durable stores', async () => {
    const pg = new PGlite();
    cleanups.push(() => pg.close());
    const exec: SqlExecutor = {
      async query(text, params) {
        const result = await pg.query(text, params ? [...params] : undefined);
        return { rows: result.rows as never[] };
      },
    };
    await createSchema(exec);

    const store = postgresAuthStore({ exec });
    const oauth = invokableOAuth({
      store,
      oauthStore: postgresOAuthStore({ exec }),
      requireSession: () => ({ subject: 'ida@example.com', orgId: 'org_1' }),
      tokenPrefix: 'pgt',
      tokenTtl: 60_000,
    });
    const auth = invokableAuth({ store, requireSession: () => null, tokenPrefix: 'pgt' });
    const server: Server = createServer(
      nodeListener(async (r) => (await auth(r)) ?? (await oauth(r))),
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const { body: client } = await register(url, { token_endpoint_auth_method: 'client_secret_post' });
    const { verifier, challenge } = pkce();
    const { redirect } = await consent(url, {
      response_type: 'code',
      client_id: String(client['client_id']),
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'pg',
      resource: 'https://tool.example/mcp',
    });
    expect(redirect!.searchParams.get('state')).toBe('pg');

    const token = await exchange(url, {
      grant_type: 'authorization_code',
      client_id: String(client['client_id']),
      client_secret: String(client['client_secret']),
      code: redirect!.searchParams.get('code')!,
      code_verifier: verifier,
    });
    expect(token.status).toBe(200);
    expect((await whoami(url, String(token.body['access_token']))).body).toMatchObject({
      subject: 'ida@example.com',
      orgId: 'org_1',
      clientName: 'ChatGPT',
    });

    const replay = await exchange(url, {
      grant_type: 'authorization_code',
      client_id: String(client['client_id']),
      client_secret: String(client['client_secret']),
      code: redirect!.searchParams.get('code')!,
      code_verifier: verifier,
    });
    expect(replay.status).toBe(400);

    const rotated = await exchange(url, {
      grant_type: 'refresh_token',
      client_id: String(client['client_id']),
      client_secret: String(client['client_secret']),
      refresh_token: String(token.body['refresh_token']),
    });
    expect(rotated.status).toBe(200);
    expect((await whoami(url, String(token.body['access_token']))).status).toBe(401);
    expect((await whoami(url, String(rotated.body['access_token']))).status).toBe(200);
  }, 30_000);
});
