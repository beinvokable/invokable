# Example server

A complete invokable backend in one file: auth, approval gates, and a fake
deployment API to gate.

```bash
node examples/server/server.mjs     # terminal 1
node examples/server/demo.mjs       # terminal 2 — drives the whole flow
```

The demo signs in, hits an approval gate, approves it, deploys, then shows the
same approval being refused a second time.

## What talks to what

```
  agent / user                  your CLI                    your server
  ────────────                  ────────                    ───────────

  "deploy to prod"  ──────────▶  deploy --env prod
                                      │
                                      │  POST /v1/deploy/plan          ← yours
                                      │◀────── { replicas, credits } ──┘
                                      │
                                      │  POST /checkpoints             ← SDK
                                      │◀────── { fingerprint } ────────┘
                                      │        (HMAC over the plan)
                                      ▼
   ◀── exit 10, status "checkpoint" ──┘
       display + next.approve
       ┌──────────────────┐
       │ DEPLOYMENT PLAN  │  ← shown to the human, verbatim
       │ Cost: 12 credits │
       └──────────────────┘

  "yes"  ─────────────────────▶ deploy … --approve deploy_review@FP
                                      │
                                      │  POST /checkpoints/verify      ← SDK
                                      │◀────── ok ─────────────────────┘
                                      │
                                      │  POST /v1/deploy               ← yours
                                      │  X-Invokable-Checkpoint: …     ← guarded
                                      │◀────── { deployed: true } ─────┘
                                      ▼
   ◀────────── exit 0 ────────────────┘
```

The fingerprint is signed with **your** secret, bound to the plan the user was
shown, and burned by the deploy itself. A second attempt with the same approval
gets exit 12.

## The three things a server provides

Two come from `@invokable/server`. One is yours.

### 1. Auth — `invokableAuth()`

Serves the device-code endpoints `login` talks to: `/device/start`, `/device`,
`/device/approve`, `/device/token`, `/cli/whoami`, `/cli/logout`.

**You must replace `requireSession`.** It runs on the approval page in the
browser and answers "who is signed in right now?" from your existing session —
cookie, JWT, whatever you already have. Returning `null` means signed out, and
nothing can be approved.

```js
requireSession: (request) => getUserFromCookie(request),
```

### 2. Checkpoints — `checkpointRoutes()` and `verifyCheckpoint()`

`checkpointRoutes()` serves `/checkpoints` and `/checkpoints/verify`. The CLI
calls them; you never do.

`verifyCheckpoint()` guards the endpoints that spend. Point it at exactly those:

```js
const requireApproval = verifyCheckpoint({
  verifier,
  requiresApproval: (req) => new URL(req.url).pathname === '/v1/deploy',
  subjectFor: (req) => serviceIdFrom(req),
});
```

Two things bite here:

- **Do not guard the planning endpoint.** The CLI has to fetch a plan before it
  can show the user anything. Guard it and the gate can never open.
- **`subjectFor` must return the same value the CLI passed as `subject`.** It
  binds an approval to one target, so an approval for service A cannot deploy B.
  When they disagree the error names the mismatch:

  ```
  That approval was issued for a different target.
  (issued for subject "svc-1", presented for "svc-2" — the `subject` passed to
  checkpoint() must equal what `subjectFor` returns in verifyCheckpoint())
  ```

### 3. Your API

Whatever your tool calls. This example serves two services, chosen to show the
two shapes billing takes:

| Route | Guarded | Price |
| --- | --- | --- |
| `POST /v1/deploy/plan` | no | — |
| `POST /v1/deploy` | yes | Fixed. Known before the work. |
| `POST /v1/summarize/plan` | no | — |
| `POST /v1/summarize/:planId` | yes | **Not known until the work is done** — it comes from model token usage. |
| `GET /v1/balance` | no | Free. What an agent checks before it plans. |

The second shape is the one most products actually have, and it needs more than
a number: a quoted ceiling rather than a guess, a hold so the balance survives
until the approval is used, capture keyed by the fingerprint so a retry cannot
double-bill, and a decided policy for when the real cost overruns the approved
one. `pricing.mjs` and `ledger.mjs` implement all of that;
[`docs/credits.md`](../../docs/credits.md) explains why each piece is there.

## Mounting in an app you already have

`invokableAuth()` and `checkpointRoutes()` are fetch-style handlers —
`(Request) => Promise<Response | null>`. They return `null` for paths they do
not own, so they compose in any order:

```js
return (await myRoutes(request))
    ?? (await authHandler(request))
    ?? (await checkpointHandler(request));
```

**Express** (or anything on `node:http`):

```js
import { expressMiddleware } from '@invokable/server/node';

app.use(expressMiddleware(authHandler));
app.use(expressMiddleware(checkpointHandler));
```

**Hono, Deno, Workers**: call the handler directly, no adapter needed.

## Before this is production

This example is wired for a laptop. Four things must change:

| What | Here | In production |
|---|---|---|
| `requireSession` | returns a fixed user | your real session lookup |
| `memoryStore()` | lost on restart | a database-backed store |
| `memoryCheckpointStore()` | lost on restart | the same |
| `CHECKPOINT_SECRET` | a literal in the file | your secret manager |

Also add, because the SDK does not:

- **CSRF protection** on `/device/approve` if you serve a cookie-authenticated
  form.
- **Rate limiting** on `/device/start`.

And if you replace the approval page, **keep the part that shows which tool,
version and machine asked to log in, and the warning to approve only a login you
just started.** Device-code phishing — someone sending a user a code and asking
them to approve it — is inherent to this flow, and that display is the only thing
standing against it.

## Rotating the checkpoint secret

Set the old one as `previousSecret` for 24 hours. Approvals issued just before
the swap keep verifying; new ones are signed with the new key.

```js
new CheckpointVerifier({
  secret: process.env.CHECKPOINT_SECRET,
  previousSecret: process.env.CHECKPOINT_SECRET_PREVIOUS,
  store,
});
```
