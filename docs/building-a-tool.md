# Building an MCP tool on invokable

**The complete guide, for a developer or for the agent working on their behalf.**

This document takes one small product from nothing to a published tool that
works from a coding agent's terminal, from ChatGPT, and from Claude.ai, billed
to one account. Every code block is real, every input and output is shown, and
every place where invokable has an opinion is called out and explained.

It is in two parts:

- **Part 1: Hosted.** You use `auth.invokable.dev` for sign-in. You write your
  API, your credits, and your tools. This is the fast path.
- **Part 2: Self-hosted.** You run the auth server too. It goes further than
  invokable's own scope, into how to wire your session, your database and your
  billing, because that is where self-hosting actually succeeds or fails.

The reference appendices at the end cover the output contract, exit codes,
HTTP mappings, every endpoint, and every environment variable.

---

## 0. What you are building

### The shape

```
   the agent                    your tool                        the servers
  ┌───────────────┐      ┌───────────────────────┐      ┌─────────────────────────┐
  │ Claude Code   │ runs │ CLI  (@invokable/core) │ HTTP │ YOUR API                │
  │ Codex, Cursor │─────▶│  polish rewrite …      │─────▶│  /v1/rewrite            │
  │ Gemini CLI    │      │  one JSON doc + exit   │      │  /v1/balance            │
  └───────────────┘      └───────────────────────┘      │  /checkpoints  (SDK)    │
         │ launches                                      │  /mcp          (HTTP)   │
         ▼                                               └────────────┬────────────┘
  ┌───────────────┐      ┌───────────────────────┐                   │ verifies tokens
  │ MCP client    │ stdio│ MCP server (same tools)│ HTTP              ▼
  │ (any)         │─────▶│  polish-mcp            │─────▶  ┌─────────────────────────┐
  └───────────────┘      └───────────────────────┘        │ AUTH SERVER             │
                                                          │ auth.invokable.dev, or  │
  ┌───────────────┐  HTTPS + OAuth                        │ yours (@invokable/server)│
  │ ChatGPT       │─────────────────────────────▶ /mcp    │  /device/*  (CLI login) │
  │ Claude.ai     │                                       │  /oauth/*   (ChatGPT)   │
  └───────────────┘                                       │  /cli/whoami            │
                                                          └─────────────────────────┘
```

Three doors, one account:

| Door | Who uses it | How it signs in | What it talks to |
|---|---|---|---|
| CLI | coding agents on the user's machine | `polish login` (device code, browser approval) | your API over HTTPS |
| MCP over stdio | MCP clients on the user's machine | reuses the CLI's token from `~/.polish/config.json` | your API |
| MCP over HTTP | ChatGPT, Claude.ai, hosted clients | OAuth 2.1 in the browser | your `/mcp` endpoint |

All three end with the same kind of bearer token, verified the same way, so
your API has one auth check and one credits ledger.

### The five packages

| Package | You use it for |
|---|---|
| `@invokable/core` | the CLI runtime: output envelope, exit codes, options schema, `login`/`logout`/`whoami`/`doctor`, `checkpoint()` |
| `@invokable/server` | the server side: device-flow endpoints, OAuth 2.1 server, checkpoint issuing and verification, Postgres stores, protected-resource metadata |
| `@invokable/skills` | `init`: generates `SKILL.md` and installs it for every agent |
| `@invokable/conformance` | `invokable-test`: checks your CLI honours the contract |
| `create-invokable` | scaffolds a project |

All share one version. This guide is written against **0.4.0**.

### The contract, in one paragraph

With `--json`, a command writes **exactly one JSON document to stdout** and
exits with a **semantic code**. The document is one of three shapes:
`{"status":"ok","data":…}` (exit 0), `{"status":"error","code":…,"message":…,
"remediation":…,"retryable":…}` (exit 1 to 20), or
`{"status":"checkpoint",…}` (exit 10, an approval is needed). Progress, logs
and warnings go to stderr. Every error names the literal next command to run.
That is the whole contract, and the runtime enforces it: while a command runs,
`process.stdout.write` is redirected to stderr, so nothing can corrupt the
document.

### The example product

**polish**: rewrites text in a clearer voice. Two tools, chosen because they
are the two shapes every product has:

| Tool | CLI command | MCP tool | Cost |
|---|---|---|---|
| Balance | `polish balance` | `get_balance` | free |
| Rewrite | `polish rewrite --text "…"` | `rewrite_text` | 50 credits, approval gate on the CLI |

A new account gets 500 credits on first sign-in.

---

# Part 1: Hosted

`auth.invokable.dev` handles sign-in for you: GitHub login, the device-code
approval page, the OAuth consent page, token storage, revocation. You never
see a password or a GitHub token. What you get back for any bearer token is a
**subject**: the user's GitHub numeric id, stable across username changes.

## 1.1 Prerequisites

- Node 20 or later, npm.
- A place to host an HTTPS API (Vercel, Fly, a VPS, anything). The examples
  use plain Node and Next.js; the SDK is framework-agnostic.
- Postgres (Neon works well on serverless). Needed for checkpoints and for
  your credits.
- An npm account, because the CLI is published **publicly**: `npx polish init`
  fetches unauthenticated.

## 1.2 Scaffold

```console
$ npx create-invokable polish --command rewrite --spends --auth hosted
Created ./polish

  polish/
    package.json
    tsconfig.json
    src/tool.ts
    bin/polish.mjs
    README.md
    .gitignore
    .github/workflows/ci.yml

  cd polish && npm install && npm run build
  node bin/polish.mjs --help
```

What it gave you:

- `src/tool.ts`: the tool definition with `init` and a gated `rewrite`
  command against `https://api.polish.example.com`.
- `bin/polish.mjs`: three lines, `await cli(tool)`.
- CI that runs the conformance check and `init --check`.

The scaffold does **not** include an MCP server. Sections 1.5 and 1.7 add it.
Nothing about MCP is generated because the tool list is yours; the adapter is
small enough to read.

## 1.3 The tool definition

Replace `src/tool.ts` with the real thing. Read the comments; they are the
opinions.

```ts
// src/tool.ts
import { checkpoint, command, defineTool } from '@invokable/core';
import { initCommand } from '@invokable/skills';

import pkg from '../package.json' with { type: 'json' };

/** What /v1/rewrite/plan returns. Declared, not inferred: client.post() returns unknown. */
interface RewritePlan {
  id: string;
  words: number;
  credits: number;
  balance: number;
}

interface BalanceResponse {
  balance: number;
  costs: Record<string, number>;
  recent: { delta: number; reason: string; balanceAfter: number; createdAt: string }[];
}

export default defineTool({
  name: 'polish',
  version: pkg.version,
  description: 'Rewrites text in a clearer voice. Costs credits per rewrite.',

  api: {
    // Overridable so a developer can point the CLI at a local server without
    // touching code. `connect` (1.6) bakes the resolved value into .mcp.json.
    baseUrl: process.env.POLISH_API ?? 'https://api.polish.example.com',
    // Hosted: sign-in lives here. Self-host (Part 2): your own server.
    authUrl: process.env.POLISH_AUTH ?? 'https://auth.invokable.dev',
  },

  // Overridable so a second environment gets its own token instead of
  // overwriting the one you are signed in with.
  configDir: process.env.POLISH_CONFIG_DIR ?? '~/.polish',

  // `--yes` on a spending command is refused unless `--max-spend <n>` is also
  // given. An agent that wants to skip the prompt must state a ceiling.
  requireSpendLimit: true,

  commands: {
    // Installs SKILL.md into the project for every agent. login, logout,
    // whoami and doctor are built in and need no declaration.
    init: initCommand(),

    balance: command({
      description: 'Show the remaining credit balance and what each tool costs. Free.',
      run: async ({ client }) => client.get<BalanceResponse>('/v1/balance'),
    }),

    rewrite: command({
      description: 'Rewrite text in a clearer voice. Costs 50 credits and stops for approval first.',
      options: {
        text: {
          type: 'string',
          required: true,
          short: 't',
          description: 'The text to rewrite.',
        },
        tone: {
          type: 'string',
          choices: ['plain', 'warm', 'formal'],
          description: 'Voice to aim for. Default plain.',
        },
      },
      // Marks the command as spending money: SKILL.md warns the agent, and
      // --yes is refused without --max-spend (requireSpendLimit above).
      spends: true,
      run: async ({ opts, client, ctx }) => {
        // 1. Plan: free, changes nothing, produces what the user will approve.
        //    Must be idempotent (same text → same plan id); see 1.4.
        const plan = await client.post<RewritePlan>('/v1/rewrite/plan', {
          text: opts.text,
          tone: opts.tone ?? 'plain',
        });

        ctx.io.note(`${plan.words} words, ${plan.credits} credits`); // stderr

        // 2. Gate: exits 10 with status "checkpoint" unless --approve carries a
        //    fingerprint your server issued for exactly this plan.
        await checkpoint(ctx, {
          gate: 'rewrite_review',
          title: 'rewrite',
          summary: { planId: plan.id, words: plan.words, tone: opts.tone ?? 'plain' },
          subject: plan.id,
          question: `Rewrite ${plan.words} words for ${plan.credits} credits?`,
          explain: 'Approving charges the account and runs the rewrite.',
          spend: { estimated: plan.credits, balance: plan.balance },
        });

        // 3. Do it. The runtime attaches the approval as a header; your API
        //    consumes it here, once.
        return client.post(`/v1/rewrite/${encodeURIComponent(plan.id)}`, {});
      },
    }),
  },
});
```

