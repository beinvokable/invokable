# @invokable/server

Self-hostable device-code auth for [invokable](https://github.com/beinvokable/invokable)
tools. Implements the five endpoints `@invokable/core`'s `login` command talks to.

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
[`examples/self-host-auth`](../../examples/self-host-auth/server.mjs).

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
- **Durable storage.** `memoryStore()` loses every token on restart. It is for
  development and tests. A Postgres store is on the roadmap.
- **Audit logging.** The store records who approved what and when; surfacing it
  is the host application's job.
