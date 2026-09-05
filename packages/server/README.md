# @invokable/server

Self-hostable auth for [invokable](https://github.com/beinvokable/invokable)
tools: the device-code endpoints `@invokable/core`'s `login` command talks to,
and an OAuth 2.1 authorization server for remote MCP clients (ChatGPT, Claude.ai)
that issues the very same tokens.

## Use

```js
import { createServer } from 'node:http';
import { invokableAuth, memoryStore } from '@invokable/server';
import { nodeListener } from '@invokable/server/node';

const handler = invokableAuth({
  store: memoryStore(),                    // swap for a durable store
  tokenPrefix: 'mtl',
  requireSession: (request) => getUserFromCookie(request),  // your login
  approvePage: ({ device, user }) => renderMyBrandedPage(device, user),
  tokenTtl: null,                          // long-lived; revocation only
});

createServer(nodeListener(handler)).listen(8787);
```

`invokableAuth` returns a fetch-style `(Request) => Promise<Response | null>`.
`null` means "not my route", so it composes with your own routing. Hono, Deno and
workers can call it directly; `./node` adapts it to `node:http` and Express
(`expressMiddleware`).

A runnable version is in
[`examples/server`](../../examples/server/server.mjs).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/device/start` | Issues a device code + user code |
| `GET` | `/device?code=…` | The approval page a human sees |
| `POST` | `/device/approve` | Records the decision — **requires a session** |
| `POST` | `/device/token` | Polled by the CLI until approved |
| `GET` | `/cli/whoami` | Identity behind the bearer token |
| `POST` | `/cli/logout` | Revokes the bearer token |

## What it does about security

- **Tokens are stored hashed.** `<prefix>_<32 chars base62>` is returned to the
  client once; only a SHA-256 digest is persisted. A dump of the store does not
  yield working credentials.
- **Device codes are single-use.** Issuing a token marks the device `consumed`,
  so a leaked device code cannot be replayed into a second credential.
- **Polling is rate-limited.** Polling faster than the advertised interval gets
  `slow_down`, not a token.
- **Approval requires a session.** `requireSession` returning null means nothing
  can be approved, and the endpoint answers 401.
- **User codes avoid ambiguous characters** (no `0/O/1/I/L`): they get read aloud
  and typed by hand.

## What it does *not* do — read before deploying

**Device-code phishing is the attack this flow is exposed to.** An attacker
starts a login on their own machine, sends you the code, and asks you to approve
it; the token is then issued to *them*, against *your* identity. Nothing in the
protocol prevents this — the defence is the user recognising a login they did not
start.

The default approval page therefore shows the tool, version, and hostname the
device reported, and says plainly that you should only approve a login you just
started. **If you supply your own `approvePage`, keep that.** A page that shows
only a code and an Approve button is materially less safe.

Also not handled here, and yours to add:

- **CSRF on `/device/approve`.** The handler checks a session, not a CSRF token.
  If you serve the default form-based page from a cookie-authenticated origin,
  add your framework's CSRF protection.
- **Rate limiting on `/device/start`.** Nothing stops an attacker minting device
  codes in bulk.
- **Durable storage** — but `postgresAuthStore()` and `postgresCheckpointStore()`
  are provided; see below. `memoryStore()` is for development only.
- **Audit logging.** The store records who approved what and when; surfacing it
  is the host application's job.

## Remote MCP clients: OAuth 2.1

A CLI signs in with the device flow. ChatGPT, Claude.ai and other hosted MCP
clients cannot run a CLI: they find an authorization server from your MCP
endpoint's metadata, register themselves, send the user through a browser
consent page, and exchange a code for a bearer token. `invokableOAuth` is that
server.

**The token it issues is the same `TokenRecord`, in the same `AuthStore`, as
the device flow.** `/cli/whoami` and `/cli/logout` accept it, and a resource
server that verifies bearer tokens by asking the issuer needs no change. One
backend, two ways in.

```js
import { invokableAuth, invokableOAuth, memoryStore, memoryOAuthStore } from '@invokable/server';

const store = memoryStore();                 // shared: both flows write tokens here
const auth = invokableAuth({ store, tokenPrefix: 'mtl', requireSession });
const oauth = invokableOAuth({
  store,                                     // the SAME store
  oauthStore: memoryOAuthStore(),            // clients, pending grants, refresh tokens
  tokenPrefix: 'mtl',
  requireSession,                            // the same browser session
  consentPage: ({ client, grant, user, requestId }) => renderMyConsentPage(...),
  tokenTtl: 30 * 24 * 60 * 60 * 1000,        // access tokens expire → refresh tokens are issued
});

const handler = async (request) => (await auth(request)) ?? (await oauth(request));
```

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/.well-known/oauth-authorization-server` | RFC 8414 metadata |
| `POST` | `/oauth/register` | RFC 7591 dynamic client registration |
| `GET` | `/oauth/authorize` | Validates the request, records it, renders the consent page |
| `POST` | `/oauth/approve` | Records the decision — **requires a session** — and redirects with a code |
| `POST` | `/oauth/token` | `authorization_code` (PKCE S256, mandatory) and `refresh_token` |
| `POST` | `/oauth/revoke` | RFC 7009 |

`handler.begin(request)` validates and records an authorization request
without rendering, for host applications that draw the consent page
themselves (a React route, say). It returns `{ kind: 'consent', requestId,
client, grant, scopes }`, or `{ kind: 'redirect', location }` for a protocol
error that goes back to a verified client, or `{ kind: 'invalid', status,
message }` when the client or redirect URI could not be verified and nothing
may be redirected.

### What it does about security

- **PKCE is required of every client**, public or confidential. `S256` only.
- **Redirect URIs match exactly** against what the client registered, and a
  registration may only name `https` URIs or `http` on the loopback interface.
  An unknown client or unregistered URI gets a 400 page, never a redirect.
- **Codes are single-use and stored hashed**, valid for ten minutes. A replayed
  code yields nothing; the exchange burns it before minting the token.
- **Refresh tokens rotate.** Using one revokes it and the access token it
  guarded; presenting a rotated-out refresh token again revokes the new access
  token too, on the assumption that someone else holds it.
- **Client secrets are stored hashed**, like tokens.
- **Approval requires a session**, as with the device flow.

Yours to add, as with the device flow: CSRF on `/oauth/approve` when your
consent page is served from a cookie-authenticated origin, and rate limiting on
`/oauth/register`.

### The resource server side

Your tool's MCP endpoint has to tell a client where to sign in. RFC 9728 says
how: a 401 whose `WWW-Authenticate` header points at a metadata document that
names the authorization server.

```js
import { oauthProtectedResource } from '@invokable/server';

const resource = oauthProtectedResource({
  authorizationServers: ['https://auth.invokable.dev'],
  resourcePath: '/mcp',
});

// In your router:
const wellKnown = await resource(request);      // /.well-known/oauth-protected-resource[/mcp]
if (wellKnown) return wellKnown;

// In your MCP handler, when the bearer token is missing or rejected:
return resource.unauthorized(request, { error: 'invalid_token' });
```

It also relays `/.well-known/oauth-authorization-server` from the first
authorization server, for clients that look there instead of following the
protected-resource metadata.

Verifying the token stays yours, and is the same as for CLI callers: ask the
issuer's `/cli/whoami`.