```console
$ npm run build
$ node bin/polish.mjs --help
polish 0.1.0
Rewrites text in a clearer voice. Costs credits per rewrite.

Usage: polish <command> [options]

Commands:
  login    Sign in and store a token for this machine.
  logout   Revoke the stored token and delete it from this machine.
  whoami   Show the identity behind the stored token.
  doctor   Diagnose configuration, connectivity and auth.
  init     Install agent instructions for this tool into the current project.
  balance  Show the remaining credit balance and what each tool costs. Free.
  rewrite  Rewrite text in a clearer voice. Costs 50 credits and stops for approval first.  $

Global options:
      --json                     Emit one JSON envelope on stdout.
      --yes                      Auto-approve gates (audited server-side).
      --max-spend <number>       Cap spend; overrides --yes.
      --approve <gate@fp>        Supply an approval fingerprint.
      --token <token>            Override the stored token (visible in ps).
  -h, --help                     Show this help.
  -V, --version                  Show the version.

$ marks commands that can spend money.
```

`--help --json` returns the same information as a manifest: every command,
option, type, `choices`, `required` and `spends`. The MCP adapter in 1.5 could
be generated from it; `examples/mcp/server.mjs` in the invokable repo does
exactly that.

### What the runtime does for you

| You wrote | The agent sees |
|---|---|
| `return { … }` | `{"status":"ok","data":{…}}`, exit 0 |
| `client.get()` got a 402 | `{"status":"error","code":"insufficient_spend",…}`, exit 4 |
| `client.get()` got a 401 | `{"status":"error","code":"auth","remediation":"polish login"}`, exit 3 |
| `await checkpoint(…)` with no approval | `{"status":"checkpoint",…}`, exit 10 |
| `console.log('debug')` inside a dependency | nothing on stdout; it went to stderr |
| a thrown `Error` | `{"status":"error","code":"error","message":…}`, exit 1 |

The full mapping is in Appendix B.

### The commands you did not write

```console
$ node bin/polish.mjs doctor --json
{"status":"ok","data":{
  "tool":{"name":"polish","version":"0.1.0"},
  "api":{"baseUrl":"https://api.polish.example.com","authUrl":"https://auth.invokable.dev","reachable":true,"latencyMs":142},
  "auth":{"ok":false,"source":"none","tokenPrefix":null,"error":"No token stored."},
  "config":{"path":"/Users/ido/.polish/config.json","exists":false,"source":"none","worldReadable":false,"envVar":"POLISH_TOKEN"},
  "skills":{"checked":false,"installed":null},
  "agent":"claude-code"}}
```

`doctor` exits 0 and reports rather than fails, even when a check is red: an
error envelope carries one message, and the report is the useful part. Read
`data.auth.ok` and `data.api.reachable`.

`doctor` is what an agent runs first. `auth.ok: false` means "tell the user
to run `polish login`", and the generated SKILL.md says exactly that, including
**do not run `login` yourself, it opens a browser and waits**.

```console
$ node bin/polish.mjs login

  To finish signing in to polish, open:

    https://auth.invokable.dev/device?code=WXYZ-2345

  and confirm this code:  WXYZ-2345

  Waiting for approval…

Signed in. Token stored in /Users/ido/.polish/config.json (mode 0600).
```

The token is `ivk_` plus 32 characters. Only its SHA-256 is stored at
auth.invokable.dev. `~/.polish/` is `0700`, the file `0600`, written
atomically.

```console
$ node bin/polish.mjs whoami --json
{"status":"ok","data":{"subject":"10985125","orgId":null,"tokenPrefix":"ivk",
 "clientName":"polish","hostname":"Idos-MacBook-Pro.local","createdAt":"2026-09-05T15:02:11.000Z"}}
```

`subject` is the GitHub numeric user id. It is what your API keys accounts on.
Without a token, `whoami` is `{"status":"error","code":"auth","message":"Not signed in.","remediation":"polish login"}`, exit 3.

## 1.4 Your API

Your API has to do four things. The SDK does the fourth.

1. **Verify the bearer token** by asking the issuer.
2. **Find or create the account** for the subject, and grant signup credits once.
3. **Charge credits atomically**, and refund when the work fails after the charge.
4. **Issue and consume approval fingerprints** for gated commands (`checkpointRoutes`, `verifyCheckpoint`).

The examples below are Next.js App Router route handlers on Vercel with Neon,
because that is what `demo-invokeable` runs and it is fully worked there. The
same functions run unchanged under plain `node:http` with
`nodeListener` from `@invokable/server/node`, or under Hono.

### 1.4.1 Verify the token

```ts
// src/lib/invokable.ts
const AUTH_URL = (process.env.INVOKABLE_AUTH_URL ?? 'https://auth.invokable.dev').replace(/\/+$/, '');
const TTL_MS = 60_000;

export interface InvokableIdentity {
  subject: string;
  orgId?: string;
  raw: Record<string, unknown>;
}

const cache = new Map<string, { at: number; identity: InvokableIdentity | null }>();

export function bearerFrom(request: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '');
  return m ? m[1]!.trim() : null;
}

/** Asks the issuer who a token belongs to. Cached for a minute: an MCP session makes many small calls. */
export async function verifyInvokableToken(token: string): Promise<InvokableIdentity | null> {
  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.identity;

  let identity: InvokableIdentity | null = null;
  try {
    const res = await fetch(`${AUTH_URL}/cli/whoami`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      cache: 'no-store',
    });
    if (res.ok) {
      const body = (await res.json()) as Record<string, unknown>;
      if (typeof body['subject'] === 'string') {
        identity = {
          subject: body['subject'],
          ...(typeof body['orgId'] === 'string' ? { orgId: body['orgId'] } : {}),
          raw: body,
        };
      }
    }
  } catch {
    return null; // network failure is not a rejection; do not cache it
  }
  cache.set(token, { at: Date.now(), identity });
  return identity;
}
```

What `/cli/whoami` returns for a good token:

```http
GET /cli/whoami HTTP/1.1
Host: auth.invokable.dev
Authorization: Bearer ivk_k3Jd9…

HTTP/1.1 200 OK
{"subject":"10985125","orgId":null,"tokenPrefix":"ivk","clientName":"polish",
 "hostname":"Idos-MacBook-Pro.local","createdAt":"2026-09-05T15:02:11.000Z"}
```

And for a revoked, expired or unknown one:

```http
HTTP/1.1 401 Unauthorized
{"error":"unauthorized","message":"Token rejected."}
```

`clientName` is `polish` for a CLI login and `ChatGPT` for an OAuth grant;
`hostname` is the machine or the client's redirect host (`chatgpt.com`). Log
them. Do not branch on them: the account is the subject, whichever door.

### 1.4.2 The auth gate every route uses

```ts
// src/lib/api-auth.ts
import { bearerFrom, verifyInvokableToken } from './invokable';
import { upsertFromInvokable, type Account } from './accounts';
import { fail } from './http';

export async function authenticate(request: Request): Promise<{ account: Account } | { response: Response }> {
  const token = bearerFrom(request);
  if (!token) return { response: fail(401, 'auth', 'No bearer token was supplied.', 'polish login') };

  const identity = await verifyInvokableToken(token);
  if (!identity) {
    return { response: fail(401, 'auth', 'That token was rejected by the issuer. It may have been revoked.', 'polish login') };
  }
  return { account: await upsertFromInvokable(identity) };
}
```

The error body shape is what makes the CLI's exit codes work. `@invokable/core`
reads `code`, `message` and `remediation` off the body and maps the status:

```ts
// src/lib/http.ts
export function ok(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
}

export function fail(status: number, code: string, message: string, remediation?: string): Response {
  return Response.json(
    { error: code, code, message, ...(remediation ? { remediation } : {}) },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

/** 402 is what the CLI turns into exit 4, `insufficient_spend`. */
export function insufficientCredits(needed: number, balance: number): Response {
  return fail(402, 'insufficient_spend', `This costs ${needed} credits and the balance is ${balance}.`, 'polish balance');
}
```

**Every error carries a `remediation`.** It is the literal next command. An
agent that gets `{"code":"auth","remediation":"polish login"}` stops and tells
the user to run it. One without a remediation guesses.

### 1.4.3 Accounts and credits

Schema. Balance in its own row so a deduction is a single conditional
`UPDATE`; an append-only ledger; a partial unique index that makes the signup
grant happen exactly once no matter how many doors race.

```sql
create table if not exists users (
  id                bigserial primary key,
  invokable_subject text unique not null,       -- the GitHub numeric id from whoami
  invokable_org_id  text,
  created_at        timestamptz not null default now()
);

create table if not exists credits (
  user_id    bigint primary key references users(id) on delete cascade,
  balance    integer not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists credit_ledger (
  id            bigserial primary key,
  user_id       bigint not null references users(id) on delete cascade,
  delta         integer not null,
  reason        text    not null,
  balance_after integer not null,
  metadata      jsonb   not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists credit_ledger_user_idx on credit_ledger (user_id, created_at desc);

-- Exactly one signup grant per user, enforced by the database, not by code.
create unique index if not exists credit_ledger_one_signup_grant
  on credit_ledger (user_id) where reason = 'signup_grant';
```

Functions. Each is one statement with a CTE so the balance and the ledger row
that explains it cannot disagree, and so two concurrent calls cannot both
succeed against a balance that only covers one.

