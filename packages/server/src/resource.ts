/**
 * The resource-server half of remote MCP auth.
 *
 * A hosted MCP client (ChatGPT, Claude.ai, …) that gets a 401 from your MCP
 * endpoint reads the `WWW-Authenticate` header, fetches the protected-resource
 * metadata it points at (RFC 9728), and from there finds the authorization
 * server to send the user to. This module produces both halves so a tool's
 * API can say "sign in at auth.invokable.dev" in the form those clients
 * understand.
 *
 * Nothing here verifies tokens. That stays with the host application, which
 * already asks the issuer (`/cli/whoami`) exactly as it does for CLI callers.
 */

export interface ProtectedResourceOptions {
  /**
   * The resource identifier, e.g. `https://tool.example.com/mcp`. Defaults to
   * the origin of the request plus `resourcePath`.
   */
  resource?: string;
  /** Path of the protected endpoint, used when `resource` is not given. Default `/mcp`. */
  resourcePath?: string;
  /** Issuer URLs of the authorization servers that can grant access, e.g. `https://auth.invokable.dev`. */
  authorizationServers: string[];
  scopesSupported?: string[];
  resourceName?: string;
  resourceDocumentation?: string;
  /**
   * Also answer `/.well-known/oauth-authorization-server` on this origin by
   * relaying the first authorization server's document. Older MCP clients
   * look there instead of following the protected-resource metadata. Default
   * true.
   */
  relayAuthorizationServerMetadata?: boolean;
  /** Injectable fetch, for tests. */
  fetch?: typeof fetch;
}

export interface ProtectedResource {
  /** Serves the well-known documents. Returns null for paths it does not own. */
  (request: Request): Promise<Response | null>;
  /** The RFC 9728 document as it would be served for `origin`. */
  metadata(origin: string): Record<string, unknown>;
  /** The URL clients are pointed at from `WWW-Authenticate`. */
  metadataUrl(origin: string): string;
  /**
   * A 401 that tells an MCP client where to go. `error` is `invalid_token`
   * for a rejected credential and omitted when none was presented.
   */
  unauthorized(request: Request, options?: { error?: string; description?: string }): Response;
}

const WELL_KNOWN_RESOURCE = '/.well-known/oauth-protected-resource';
const WELL_KNOWN_AS = '/.well-known/oauth-authorization-server';

export function oauthProtectedResource(options: ProtectedResourceOptions): ProtectedResource {
  const {
    resource,
    resourcePath = '/mcp',
    authorizationServers,
    scopesSupported = [],
    resourceName,
    resourceDocumentation,
    relayAuthorizationServerMetadata = true,
    fetch: doFetch = fetch,
  } = options;

  if (!authorizationServers.length) {
    throw new Error('oauthProtectedResource: at least one authorization server is required.');
  }
  const servers = authorizationServers.map((s) => s.replace(/\/+$/, ''));

  function resourceFor(origin: string): string {
    return resource ?? `${origin}${resourcePath}`;
  }

  function metadata(origin: string): Record<string, unknown> {
    return {
      resource: resourceFor(origin),
      authorization_servers: servers,
      bearer_methods_supported: ['header'],
      ...(scopesSupported.length ? { scopes_supported: scopesSupported } : {}),
      ...(resourceName ? { resource_name: resourceName } : {}),
      ...(resourceDocumentation ? { resource_documentation: resourceDocumentation } : {}),
    };
  }

  function metadataUrl(origin: string): string {
    // RFC 9728 §3.1: a resource with a path gets a path-suffixed well-known URL.
    let path = '';
    try {
      path = new URL(resourceFor(origin)).pathname.replace(/\/+$/, '');
    } catch {
      path = '';
    }
    return `${origin}${WELL_KNOWN_RESOURCE}${path === '/' ? '' : path}`;
  }

  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
  };

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors },
    });
  }

  function unauthorized(
    request: Request,
    opts: { error?: string; description?: string } = {},
  ): Response {
    const origin = new URL(request.url).origin;
    const parts = [`resource_metadata="${metadataUrl(origin)}"`];
    if (opts.error) parts.push(`error="${opts.error}"`);
    if (opts.description) parts.push(`error_description="${opts.description.replace(/"/g, "'")}"`);
    return new Response(
      JSON.stringify({
        error: opts.error ?? 'unauthorized',
        message: opts.description ?? 'A bearer token is required.',
        resource_metadata: metadataUrl(origin),
      }),
      {
        status: 401,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'www-authenticate': `Bearer ${parts.join(', ')}`,
          ...cors,
        },
      },
    );
  }

  const handle = async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method.toUpperCase();

    const isResource = path.startsWith(WELL_KNOWN_RESOURCE);
    const isAs = relayAuthorizationServerMetadata && path.startsWith(WELL_KNOWN_AS);
    if (!isResource && !isAs) return null;

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405);

    if (isResource) return json(metadata(url.origin));

    // Relay rather than redirect: a redirect from a well-known URL is something
    // several clients refuse to follow.
    try {
      const upstream = await doFetch(`${servers[0]}${WELL_KNOWN_AS}`, {
        headers: { accept: 'application/json' },
      });
      if (!upstream.ok) return json({ error: 'upstream_unavailable' }, 502);
      return json(await upstream.json());
    } catch {
      return json({ error: 'upstream_unavailable' }, 502);
    }
  } as ProtectedResource;

  handle.metadata = metadata;
  handle.metadataUrl = metadataUrl;
  handle.unauthorized = unauthorized;
  return handle;
}
