# Identity: hosted, self-hosted, or your own

Who signs the user in, where the token comes from, and how your API knows who is
calling. This is the decision most teams have to make on day one, and the one
the quickstart glosses over with a single prompt.

---

## The one line that decides it

```js
api: {
  baseUrl: 'https://api.mytool.com',        // your API: commands, plans, checkpoints
  authUrl: 'https://auth.invokable.dev',    // who signs the user in
},
```

`login`, `logout`, `whoami` and `doctor` talk to `authUrl`. Everything else,
including `checkpoint()`, talks to `baseUrl`. If `authUrl` is omitted it
defaults to `baseUrl`.

Two consequences worth stating before the modes:

- **Approvals never leave your infrastructure.** `checkpoint()` posts to
  `{baseUrl}/checkpoints`, and `verifyCheckpoint` runs in your API with
  `CHECKPOINT_SECRET` from your environment. The hosted service does not see
  plans, prices or approvals. It is identity only.
  ([ADR 0003](./adr/0003-open-questions-from-spec.md), item 1.)
- **Switching modes is a URL change.** Users run `login` again; existing tokens
  do not migrate, because they were issued by a different store.

---

## The three modes

|  | **Hosted** | **Self-hosted, your users** | **Bring your own** |
| --- | --- | --- | --- |
| Who the user signs in as | Their GitHub account | Their account on your platform | Whatever you already issue |
| Where the approval page lives | `auth.invokable.dev` | Your domain, your session | Not used |
| Who issues and stores the token | The hosted service (`ivk_…`) | You, in your database, hashed | You |
| How your API recognises the token | Forward it to `GET {authUrl}/cli/whoami` | `store.findTokenByHash(hashToken(bearer))` | Your existing check |
| What you run | Nothing extra | `@invokable/server` mounted in your app | Your own `login`, or none |
| Pick it when | Your users are developers with GitHub and you have no login system yet | You have users, sessions and a database already | You already have API keys or a CLI login |

---

## Mode 1 — hosted

`npx create-invokable --auth hosted`, or set `authUrl` to `https://auth.invokable.dev`.

What the user sees:

```console
$ mytool login
  To finish signing in to mytool, open:
    https://auth.invokable.dev/device?code=WXYZ-1234
  and confirm this code:  WXYZ-1234
```

The page asks them to sign in with GitHub (profile read only), shows which
tool, version and machine asked, and records the approval. The CLI receives a
long-lived `ivk_` token and stores it at `~/.mytool/config.json`.

**What your API has to do.** Every request from the CLI carries
`Authorization: Bearer ivk_…`. Your API did not issue that token and cannot
verify it locally. The check is a forward:

```js
async function whoIsCalling(request) {
  const auth = request.headers.get('authorization');
  if (!auth) return null;
  const res = await fetch('https://auth.invokable.dev/cli/whoami', {
    headers: { authorization: auth },
  });
  if (!res.ok) return null;                      // 401 = revoked or unknown
  const { subject, orgId } = await res.json();  // subject: a stable GitHub id
  return { subject, orgId };
}
```

Then map `subject` to a record of your own. The hosted service knows the
person's GitHub identity; it does not know their plan, balance or permissions on
your side. Those are yours to keep, keyed by `subject`.

Cache the answer briefly if you like; the token is long-lived and only
`logout` revokes it.

**Limits today**, honestly:

- Sign-in is GitHub only. Not an email address, not your SSO.
- No organisations. `orgId` is returned but nothing populates it.
- No account page to list or revoke other tokens; `logout` revokes the one in
  use.
- No SDK helper for the forward above; it is the six lines shown.

If any of those is a blocker, use mode 2.

---

## Mode 2 — self-hosted, with your own users

This is the mode for a product that already has accounts. Your users never see
a third-party page, and no identity data leaves you.

**The CLI side** is one URL:

```js
api: {
  baseUrl: 'https://api.mytool.com',
  authUrl: 'https://mytool.com',      // where your users are already signed in
},
```

**The server side** is `invokableAuth()` mounted on that domain, with two
things that are yours:

```js
import { invokableAuth, postgresAuthStore } from '@invokable/server';

const auth = invokableAuth({
  // Your database. The schema is a few tables; createSchema() makes them.
  store: postgresAuthStore({ exec: { query: (sql, params) => db.query(sql, params) } }),

  tokenPrefix: 'mt',

  // Your session. Runs on the approval page, in the user's browser.
  // Return null when nobody is signed in; the endpoint answers 401.
  requireSession: async (request) => {
    const user = await getUserFromCookie(request);
    return user && { subject: user.id, orgId: user.workspaceId, displayName: user.name };
  },

  // Optional: your own approval page. Keep the tool / version / machine
  // display and the "only approve a login you started" warning.
  // approvePage: ({ device, user }) => renderApprovePage(device, user),

  tokenTtl: null,   // long-lived; revoked by `logout` or from your account page
});
```

The handler owns six paths (`/device/start`, `/device`, `/device/approve`,
`/device/token`, `/cli/whoami`, `/cli/logout`) and returns `null` for anything
else, so it composes with your router. Express gets `expressMiddleware(auth)`
from `@invokable/server/node`; Hono, Deno and Workers call it directly.

**What your API has to do.** You hold the store, so the check is local:

```js
import { hashToken } from '@invokable/server';

async function whoIsCalling(request) {
  const auth = request.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return null;
  const record = await store.findTokenByHash(hashToken(auth.slice(7)));
  if (!record || record.revokedAt) return null;
  if (record.expiresAt !== null && record.expiresAt <= Date.now()) return null;
  return { subject: record.subject, orgId: record.orgId };
}
```

`subject` is whatever your `requireSession` returned, so it is already your
user id.

**Before production**, add what the SDK deliberately leaves to your framework:
CSRF protection on `/device/approve`, rate limiting on `/device/start`, and a
place in your account settings that lists tokens and revokes them (the store
records who approved what, when, and from which machine; surfacing it is
yours). The [server README](../packages/server/README.md) has the full list.

`examples/server/server.mjs` is this mode on a laptop, with `memoryStore()` and
a fixed user. Replacing those two things is the whole migration.

---

## Mode 3 — bring your own credentials

You already have API keys, or a CLI login of your own, and want none of the
device flow.

Two options, and both work with the rest of the SDK unchanged:

**Skip `login`.** The token is resolved in this order: `--token`, then
`MYTOOL_TOKEN` in the environment, then the config file. A user who exports
`MYTOOL_TOKEN=<your api key>` is signed in as far as every command is
concerned, and the header your API receives is `Authorization: Bearer <key>`,
which your existing check already handles.

**Replace `login`.** Commands you declare shadow the built-ins by name, so
`commands: { login: command({ … }) }` replaces the device flow with yours.
Write the result with `ctx.config.write({ token, subject })` and the rest of
the SDK reads it. Shadow `whoami` and `logout` too, or implement
`GET /cli/whoami` and `POST /cli/logout` on your `authUrl` so the built-ins keep
working.

`doctor` still reports whether the token came from a flag, the environment or
the file, and warns when the file is world-readable.

---

## Deciding

Answer these in order; the first "yes" picks the mode.

1. Do your users already have accounts on your platform? → **Self-hosted (2)**.
   Sending them to a GitHub sign-in for a product they already log into is
   confusing, and you would have to map GitHub identities to your users anyway.
2. Do you already issue API keys or have a CLI login? → **Bring your own (3)**.
3. Are your users developers, is GitHub an acceptable identity, and do you not
   want to run an auth endpoint yet? → **Hosted (1)**. Move to (2) later with
   one URL change.

A team that picks hosted to ship this week and moves to self-hosted when they
add accounts is the intended path, not a workaround. The code the CLI runs is
identical in both.

---

## What stays the same in every mode

- Tokens are stored at `~/.mytool/config.json`, directory `0700`, file `0600`,
  written atomically.
- `--token` on the command line warns on stderr, because `ps` shows it.
- The approval page, wherever it is served, names the tool, its version and the
  requesting machine, and says a code someone sent you is an attack. Device-code
  phishing is the flow's inherent weakness, and that display is the defence.
- Checkpoints: issued and verified by your API, with your secret, bound to the
  plan the user saw, consumed once, expiring after 24 hours.

## See also

- [`packages/server/README.md`](../packages/server/README.md) — the handler, its options, what it does and does not do about security
- [`examples/server/README.md`](../examples/server/README.md) — mounting in Express, Hono, Workers; what to change before production
- [overview.md](./overview.md) — the journeys these modes appear in