```ts
// src/lib/accounts.ts
export const SIGNUP_GRANT = 500;

export async function upsertFromInvokable(identity: InvokableIdentity): Promise<Account> {
  const [row] = await sql(
    `insert into users (invokable_subject, invokable_org_id) values ($1, $2)
     on conflict (invokable_subject) do update set invokable_org_id = excluded.invokable_org_id
     returning id`,
    [identity.subject, identity.orgId ?? null],
  );
  const id = Number(row.id);
  await grantSignupCredits(id);
  return accountById(id);
}

/** Idempotent: `on conflict do nothing` makes the CTE empty on a repeat, so nothing is inserted twice. */
async function grantSignupCredits(userId: number): Promise<void> {
  await sql(
    `with created as (
       insert into credits (user_id, balance) values ($1, $2)
       on conflict (user_id) do nothing
       returning balance
     )
     insert into credit_ledger (user_id, delta, reason, balance_after, metadata)
     select $1, $2, 'signup_grant', created.balance, '{"source":"signup"}'::jsonb from created`,
    [userId, SIGNUP_GRANT],
  );
}

/**
 * `balance >= $2` in the WHERE clause is the whole concurrency story: Postgres row-locks
 * the UPDATE, so two simultaneous 50-credit calls against 60 credits cannot both match.
 */
export async function spendCredits(userId: number, amount: number, reason: string, metadata = {}): Promise<{ ok: boolean; balance: number }> {
  if (amount === 0) return { ok: true, balance: (await accountById(userId)).balance };
  const rows = await sql(
    `with deducted as (
       update credits set balance = balance - $2, updated_at = now()
       where user_id = $1 and balance >= $2
       returning balance
     )
     insert into credit_ledger (user_id, delta, reason, balance_after, metadata)
     select $1, -$2, $3, deducted.balance, $4::jsonb from deducted
     returning balance_after`,
    [userId, amount, reason, JSON.stringify(metadata)],
  );
  if (!rows[0]) return { ok: false, balance: (await accountById(userId)).balance };
  return { ok: true, balance: Number(rows[0].balance_after) };
}

/** Put credits back when the work they paid for did not happen. */
export async function refundCredits(userId: number, amount: number, reason: string): Promise<number> {
  const rows = await sql(
    `with restored as (
       update credits set balance = balance + $2, updated_at = now() where user_id = $1 returning balance
     )
     insert into credit_ledger (user_id, delta, reason, balance_after, metadata)
     select $1, $2, $3, restored.balance, '{"refund":true}'::jsonb from restored
     returning balance_after`,
    [userId, amount, reason],
  );
  return Number(rows[0]?.balance_after ?? 0);
}
```

### 1.4.4 Checkpoints: the routes the SDK serves

`checkpoint()` in the CLI posts to **your API**, not to the auth server. The
fingerprint is an HMAC computed with a secret that never leaves your
deployment. That is the point: if the agent could compute it from the plan it
was shown, it could forge `--approve`.

```ts
// src/lib/checkpoints.ts
import { CheckpointVerifier, checkpointRoutes, postgresCheckpointStore, type SqlExecutor } from '@invokable/server';
import { neon } from '@neondatabase/serverless';

const executor: SqlExecutor = {
  async query(text, params) {
    const rows = await neon(process.env.DATABASE_URL!).query(text, params ? [...params] : []);
    return { rows: rows as never[] };
  },
};

export const verifier = new CheckpointVerifier({
  secret: process.env.CHECKPOINT_SECRET!,                  // openssl rand -hex 32
  previousSecret: process.env.CHECKPOINT_SECRET_PREVIOUS,  // during rotation, 24h
  store: postgresCheckpointStore({ exec: executor }),      // NOT memory: serverless has no shared memory
});

export const routes = checkpointRoutes({
  verifier,
  // Binds a fingerprint to the caller that requested it. Supply it in production.
  identify: async (request) => {
    const token = bearerFrom(request);
    return token ? (await verifyInvokableToken(token))?.subject ?? null : null;
  },
});
```

```ts
// app/checkpoints/route.ts  and  app/checkpoints/verify/route.ts
import { routes } from '@/lib/checkpoints';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  return (await routes(request)) ?? new Response('Not found', { status: 404 });
}
```

Run the schema once, on boot or from a migration; it is idempotent:

```ts
import { createSchema } from '@invokable/server';
await createSchema(executor);   // CREATE TABLE IF NOT EXISTS invokable_checkpoints, and the auth tables you do not use in hosted mode
```

Purge expired rows daily (`purgeExpired(executor)`), for example from a Vercel
cron. Nothing depends on it for correctness; the tables just grow otherwise.

### 1.4.5 The two rewrite routes

Planning is free and unguarded. Spending consumes the approval and charges.

```ts
// app/v1/rewrite/plan/route.ts
import { createHash } from 'node:crypto';
export const dynamic = 'force-dynamic';
const COST = 50;

export async function POST(request: Request) {
  const auth = await authenticate(request);
  if ('response' in auth) return auth.response;

  const { text = '', tone = 'plain' } = await request.json().catch(() => ({}));
  if (!text.trim()) return fail(400, 'usage', '`text` is required.');

  // Idempotent on purpose: the approved run is a fresh process that calls this
  // again before presenting its approval. A new id each time would make the
  // approval (bound to the first id) fail as "different target".
  const id = 'rw_' + createHash('sha256').update(JSON.stringify([auth.account.id, tone, text])).digest('hex').slice(0, 16);
  await savePlan(id, auth.account.id, { text, tone });

  return ok({ id, words: text.trim().split(/\s+/).length, credits: COST, balance: auth.account.balance });
}
```

```ts
// app/v1/rewrite/[id]/route.ts
import { verifyCheckpoint } from '@invokable/server';
export const dynamic = 'force-dynamic';
const COST = 50;

// Rejects with a 409 the CLI turns into exit 12 when the approval is missing,
// stale, expired, for another gate, or already used. Returns null when good.
const requireApproval = verifyCheckpoint({
  verifier,
  requiresApproval: () => true,
  subjectFor: (request) => decodeURIComponent(new URL(request.url).pathname.split('/').pop()!),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(request);
  if ('response' in auth) return auth.response;

  const rejected = await requireApproval(request);
  if (rejected) return rejected;

  const { id } = await params;
  const plan = await loadPlan(id, auth.account.id);
  if (!plan) return fail(404, 'not_found', 'No such plan.', 'polish rewrite --text "…"');

  // Charge before the work so nobody gets the answer and then fails to pay.
  const spend = await spendCredits(auth.account.id, COST, 'tool:rewrite', { planId: id });
  if (!spend.ok) return insufficientCredits(COST, spend.balance);

  try {
    const rewritten = await rewriteWithModel(plan.text, plan.tone);
    return ok({ rewritten, charged: COST, balance: spend.balance });
  } catch (error) {
    // The work did not happen; the charge must not stand.
    const balance = await refundCredits(auth.account.id, COST, 'refund:rewrite');
    return fail(502, 'error', `The rewrite failed. No credits were charged; the balance is ${balance}.`);
  }
}
```

The approval arrives as a header the runtime adds:

```http
POST /v1/rewrite/rw_3f9a1c… HTTP/1.1
Authorization: Bearer ivk_k3Jd9…
X-Invokable-Checkpoint: rewrite_review@7c1e5b9d2a4f8036
```

`verifyCheckpoint` checks that the fingerprint exists, was issued for gate
`rewrite_review` and subject `rw_3f9a1c…`, is not expired, and has not been
consumed. Then it consumes it in one `UPDATE … WHERE consumed = FALSE`
statement, so a retried request cannot bill twice.

### 1.4.6 The balance route

```ts
// app/v1/balance/route.ts
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const auth = await authenticate(request);
  if ('response' in auth) return auth.response;
  return ok({ balance: auth.account.balance, costs: { rewrite_text: 50, get_balance: 0 }, recent: await recentLedger(auth.account.id, 10) });
}
```

Free, and always answerable. The generated instructions tell the agent to
call it to explain a refusal instead of retrying.

### 1.4.7 What the CLI conversation now looks like

```console
$ polish rewrite --text "Our Q3 numbers were not what we hoped for." --json
12 words, 50 credits                                         # stderr
{"status":"checkpoint","schema":"invokable.checkpoint/v1","gate":"rewrite_review",
 "fingerprint":"7c1e5b9d2a4f8036",
 "display":"┌──────────…┐\n│ REWRITE   …\n│ { \"planId\": \"rw_3f9a1c…\", \"words\": 12, \"tone\": \"plain\" }\n│ Cost: 50 credits\n│ Balance after: 450 credits\n│ Approving charges the account and runs the rewrite.\n│ Rewrite 12 words for 50 credits?\n└──────────…┘",
 "question":"Rewrite 12 words for 50 credits?",
 "explain":"Approving charges the account and runs the rewrite.",
 "spend":{"estimated":50,"balance":500},
 "next":{"approve":"polish rewrite --text \"Our Q3 numbers were not what we hoped for.\" --json --approve rewrite_review@7c1e5b9d2a4f8036"}}
$ echo $?
10
```

`display` is a pre-rendered panel, safe to print to a human as-is:

```
┌──────────────────────────────────────────────────────────────────┐
│ REWRITE                                                          │
├──────────────────────────────────────────────────────────────────┤
│ {                                                                │
│   "planId": "rw_3f9a1c",                                         │
│   "words": 12,                                                   │
│   "tone": "plain"                                                │
│ }                                                                │
│                                                                  │
│ Cost: 50 credits                                                 │
│ Balance after: 450 credits                                       │
│                                                                  │
│ Approving charges the account and runs the rewrite.              │
│                                                                  │
│ Rewrite 12 words for 50 credits?                                 │
└──────────────────────────────────────────────────────────────────┘
```

The agent prints it verbatim, asks the user, and only then runs
`next.approve`:

```console
$ polish rewrite --text "Our Q3 numbers were not what we hoped for." --json --approve rewrite_review@7c1e5b9d2a4f8036
{"status":"ok","data":{"rewritten":"Q3 fell short of our targets.","charged":50,"balance":450}}
$ echo $?
0
```

Run the same approve command again:

```console
$ polish rewrite --text "…" --json --approve rewrite_review@7c1e5b9d2a4f8036
{"status":"error","code":"checkpoint_stale","message":"This approval was already used.",
 "remediation":"Re-run the command without --approve to get a fresh plan.","retryable":false}
$ echo $?
12
```

Out of credits:

```console
$ polish rewrite --text "…" --json --approve rewrite_review@…
{"status":"error","code":"insufficient_spend","message":"This costs 50 credits and the balance is 20.",
 "remediation":"polish balance","retryable":false}
$ echo $?
4
```

`--yes` without a ceiling, because of `requireSpendLimit`:

```console
$ polish rewrite --text "…" --json --yes
{"status":"error","code":"usage","message":"\"rewrite\" can spend money, and this tool requires --max-spend alongside --yes.",
 "remediation":"polish rewrite --text \"…\" --json --yes --max-spend <number>","retryable":false}
$ echo $?
2
$ polish rewrite --text "…" --json --yes --max-spend 100
auto-approved rewrite_review@7c1e5b9d2a4f8036 because --yes was passed. The server records this as an approval.   # stderr
{"status":"ok","data":{"rewritten":"Q3 fell short of our targets.","charged":50,"balance":450}}
$ polish rewrite --text "…" --json --yes --max-spend 20
--yes did not auto-approve rewrite_review: estimated 50 exceeds --max-spend 20.   # stderr
{"status":"checkpoint",…}
$ echo $?
10
```

With `--yes --max-spend`, the CLI still requests a fingerprint and consumes
it in the same run. Your server sees a normal approved operation in the
audit trail; `--yes` never bypasses the gate on the server.

## 1.5 The MCP server (stdio)

The same two tools, for MCP clients on the user's machine. Three rules:

1. **A separate binary.** `@invokable/core` diverts `process.stdout` to
   stderr while a CLI command runs. An MCP stdio server writes JSON-RPC to
   stdout for its whole life. They cannot share a process, so `polish-mcp` is
   its own entry point that never calls `cli()`.
2. **Same token file.** Read it through the SDK's `ConfigStore` and
   `resolveToken`, so the `--token` / `POLISH_TOKEN` / config-file precedence
   is identical in both processes.
3. **Nothing but JSON-RPC on stdout.** Diagnostics go to `console.error`;
   MCP clients show them as server logs.

```jsonc
// package.json (additions)
{
  "bin": { "polish": "./bin/polish.mjs", "polish-mcp": "./bin/polish-mcp.mjs" },
  "exports": {
    ".": "./dist/tool.js",
    "./mcp": "./dist/mcp.js",
    "./http": "./dist/http.js"
  },
  "dependencies": {
    "@invokable/core": "^0.4.0",
    "@invokable/skills": "^0.4.0",
    "@modelcontextprotocol/sdk": "^1.30.0",
    "zod": "^3.25.0"
  }
}
```

```ts
// src/config.ts — the values both processes must agree on
export const TOOL_NAME = 'polish';
export const MCP_BIN = `${TOOL_NAME}-mcp`;
const PREFIX = TOOL_NAME.toUpperCase().replace(/-/g, '_');
export const ENV = { api: `${PREFIX}_API`, auth: `${PREFIX}_AUTH`, token: `${PREFIX}_TOKEN`, configDir: `${PREFIX}_CONFIG_DIR` } as const;
export const API_BASE = (process.env[ENV.api] ?? 'https://api.polish.example.com').replace(/\/+$/, '');
export const CONFIG_DIR = process.env[ENV.configDir] ?? `~/.${TOOL_NAME}`;
export const COSTS = { rewrite_text: 50, get_balance: 0 } as const;
```

```ts
// src/mcp-api.ts — how every tool reaches your API
import { ConfigStore, resolveToken } from '@invokable/core';
import pkg from '../package.json' with { type: 'json' };
import { API_BASE, CONFIG_DIR, ENV, TOOL_NAME } from './config.js';

class ToolFailure extends Error {
  constructor(message: string, readonly remediation?: string) { super(message); }
}

function currentToken(): string | undefined {
  const store = new ConfigStore(CONFIG_DIR);
  return resolveToken({ toolName: TOOL_NAME, config: store.read() }).token;
}

export interface Api { call<T>(path: string, init?: { method: string; body: unknown }): Promise<T>; }

/**
 * `token` is a callback because the two transports disagree only on this:
 * stdio reads the file `polish login` wrote; HTTP (1.7) is handed the bearer
 * token of the request it is serving.
 */
export function createApi(options: { token: () => string | undefined; baseUrl?: string; surface?: 'mcp' | 'mcp-remote' }): Api {
  const baseUrl = (options.baseUrl ?? API_BASE).replace(/\/+$/, '');
  const surface = options.surface ?? 'mcp';
  const signInHint = surface === 'mcp'
    ? `Run \`npx ${TOOL_NAME} login\` in a terminal, then try again.`
    : `Reconnect the ${TOOL_NAME} connector to sign in again.`;

  return {
    async call<T>(path: string, init?: { method: string; body: unknown }): Promise<T> {
      const token = options.token();
      if (!token) throw new ToolFailure(`Not signed in to ${TOOL_NAME}.`, signInHint);

      let response: Response;
      try {
        response = await fetch(`${baseUrl}${path}`, {
          method: init?.method ?? 'GET',
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            ...(init ? { 'content-type': 'application/json' } : {}),
            'x-invokable-client': `${TOOL_NAME}/${pkg.version}`,
            'x-invokable-surface': surface,
          },
          ...(init ? { body: JSON.stringify(init.body) } : {}),
        });
      } catch (error) {
        throw new ToolFailure(`Could not reach the ${TOOL_NAME} API at ${baseUrl}.`, `Check that the API is running and ${ENV.api} points at it.`);
      }
      const body = (await response.json().catch(() => ({}))) as { message?: string; remediation?: string };
      if (!response.ok) {
        throw new ToolFailure(body.message ?? `The API returned ${response.status}.`, body.remediation ?? (response.status === 401 ? signInHint : undefined));
      }
      return body as T;
    },
  };
}

/** MCP has no error envelope of its own, so failures are text plus isError. Keep the remediation. */
export function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const remediation = error instanceof ToolFailure ? error.remediation : undefined;
  return { isError: true, content: [{ type: 'text' as const, text: remediation ? `${message}\n\n${remediation}` : message }] };
}

export function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

const localApi = createApi({ token: currentToken });
export const call: Api['call'] = (path, init) => localApi.call(path, init);
```

```ts
// src/mcp.ts — the tools, transport-agnostic
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };
import { API_BASE, COSTS, TOOL_NAME } from './config.js';
import { call as localCall, failure, text, type Api } from './mcp-api.js';

export function createServer(api: Api = { call: localCall }): McpServer {
  const server = new McpServer({ name: TOOL_NAME, version: pkg.version });
  const { call } = api;

  server.registerTool(
    'get_balance',
    {
      title: 'Get credit balance',
      description: 'Remaining credits, the price of each tool, and recent movements. Free. Call this to explain a refusal.',
      inputSchema: {},
    },
    async () => {
      try { return text(await call('/v1/balance')); } catch (e) { return failure(e); }
    },
  );

  server.registerTool(
    'rewrite_text',
    {
      title: 'Rewrite text',
      // The description is the approval gate over MCP: hosted clients have no
      // elicitation, so the model must be told to ask before spending.
      description:
        `Rewrites text in a clearer voice. Costs ${COSTS.rewrite_text} credits per call, charged to the ` +
        'signed-in account. Tell the user the cost and get their OK before calling this. ' +
        'If the rewrite fails, nothing is charged.',
      inputSchema: {
        text: z.string().min(1).max(20_000).describe('The text to rewrite.'),
        tone: z.enum(['plain', 'warm', 'formal']).optional().describe('Voice to aim for. Default plain.'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ text: body, tone }) => {
      try {
        // Two calls, same as the CLI: plan, then act. No checkpoint header: the
        // MCP client (or the model) owns the approval on this surface.
        const plan = await call<{ id: string }>('/v1/rewrite/plan', { method: 'POST', body: { text: body, tone } });
        return text(await call(`/v1/rewrite/${encodeURIComponent(plan.id)}`, { method: 'POST', body: {} }));
      } catch (e) {
        return failure(e);
      }
    },
  );

  return server;
}

export async function main(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
  console.error(`${TOOL_NAME} MCP server ready (api: ${API_BASE})`);
}
```

```js
// bin/polish-mcp.mjs — deliberately NOT cli()
#!/usr/bin/env node
import { main } from '../dist/mcp.js';
await main();
```

**On the checkpoint header over MCP.** The CLI's `rewrite` carries an approval
fingerprint; the MCP `rewrite_text` does not. Your `/v1/rewrite/:id` route
above requires one. Choose one of two policies and state it in the code:

- *Consume when present, do not require* (what `demo-invokeable` does):
  replace `requireApproval` with `parseCheckpointHeader` and consume only if
  the header exists. MCP callers rely on the client's own per-call approval
  UI and the tool description. This is the practical choice: invokable's
  gate is an audit and usability mechanism, not a sandbox; an agent that
  ignores its instructions can pass `--yes` on the CLI regardless.
- *Require always*: the MCP tool then has to obtain a fingerprint itself by
  posting to `/checkpoints` and returning it to the model as a two-step
  approval. More work, one code path. Not shown here.

```ts
// The "consume when present" version of the spending route
import { parseCheckpointHeader, staleResponse } from '@invokable/server';

const approval = parseCheckpointHeader(request.headers.get('x-invokable-checkpoint'));
if (approval) {
  const verified = await verifier.consume({ gate: approval.gate, subject: id, fingerprint: approval.fingerprint });
  if (!verified.ok) return staleResponse(verified.reason ?? 'not_found', `polish rewrite --text "…"`, verified.detail);
}
```

### Try it

```console
$ npm run build
$ npx @modelcontextprotocol/inspector node bin/polish-mcp.mjs
```

Or with any client:

```jsonc
// .mcp.json (Claude Code) / .cursor/mcp.json / .vscode/mcp.json
{ "mcpServers": { "polish": { "command": "npx", "args": ["-y", "-p", "polish", "polish-mcp"] } } }
```

What a tool call looks like on the wire, so you know what "works" means:

```jsonc
// → tools/call
{ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
  "params": { "name": "rewrite_text", "arguments": { "text": "Our Q3 numbers were not what we hoped for." } } }

// ← result
{ "jsonrpc": "2.0", "id": 3, "result": { "content": [ { "type": "text",
  "text": "{\n  \"rewritten\": \"Q3 fell short of our targets.\",\n  \"charged\": 50,\n  \"balance\": 450\n}" } ] } }

// ← when not signed in
{ "jsonrpc": "2.0", "id": 3, "result": { "isError": true, "content": [ { "type": "text",
  "text": "Not signed in to polish.\n\nRun `npx polish login` in a terminal, then try again." } ] } }
```

## 1.6 `connect` and `verify`

Two CLI commands that make the stdio path self-installing. Neither is in the
SDK; `demo-invokeable/packages/credmcp/src/connect.ts` and `verify.ts` are
complete implementations to copy. The behaviour to keep:

**`connect`** writes the server entry into every project-scoped MCP config
(`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`), merging with other
servers already there. It never touches global files (`~/.claude.json`,
`~/.codex/config.toml`): rewriting a file shared by everything the user runs
is how you corrupt somebody's whole setup over a formatting difference.
`--print` outputs the block instead.

```console
$ polish connect
created: .mcp.json  (Claude Code)
created: .cursor/mcp.json  (Cursor)
created: .vscode/mcp.json  (VS Code)
Reload your MCP client, then run: polish verify

$ polish connect --print --json
{"status":"ok","data":{"printed":true,"server":{"command":"npx","args":["-y","-p","polish","polish-mcp"],"env":{"POLISH_API":"https://api.polish.example.com"}}}}
```

Add `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json` to `.gitignore`: when
run from a clone they contain absolute paths.

**`verify`** starts the MCP server **exactly as `.mcp.json` says to**, does
`initialize` → `tools/list` → `tools/call get_balance`, and reports. It
reports rather than fails (exit 0, `data.ok`), because an error envelope
carries only one message and would throw away the check list. `--strict`
turns a failing check into a non-zero exit for CI.

```console
$ polish verify
  ✓ signed in              token from config
  ✓ api reachable          https://api.polish.example.com — balance 450
  ✓ mcp registered         .mcp.json → npx -y -p polish polish-mcp
  ✓ mcp handshake          2 tools; get_balance returned 450.

  Everything is connected.

$ polish verify --strict --json; echo $?
{"status":"error","code":"mcp_handshake","message":"mcp handshake: Could not start \"npx\": spawn ENOENT","remediation":"polish connect"}
32
```

Custom exit codes live in 30 to 99. `assertCustomExitCode` rejects anything
below 30.

## 1.7 MCP over HTTP: ChatGPT and Claude.ai

Hosted clients cannot run `npx`. They speak Streamable HTTP to a URL and
obtain a token through OAuth. Nothing in your tools changes; two things
change around them.

### 1.7.1 The handler

```ts
// src/http.ts
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createApi } from './mcp-api.js';
import { createServer } from './mcp.js';

/**
 * Stateless on purpose: every request builds a server and a transport and
 * discards them. On serverless, the request that initialised a session and the
 * request that calls a tool land on different workers.
 *
 * Auth is the caller's job: verify the token first, then pass it here.
 */
export async function handleMcpRequest(request: Request, options: { token: string; apiBase: string }): Promise<Response> {
  const api = createApi({ token: () => options.token, baseUrl: options.apiBase, surface: 'mcp-remote' });
  const server = createServer(api);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,   // stateless
    enableJsonResponse: true,        // one JSON document per call; nothing here streams
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  }
}
```

### 1.7.2 The route, and the 401 that gives directions

```ts
// src/lib/remote.ts
import { oauthProtectedResource } from '@invokable/server';

export const remoteResource = oauthProtectedResource({
  authorizationServers: ['https://auth.invokable.dev'],
  resourcePath: '/mcp',
  resourceName: 'polish',
});
```

```ts
// app/mcp/route.ts
import { handleMcpRequest } from 'polish/http';
import { bearerFrom, verifyInvokableToken } from '@/lib/invokable';
import { remoteResource } from '@/lib/remote';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function serve(request: Request): Promise<Response> {
  const token = bearerFrom(request);
  if (!token) return remoteResource.unauthorized(request);

  const identity = await verifyInvokableToken(token);
  if (!identity) return remoteResource.unauthorized(request, { error: 'invalid_token', description: 'The token was rejected by the issuer.' });

  // The tools call this same deployment; deriving the origin from the request
  // makes a preview deployment call itself rather than production.
  return handleMcpRequest(request, { token, apiBase: new URL(request.url).origin });
}

export const GET = serve;
export const POST = serve;
export const DELETE = serve;
export function OPTIONS() {
  return new Response(null, { status: 204, headers: {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id',
  } });
}
```

```ts
// app/.well-known/oauth-protected-resource/[[...path]]/route.ts
// app/.well-known/oauth-authorization-server/route.ts        (same file body)
import { remoteResource } from '@/lib/remote';
export const dynamic = 'force-dynamic';
async function serve(request: Request) {
  return (await remoteResource(request)) ?? Response.json({ error: 'not_found' }, { status: 404 });
}
export const GET = serve;
export const OPTIONS = serve;
```

If your web app bundles server code (Next.js does), keep the SDK and your
package out of the bundle:

```js
// next.config.mjs
export default { serverExternalPackages: ['polish', '@modelcontextprotocol/sdk'] };
```

### 1.7.3 What the client sees

```http
POST /mcp HTTP/1.1
Host: api.polish.example.com

HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://api.polish.example.com/.well-known/oauth-protected-resource/mcp"
{"error":"unauthorized","message":"A bearer token is required.","resource_metadata":"https://api.polish.example.com/.well-known/oauth-protected-resource/mcp"}
```

```http
GET /.well-known/oauth-protected-resource/mcp HTTP/1.1

HTTP/1.1 200 OK
{"resource":"https://api.polish.example.com/mcp","authorization_servers":["https://auth.invokable.dev"],
 "bearer_methods_supported":["header"],"resource_name":"polish"}
```

From there the client goes to `auth.invokable.dev`:

```
GET  /.well-known/oauth-authorization-server      → endpoints, PKCE S256, registration_endpoint
POST /oauth/register                              → {"client_id":"oc_…", …}   (ChatGPT registers itself)
GET  /oauth/authorize?client_id=oc_…&code_challenge=…&redirect_uri=https://chatgpt.com/…
                                                  → the user signs in with GitHub and clicks Allow
POST /oauth/token  (code + code_verifier)         → {"access_token":"ivk_…","token_type":"Bearer","expires_in":2592000,"refresh_token":"ivkr_…"}
POST /mcp  Authorization: Bearer ivk_…            → your route verifies it via /cli/whoami, exactly as for the CLI
```

The access token is the same `ivk_` kind the CLI gets. It expires after 30
days; the client refreshes it silently. Disconnecting the connector revokes
it.

### 1.7.4 Connecting

| Client | Where | Values |
|---|---|---|
| ChatGPT | Settings → Connectors → Create (Developer mode on) | URL `https://api.polish.example.com/mcp`, Auth: OAuth, client id and secret empty |
| Claude.ai | Settings → Connectors → Add custom connector | same URL |
| MCP Inspector or any OAuth-capable local client | | same URL; loopback redirects are accepted |

### 1.7.5 Verifying a deployment

```console
$ curl -si -X POST https://api.polish.example.com/mcp -H 'content-type: application/json' -d '{}' | grep -i www-authenticate
www-authenticate: Bearer resource_metadata="https://api.polish.example.com/.well-known/oauth-protected-resource/mcp"

$ curl -s https://api.polish.example.com/.well-known/oauth-protected-resource/mcp | jq .authorization_servers
["https://auth.invokable.dev"]

$ curl -s https://auth.invokable.dev/.well-known/oauth-authorization-server | jq .registration_endpoint
"https://auth.invokable.dev/oauth/register"
```

A test against the handler without a browser, using a CLI token:

```console
$ TOKEN=$(node -e "console.log(require(process.env.HOME+'/.polish/config.json').token)")
$ curl -s https://api.polish.example.com/mcp -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[].name'
"get_balance"
"rewrite_text"
```

A CLI token works on the HTTP endpoint because it is the same token kind.
That is the property everything else rests on.

## 1.8 Agent instructions

`polish init` (the `initCommand()` you declared) generates one portable
`SKILL.md` from the tool schema and installs it wherever agents look:

```console
$ polish init
created: .claude/skills/polish/SKILL.md
created: .claude/skills/polish/references/commands.md
created: .claude/skills/polish/references/errors.md
created: .claude/skills/polish/references/checkpoints.md
created: .codex/skills/polish/SKILL.md
created: .codex/skills/polish/references/…            (the same four files)
created: .cursor/skills/polish/SKILL.md …
created: .gemini/skills/polish/SKILL.md …
created: .agents/skills/polish/SKILL.md …
created: AGENTS.md
created: CLAUDE.md                                     (contains @AGENTS.md, so the text is not loaded twice)
created: .github/copilot-instructions.md
created: .cursor/rules/polish.mdc
```

The `SKILL.md` is byte-identical in every skills directory. `AGENTS.md`,
`copilot-instructions.md` and the `.mdc` get a short section between
`<!-- invokable:begin polish -->` and `<!-- invokable:end polish -->`; nothing
outside those markers is touched, so the file can hold other tools' sections.
Running `init` again reports `unchanged` per file, or `updated` after a schema
change.

The generated `SKILL.md` tells the agent to run `doctor` first, to have the
user run `login`, to always pass `--json`, how to read the three statuses,
which commands spend, never to pass `--yes`, and never to retry exits 4, 7 or
20. It is regenerated from the schema, so it cannot drift from the commands.
Text you add between `<!-- invokable:custom -->` … `<!-- /invokable:custom -->`
survives regeneration.

Add the MCP setup to the description so an agent finds it: the description is
what triggers skill loading.

```ts
init: initCommand(),
// and in defineTool:
description:
  'Rewrites text in a clearer voice, billed in credits. Setup is three commands in order: ' +
  '`polish init`, then `polish login` (the user runs this; it opens a browser), then `polish connect`.',
```

In CI, `polish init --check` exits **30** when the schema changed and the
instructions were not regenerated.

## 1.9 Conformance and CI

```console
$ npx invokable-test node bin/polish.mjs
invokable conformance — node bin/polish.mjs
  ✓ `--version --json` returns a valid ok envelope
  ✓ `--help --json` returns a command manifest
      7 commands
  ✓ An unknown command exits 2 with an error envelope
  ✓ A bare invocation does not exit 0
      exit 2
  ✓ `doctor --json` reports auth and config state
  ✓ Every exit code is reserved or in 30-99
      0 (ok), 2 (usage)
  ✓ `--json` puts exactly one JSON document on stdout
  ✓ No credential-shaped strings on stdout
  ✓ Errors carry a `remediation`
  9 passed
```

It runs the binary as an agent would, without a token and without a network,
so it fits in CI with no secrets.

```yaml
# .github/workflows/ci.yml
- run: npm ci
- run: npm run build
- run: npx invokable-test node bin/polish.mjs
- run: node bin/polish.mjs init --check
- run: npm run test:http          # node --test 'test/**/*.test.mjs' — the HTTP MCP handler against a fake API
```

For the HTTP handler test, drive `handleMcpRequest` with the SDK's own client
and a custom `fetch`; `demo-invokeable/packages/credmcp/test/http.test.mjs` is
a complete example that checks the tool list, the forwarded token, the
`mcp-remote` surface header, error shape on a rejected token, and that no
session id is issued.

## 1.10 Publishing

1. The API is deployed and `POLISH_API`'s default in `src/config.ts` points at
   it. **The npm package bakes this in.** A published default of `localhost`
   is a package nobody can use.
2. `npm publish --access public`. Scoped or not, it must be public: `npx`
   fetches unauthenticated.
3. Test as a stranger: in an empty directory,
   `npx polish init && npx polish login && npx polish connect && npx polish verify`.
4. Add the connector in ChatGPT and call `get_balance`.

## 1.11 The whole thing, end to end

A new user, a coding agent, and ChatGPT, on one account:

```console
# The user, in a project
$ npx polish init
created: .claude/skills/polish/SKILL.md …

# The agent, reading SKILL.md
$ polish doctor --json
{"status":"ok","data":{…,"auth":{"ok":false,"source":"none"}}}
# → "Please run `polish login` in your terminal."

# The user
$ polish login
To sign in, open: https://auth.invokable.dev/device?code=WXYZ-2345 …
Signed in.

# The agent
$ polish connect --json && polish verify --json
{"status":"ok","data":{"ok":true,"checks":[…]}}
$ polish balance --json
{"status":"ok","data":{"balance":500,"costs":{"rewrite_text":50,"get_balance":0},"recent":[{"delta":500,"reason":"signup_grant","balanceAfter":500,"createdAt":"…"}]}}
$ polish rewrite --text "…" --json
{"status":"checkpoint",…,"next":{"approve":"polish rewrite --text \"…\" --json --approve rewrite_review@7c1e…"}}
# → shows the panel, asks, user says yes
$ polish rewrite --text "…" --json --approve rewrite_review@7c1e…
{"status":"ok","data":{"rewritten":"…","charged":50,"balance":450}}

# The user, in ChatGPT: add connector https://api.polish.example.com/mcp, OAuth, Allow.
# ChatGPT: "What is my polish balance?" → get_balance → 450.
```

One account, one ledger, two doors.

---

# Part 2: Self-hosted

You run the auth server. Everything in Part 1 still applies; this part is
what you take over and what you must get right.

## 2.1 What you take over

| Concern | Hosted | Self-hosted |
|---|---|---|
| Who the user is | GitHub via auth.invokable.dev; subject is the GitHub id | **your** login; subject is whatever your session says |
| Device-flow endpoints | served for you | `invokableAuth(...)` mounted in your server |
| OAuth for ChatGPT | served for you | `invokableOAuth(...)` mounted in your server |
| Token storage | theirs | `postgresAuthStore` and `postgresOAuthStore` in your Postgres |
| Token verification in your API | HTTP call to `/cli/whoami` | the same HTTP call to your own `/cli/whoami`, or a direct store lookup |
| The approval and consent pages | theirs, branded | yours; two hard rules in 2.3 |
| Checkpoints, credits, your tools | yours | yours, unchanged |

The CLI changes by one line: `authUrl` points at you. The MCP HTTP path
changes by one string: `authorizationServers: ['https://auth.polish.example.com']`.

Run the auth server on its own origin (`auth.polish.example.com`) or inside
the API app. Both work. Separate origins keep the session cookie of your
login off the API, which is cleaner; one app is less to deploy. `cloud`
(the hosted service) is a standalone Next.js app on Vercel and is the
reference for the separate-origin layout.

## 2.2 The session hook

Both `invokableAuth` and `invokableOAuth` take one function:

```ts
requireSession: (request: Request) => SessionUser | null | Promise<SessionUser | null>
// SessionUser = { subject: string; orgId?: string; displayName?: string }
```

It answers "who is signed in in this browser right now?" from **your** login:
a signed cookie, a JWT, a framework session. Returning `null` means signed
out, and nothing can be approved. The `subject` it returns becomes the
`subject` on every token and therefore what your API keys accounts on.
Choose something stable: a numeric user id, never an email that can change.

```ts
// Example: a signed cookie you already have
import { sessionFromRequest } from './session';

const requireSession = (request: Request) => {
  const session = sessionFromRequest(request);   // verifies the HMAC, checks expiry
  if (!session) return null;
  return { subject: String(session.userId), displayName: session.name };
};
```

If you have no login yet, `cloud/src/lib/session.ts` is a complete one in
150 lines: a signed cookie, GitHub OAuth for the browser, CSRF tokens
derived from the session, and an OAuth state cookie. Copy it.

## 2.3 The two pages, and the two rules

**Rule 1: the device approval page must show what is being approved.**
Device-code phishing is inherent to the flow: an attacker starts a login on
their machine, sends the victim the code, and asks them to approve it. The
protocol cannot prevent it. The only defence is the person recognising a
login they did not start. So the page shows the tool, version and hostname
the device reported, and says plainly that a code someone sent you is an
attack. If you replace the default page, keep all of that.

**Rule 2: the approve endpoints need CSRF protection.** `requireSession`
checks there is a session; it cannot know whether the form was submitted from
your page or from a link on another site, and the session cookie rides along
on a cross-site POST. Without a CSRF token, one link makes a signed-in user
approve an attacker's device or client. The SDK leaves this to you because it
does not know your session; `cloud` derives the token from the session with
an HMAC so nothing needs storing.

The consent page for OAuth is lower risk (the code goes back to the client's
registered URL, not to whoever holds a code), but it is still an identity
grant: show the application name and where it returns to.

## 2.4 The auth server

A complete one, on plain Node with Postgres. Under Next.js, mount the same
handler in route files the way `cloud` does.

```ts
// auth-server.ts
import { createServer } from 'node:http';
import {
  createSchema,
  invokableAuth,
  invokableOAuth,
  postgresAuthStore,
  postgresOAuthStore,
  purgeExpired,
  type SqlExecutor,
} from '@invokable/server';
import { nodeListener } from '@invokable/server/node';
import pg from 'pg';
import { requireSession, renderApprovePage, renderConsentPage, verifyCsrf } from './session.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const exec: SqlExecutor = {
  async query(text, params) {
    const r = await pool.query(text, params ? [...params] : []);
    return { rows: r.rows };
  },
};
await createSchema(exec);   // idempotent: invokable_devices, invokable_tokens, invokable_checkpoints, invokable_oauth_*

const store = postgresAuthStore({ exec });   // ONE token store for both flows

const auth = invokableAuth({
  store,
  tokenPrefix: 'pol',
  tokenTtl: null,                  // CLI tokens: long-lived, revoked by `logout`
  requireSession,
  approvePage: renderApprovePage,  // keep tool/version/hostname and the warning (2.3)
});

const oauth = invokableOAuth({
  store,                                   // the SAME store
  oauthStore: postgresOAuthStore({ exec }),
  tokenPrefix: 'pol',
  tokenTtl: 30 * 24 * 60 * 60 * 1000,      // remote clients: 30 days, refreshed silently
  refreshTokenTtl: null,                   // refresh tokens rotate on use and are revocable
  issuer: 'https://auth.polish.example.com',
  requireSession,
  consentPage: renderConsentPage,
  scopesSupported: [],                     // add scopes only if your API enforces them
});

createServer(
  nodeListener(async (request) => {
    const url = new URL(request.url);

    // CSRF on the two approve endpoints, before the SDK sees them (2.3).
    if (request.method === 'POST' && (url.pathname === '/device/approve' || url.pathname === '/oauth/approve')) {
      const form = await request.clone().formData().catch(() => null);
      const session = await requireSession(request);
      if (!session || !form || !verifyCsrf(session, form.get('csrf')?.toString())) {
        return Response.json({ error: 'forbidden', message: 'Stale form. Reload and try again.' }, { status: 403 });
      }
    }

    return (await auth(request)) ?? (await oauth(request)) ?? Response.json({ error: 'not_found' }, { status: 404 });
  }),
).listen(8787);

// Housekeeping, daily: expired device codes, checkpoints and OAuth grants.
setInterval(() => purgeExpired(exec).catch(console.error), 24 * 60 * 60 * 1000);
```

What it now serves:

```
POST /device/start           the CLI asks for a code
GET  /device?code=…          the approval page (your renderApprovePage)
POST /device/approve         records the decision (session + CSRF)
POST /device/token           the CLI polls until approved
GET  /cli/whoami             identity behind a bearer token   ← your API calls this
POST /cli/logout             revokes a token

GET  /.well-known/oauth-authorization-server
POST /oauth/register         ChatGPT / Claude.ai register themselves
GET  /oauth/authorize        the consent page (your renderConsentPage)
POST /oauth/approve          records the decision (session + CSRF), redirects with a code
POST /oauth/token            code → token (PKCE), refresh → new token
POST /oauth/revoke
```

A device-flow exchange, so you can recognise it in logs:

```http
POST /device/start
{"clientName":"polish","hostname":"Idos-MacBook-Pro.local","toolVersion":"0.1.0"}
→ {"deviceCode":"9f3c…","userCode":"WXYZ-2345","verificationUri":"https://auth.polish.example.com/device",
   "verificationUriComplete":"https://auth.polish.example.com/device?code=WXYZ-2345","interval":5,"expiresIn":900}

POST /device/token   {"deviceCode":"9f3c…"}
→ 400 {"error":"authorization_pending"}          (until approved; "slow_down" if polled too fast)
→ 200 {"token":"pol_…","tokenPrefix":"pol","orgId":null,"subject":"42","webOrigin":"https://auth.polish.example.com"}
```

The device code is burned on issue: a second `/device/token` with the same
code gets `expired_token`, never a second credential.

### Tokens

`<prefix>_<32 base62 chars>`. Only the SHA-256 is stored. `tokenTtl: null`
means long-lived with revocation only; a number means expiry. With
`invokableOAuth`, refresh tokens are issued only when access tokens expire.
Both flows write to `invokable_tokens`:

```
token_hash | token_prefix | subject | org_id | client_name | hostname    | created_at | expires_at | revoked_at
-----------+--------------+---------+--------+-------------+-------------+------------+------------+-----------
3a9f…      | pol          | 42      |        | polish      | Idos-Mac…   | 1757…      | NULL       | NULL
b71c…      | pol          | 42      |        | ChatGPT     | chatgpt.com | 1757…      | 1760…      | NULL
```

## 2.5 Verifying tokens in your API

Two options. Pick one and use it everywhere.

**Option A: ask your own `/cli/whoami`.** Identical to the hosted code in
1.4.1 with `INVOKABLE_AUTH_URL=https://auth.polish.example.com`. Works
across processes and languages; costs one HTTP round trip per uncached
token, so keep the one-minute cache.

**Option B: read the store directly.** When the API and the auth server share
a database and a process, skip the HTTP hop:

```ts
import { hashToken } from '@invokable/server';

export async function verifyToken(token: string): Promise<{ subject: string; orgId?: string } | null> {
  const record = await store.findTokenByHash(hashToken(token));
  if (!record || record.revokedAt) return null;
  if (record.expiresAt !== null && record.expiresAt <= Date.now()) return null;
  return { subject: record.subject, ...(record.orgId ? { orgId: record.orgId } : {}) };
}
```

Those three checks (exists, not revoked, not expired) are exactly what
`/cli/whoami` does. Do not add a fourth by reading `client_name`: a token
from ChatGPT and a token from the CLI are equally good.

## 2.6 Credits, in full

Part 1 gave the schema and the atomic functions. Self-hosting means you own
the whole policy, so here is the rest.

### The three moments

| Moment | What happens | Route |
|---|---|---|
| Quote | compute the price, show the balance, hold nothing or hold the ceiling | `/v1/rewrite/plan` (free, idempotent) |
| Approve | the user sees cost and balance, your server issues a fingerprint | `/checkpoints` (SDK) |
| Charge | consume the fingerprint, deduct, do the work, refund on failure | `/v1/rewrite/:id` |

### Fixed prices

The 1.4.5 code is complete. Charge before the work; refund if the work fails.

### Dynamic prices (model calls)

When the cost is not known until the work is done, quote a **ceiling**, hold
it, charge the actual amount, release the difference. Three rules:

1. **The plan route must be idempotent.** Derive the plan id from the request
   content, so the approved run (a new process) gets the same id and the same
   hold instead of a second hold.
2. **The approval fingerprint is your idempotency key for the charge.** It
   names exactly one approved operation and is on the request already. A
   retried charge with the same fingerprint returns the first result.
3. **Decide the overrun policy in advance**: cap at the approved ceiling and
   absorb the difference, or fail having charged nothing. Silently charging
   more than was approved is not an option.

```sql
-- holds, for dynamic prices
create table if not exists credit_holds (
  id         text primary key,                 -- the plan id
  user_id    bigint not null references users(id) on delete cascade,
  amount     integer not null check (amount > 0),
  state      text not null default 'held',     -- held | captured | released
  created_at timestamptz not null default now()
);
```

```ts
/** Available = balance minus open holds. Show THIS to the user, not the raw balance. */
export async function available(userId: number): Promise<number> {
  const [row] = await sql(
    `select c.balance - coalesce((select sum(amount) from credit_holds h where h.user_id = c.user_id and h.state = 'held'), 0) as available
     from credits c where c.user_id = $1`, [userId]);
  return Number(row?.available ?? 0);
}

/** Idempotent: the same plan id returns the same hold. Refuses if available < amount. */
export async function hold(planId: string, userId: number, amount: number): Promise<boolean> {
  const rows = await sql(
    `insert into credit_holds (id, user_id, amount)
     select $1, $2, $3 where (select available from ...) >= $3   -- inline the available() query
     on conflict (id) do update set id = excluded.id
     returning id`, [planId, userId, amount]);
  return rows.length === 1;
}

/** Capture the actual cost (≤ held), release the rest, write one ledger row keyed by the fingerprint. */
export async function capture(planId: string, actual: number, fingerprint: string): Promise<{ charged: number; balanceAfter: number }> {
  const [existing] = await sql(`select balance_after, -delta as charged from credit_ledger where metadata->>'fingerprint' = $1`, [fingerprint]);
  if (existing) return { charged: Number(existing.charged), balanceAfter: Number(existing.balance_after) };   // retried request

  const rows = await sql(
    `with h as (update credit_holds set state = 'captured' where id = $1 and state = 'held' returning user_id, amount),
          d as (update credits set balance = balance - least($2, h.amount) from h where credits.user_id = h.user_id returning credits.balance, h.user_id, least($2, h.amount) as charged)
     insert into credit_ledger (user_id, delta, reason, balance_after, metadata)
     select user_id, -charged, 'tool:rewrite', balance, jsonb_build_object('fingerprint', $3::text, 'planId', $1::text) from d
     returning -delta as charged, balance_after`, [planId, actual, fingerprint]);
  if (!rows[0]) throw new Error('hold not found or already captured');
  return { charged: Number(rows[0].charged), balanceAfter: Number(rows[0].balance_after) };
}
```

`invokable/docs/credits.md` goes deeper: counting tokens with the provider's
counter, pricing cache reads, where rates live, and the exact wording to show
a user who approved 20 and was charged 7.

### Refuse before you ask

If the quote already exceeds what is available, answer **402
`insufficient_spend`** from the plan route. The CLI exits 4 before any
approval prompt. Never let a user approve something you already know you
cannot honour.

### Give the agent a way to look

`/v1/balance` is free and returns the price list. The generated SKILL.md tells
the agent to call it to explain a refusal instead of retrying. Keep it cheap
and never rate-limit it below what an agent's loop needs.

## 2.7 The functions you must implement

The complete inventory. Everything else is the SDK's.

| Function | Where | Required for | What it must do |
|---|---|---|---|
| `requireSession(request)` | auth server | both flows | resolve your browser session to `{ subject, displayName? }` or `null` |
| `approvePage(ctx)` | auth server | device flow | render tool, version, hostname, code, the warning, Approve/Deny form with CSRF |
| `consentPage(ctx)` or `oauth.begin()` + your page | auth server | OAuth | render client name, return host, scopes, Allow/Deny form with CSRF |
| CSRF check on `/device/approve` and `/oauth/approve` | auth server | both | reject a POST whose token does not match the session |
| `verifyToken(token)` | API | everything | Option A or B in 2.5 |
| `upsertAccount(subject)` | API | everything | find or create the account, grant signup credits once |
| `spendCredits`, `refundCredits` | API | tools that cost | atomic, with a ledger row in the same statement |
| `hold`, `available`, `capture` | API | dynamic prices | 2.6 |
| plan route per gated command | API | CLI gates | free, idempotent, returns `{ id, credits, balance, … }` |
| action route per gated command | API | CLI gates | `verifyCheckpoint` or `parseCheckpointHeader` + consume, charge, work, refund |
| `/checkpoints`, `/checkpoints/verify` | API | CLI gates | `checkpointRoutes({ verifier, identify })` |
| `/v1/balance` | API | agents | free; balance, prices, recent ledger |
| `/mcp` | API | ChatGPT etc. | 1.7.2 with `authorizationServers: [your auth origin]` |
| `/.well-known/oauth-protected-resource[/mcp]` | API | ChatGPT etc. | `oauthProtectedResource(...)` |
| schema + `createSchema(exec)` on boot | both | everything | your tables plus the SDK's |
| `purgeExpired(exec)` daily | auth server | hygiene | delete expired device codes, checkpoints, OAuth grants |
| secret management | both | security | `CHECKPOINT_SECRET`, `SESSION_SECRET`, DB URL; rotation via `CHECKPOINT_SECRET_PREVIOUS` |

## 2.8 Security checklist

- [ ] Tokens are only ever stored hashed (the SDK does this; do not log the plaintext from `/device/token` or `/oauth/token`).
- [ ] The device approval page shows tool, version, hostname and the phishing warning.
- [ ] CSRF tokens on both approve endpoints.
- [ ] `requireSession` verifies a signature, not just the presence of a cookie.
- [ ] Rate limiting on `POST /device/start` and `POST /oauth/register`; the SDK does not do it.
- [ ] `CHECKPOINT_SECRET` is at least 32 bytes and never leaves the API deployment.
- [ ] Postgres stores in production; `memoryStore()` only in tests. A login started on one instance and polled on another never completes with memory.
- [ ] The spending route consumes the fingerprint in the same request that charges (`verifyCheckpoint` does), and the charge is idempotent on the fingerprint.
- [ ] `/v1/balance` and plan routes never mutate.
- [ ] OAuth redirect URIs are exact-match and https or loopback only (the SDK enforces this in registration; keep it if you pre-register clients with `clients: [...]`).
- [ ] `cache-control: no-store` on every auth, checkpoint and MCP response.

## 2.9 Operations

| Task | How |
|---|---|
| Rotate the checkpoint secret | set `CHECKPOINT_SECRET_PREVIOUS` to the old value, deploy, remove it after 24 hours |
| Revoke a user's CLI token | `POST /cli/logout` with the token, or set `revoked_at` on the row |
| Revoke a ChatGPT connection | the user disconnects the connector (it calls `/oauth/revoke`), or set `revoked_at` |
| See who is signed in from where | `select subject, client_name, hostname, created_at from invokable_tokens where revoked_at is null` |
| Housekeeping | `purgeExpired(exec)` daily; nothing depends on it for correctness |
| Preview deployments | `issuer` fixed to the canonical auth origin, or metadata advertises the preview URL |
| Monitor | 401 rate on `/cli/whoami` (revoked tokens in use), 409 rate on spend routes (stale approvals), 402 rate (users out of credits) |

---

# Appendix A: The output contract

Exactly one JSON document on stdout with `--json`. Three shapes:

```jsonc
{ "status": "ok", "data": <anything> }                                         // exit 0

{ "status": "error", "code": "<exit name or custom slug>", "message": "…",
  "remediation": "<literal next command>", "retryable": false }                // exit 1–20, 30–99

{ "status": "checkpoint", "schema": "invokable.checkpoint/v1", "gate": "…",
  "fingerprint": "…", "display": "<ASCII panel>", "question": "…", "explain": "…",
  "spend": { "estimated": 50, "balance": 500, "currency": "credits" },
  "choices": [ { "id": "…", "label": "…", "recommended": true } ],
  "next": { "approve": "<command> --approve <gate>@<fp>", "reject": "<command>" } }   // exit 10
```

| Exit | Name | Meaning | Agent should |
|---|---|---|---|
| 0 | ok | | use `data` |
| 1 | error | generic failure | read `retryable` |
| 2 | usage | bad arguments | fix the command |
| 3 | auth | no or rejected token | tell the user to run `login` |
| 4 | insufficient_spend | not enough credits | stop; never retry; suggest `balance` |
| 5 | not_found | | use `remediation` |
| 6 | conflict | | |
| 7 | rate_limited | | stop; never retry in a loop |
| 10 | checkpoint_pending | approval needed | show `display`, ask, run `next.approve` |
| 11 | timeout | | may retry |
| 12 | checkpoint_stale | approval expired, used, or for another plan | re-run without `--approve` |
| 15 | network | | may retry |
| 20 | declined | the user said no | stop |
| 30–99 | tool-defined | | per SKILL.md |

Global flags: `--json`, `--yes` (auto-approve; refused on spending commands
without `--max-spend` when `requireSpendLimit` is set), `--max-spend <n>`
(overrides `--yes` when the estimate exceeds it), `--approve <gate>@<fp>`,
`--token <t>` (discouraged; prefer the env var).

# Appendix B: HTTP status → exit code

What `ApiClient` in the CLI does with your API's responses. Your error body
should be `{ "code": "…", "message": "…", "remediation": "…" }`.

| Your API returns | CLI code | Exit | Retryable |
|---|---|---|---|
| 401, 403 | `auth` | 3 | no; remediation defaults to `<tool> login` |
| 402 | `insufficient_spend` | 4 | no |
| 404 | `not_found` | 5 | no |
| 408 | `timeout` | 11 | yes |
| 409 with `code: "checkpoint_stale"` | `checkpoint_stale` | 12 | no |
| 409 otherwise | `conflict` | 6 | no |
| 429 | `rate_limited` | 7 | no, deliberately |
| 5xx | `error` | 1 | yes |
| other 4xx | `error` | 1 | no |

Request headers the CLI sends: `Authorization: Bearer …`,
`X-Invokable-Client: <tool>/<version>`, `X-Invokable-Agent: <detected agent id>`,
`X-Invokable-Command: <command name>`, and `X-Invokable-Checkpoint: <gate>@<fingerprint>`
on an approved action. The MCP servers in this guide send `X-Invokable-Client`
and `X-Invokable-Surface: mcp | mcp-remote` instead, so your API can tell the
doors apart in logs.

# Appendix C: Endpoint reference

**Auth server** (`auth.invokable.dev`, or yours via `@invokable/server`):

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/device/start` | `{clientName, hostname, toolVersion}` | `{deviceCode, userCode, verificationUri, verificationUriComplete, interval, expiresIn}` |
| GET | `/device?code=` | | approval page |
| POST | `/device/approve` | form `userCode, decision, csrf` | `{ok, decision}` |
| POST | `/device/token` | `{deviceCode}` | `{token, tokenPrefix, subject, orgId, webOrigin}` or `{error: authorization_pending \| slow_down \| access_denied \| expired_token}` |
| GET | `/cli/whoami` | bearer | `{subject, orgId, tokenPrefix, clientName, hostname, createdAt}` or 401 |
| POST | `/cli/logout` | bearer | `{revoked: true}` |
| GET | `/.well-known/oauth-authorization-server` | | RFC 8414 |
| POST | `/oauth/register` | RFC 7591 JSON | `{client_id, client_secret?, …}` 201 |
| GET | `/oauth/authorize` | query: `response_type=code, client_id, redirect_uri, code_challenge, code_challenge_method=S256, state?, scope?, resource?` | consent page, or 302 with `error` |
| POST | `/oauth/approve` | form `requestId, decision, csrf` | 303 to `redirect_uri?code=…&state=…` |
| POST | `/oauth/token` | form or JSON: `grant_type=authorization_code, code, code_verifier, client_id[, client_secret][, redirect_uri]` or `grant_type=refresh_token, refresh_token, client_id` | `{access_token, token_type, expires_in?, refresh_token?, scope?}` |
| POST | `/oauth/revoke` | `token, client_id[, client_secret]` | `{}` always 200 |

**Your API** (SDK-served parts):

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/checkpoints` | `{gate, subject, summary}` + bearer | `{fingerprint, gate, expiresAt}` |
| POST | `/checkpoints/verify` | `{gate, subject, fingerprint, summaryHash?}` | `{valid: true, …}` or 409 `{code: "checkpoint_stale", …}` |
| GET | `/.well-known/oauth-protected-resource[/mcp]` | | RFC 9728 |
| GET | `/.well-known/oauth-authorization-server` | | relayed from the first authorization server |

# Appendix D: Configuration

| Variable (with `POLISH_` as the tool prefix) | Read by | Effect |
|---|---|---|
| `POLISH_API` | CLI, MCP servers | API origin; `connect` bakes it into `.mcp.json` |
| `POLISH_AUTH` | CLI | auth server origin (hosted default `https://auth.invokable.dev`) |
| `POLISH_TOKEN` | CLI, MCP stdio | overrides the stored token |
| `POLISH_CONFIG_DIR` | CLI, MCP stdio | overrides `~/.polish` |
| `INVOKABLE_AUTH_URL` | your API | where `/cli/whoami` is (self-host: your origin) |
| `CHECKPOINT_SECRET`, `CHECKPOINT_SECRET_PREVIOUS` | your API | signs fingerprints; rotation |
| `DATABASE_URL` | your API, auth server | Postgres |
| `SESSION_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | auth server (self-host) | your browser login |
| `AUTH_ORIGIN` | auth server (self-host) | fixed OAuth issuer for preview deployments |

Token precedence in the CLI: `--token` flag, then `POLISH_TOKEN`, then
`~/.polish/config.json`. The MCP stdio server resolves it through the same
SDK function, so the two never disagree.

---

## Where to look next

| | |
|---|---|
| A complete hosted tool, deployed | `github.com/beinvokable/demo-invokeable` (the `credmcp` package) |
| The hosted auth service, as a reference self-host | `github.com/beinvokable/cloud` |
| The SDK, tests and ADRs | `github.com/beinvokable/invokable` |
| Credits in depth | `docs/credits.md` |
| MCP adapter design notes | `docs/mcp.md` |
| The contract spec | `docs/spec-v0.1.md` |
