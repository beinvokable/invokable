# What invokable is, and when to use it

A map of the project for someone deciding whether it fits, before they read any
code. Everything here is implemented unless it says otherwise.

---

## In one paragraph

Coding agents (Claude Code, Codex, Cursor, Gemini CLI) increasingly run other
people's command-line tools on a user's behalf. Every team shipping such a tool
rebuilds the same four things: a way to teach the agent the tool, a way to sign
the machine in, an output format the agent can parse without guessing, and a
gate that stops the agent before it spends money. invokable is those four things
as a library, plus a hosted sign-in service for teams that do not want to run
one.

---

## Three people, and what each one gets

| Who | What they want | What invokable gives them |
| --- | --- | --- |
| **The tool developer** — a startup or team with an API, shipping a CLI so agents can use it | Ship in days, not weeks. Not lose money to a runaway agent. Instructions that never go stale. | `defineTool()` + four free built-ins, `checkpoint()` for one-line approval gates, `init` that generates and installs agent instructions, `invokable-test` in CI. |
| **The end user** — a developer whose agent runs the tool | One command to set up. See exactly what is about to happen and what it costs, before it happens. A credential that stays private and can be revoked. | `mytool init` installs the skill, `mytool login` opens a browser, the approval panel shows the plan and the price, tokens stored `0600` and revoked by `logout`. |
| **The agent** — a legitimate persona here | One JSON document per call, an exit code it can branch on, and the literal next command when something fails. | The enforced output envelope, semantic exit codes, `remediation` on every error, `status: "checkpoint"` with `next.approve`. |

---

## Which pieces you need

Everything ships from the same monorepo and versions together. You take what
your situation needs.

| Your situation | Use | Skip |
| --- | --- | --- |
| Starting from nothing | `npx create-invokable` — everything wired, choose hosted or self-host at the prompt | — |
| You have a Node CLI already | `@invokable/core` for the envelope, exit codes, `login`, `checkpoint()`; `@invokable/skills` for `init` | `create-invokable` |
| You have a CLI in another language | `@invokable/conformance` — the contract is documented and `invokable-test` checks any binary | the runtime packages |
| Your tool never spends money | `@invokable/core` + `@invokable/skills` | `checkpoint()`, the server's checkpoint routes |
| Your users are GitHub developers and you have no login system | hosted identity (`auth.invokable.dev`) | running `@invokable/server` |
| Your users already have accounts on your platform | `@invokable/server` mounted in your app, with your session | hosted identity — see [auth.md](./auth.md) |
| Your agent host has no shell (Claude Desktop, an IDE panel) | an MCP adapter in front of the CLI — [mcp.md](./mcp.md) | nothing; the skill still works for terminal agents |

---

## Journey 1 — a developer ships a tool, hosted identity

Who: a two-person startup with a deployment API. They want Claude Code users
to be able to say "deploy this" and have it work, without a runaway agent
deploying to prod unasked.

1. `npx create-invokable deployer` → hosted, first command `deploy`, spends: yes.
2. They point `api.baseUrl` at their API and implement two endpoints:
   `POST /v1/deploy/plan` (free, returns the plan and a price) and
   `POST /v1/deploy` (guarded by `verifyCheckpoint`).
3. They mount `checkpointRoutes()` in that same API, with `CHECKPOINT_SECRET`
   in their environment. Identity comes from the hosted service; approvals are
   issued and verified by them. See [auth.md](./auth.md) for how their API
   recognises a hosted token.
4. `npm publish`. CI runs `invokable-test` and `init --check` on every push.

What their user sees is Journey 3.

## Journey 2 — a platform with its own users, self-hosted

Who: an established product (a site builder, a CRM, a design tool) with millions
of accounts and its own login. They are exposing their platform to agents and
cannot send their users to a third-party sign-in page.

1. Same scaffold, `--auth self-host`, or the same packages added to an existing
   CLI.
2. `api.authUrl` points at their own domain. They mount `invokableAuth()` there
   with `requireSession` reading their existing session cookie and
   `postgresAuthStore()` on their database. The approval page lives under their
   domain, where the user is already signed in.
3. Their API validates the bearer token against the same store. Tokens are
   theirs end to end; nothing about their users leaves their infrastructure.
4. Approval gates and everything else are identical to Journey 1.

The hosted service is never involved. This is the default for anyone with an
existing user base, and [auth.md](./auth.md) walks through it.

## Journey 3 — an end user, from install to first approval

Who: a developer using Claude Code on a project.

1. `npm i -g deployer && deployer init` — writes the skill into `.claude/`,
   `.codex/`, `.cursor/`, `.gemini/`, `AGENTS.md`, then runs `login`.
2. `login` prints a URL and a code. The browser opens the approval page, which
   names the tool, its version and the machine asking. They click Approve. The
   terminal continues; a token is stored under `~/.deployer/`.
3. They tell the agent "deploy staging". The agent, following the skill, runs
   `deployer deploy --env staging --json`.
4. The command stops with `status: "checkpoint"` and exit 10. The agent shows
   the pre-rendered panel verbatim: the plan, the cost, the balance after.
5. They say yes. The agent runs the exact `next.approve` command. The server
   verifies the fingerprint against the plan they saw, burns it, and deploys.
6. If the agent re-runs that approval, exit 12: stale. If the plan changed
   underneath, exit 12. If they never had the balance, exit 4 before any panel
   was shown.

## Journey 4 — an agent host without a terminal

Who: the same tool, used from Claude Desktop or an IDE's MCP panel.

1. The developer writes an MCP adapter from [mcp.md](./mcp.md) — about 200
   lines, no per-command code, tool list generated from `--help --json`.
2. The user signs in once in their own terminal with `deployer login`; the
   adapter reuses the stored token.
3. A spending call becomes an MCP elicitation: the host shows the same panel
   and the **person** approves, never the model.

---

## What it is not

Stated plainly, because each of these is a reasonable thing to want.

- **Not a sandbox.** An agent that ignores its instructions can pass `--yes`.
  The server records that it did. The security boundary is the human at the
  terminal plus the audit trail. See [ADR 0003](./adr/0003-open-questions-from-spec.md).
- **Not a billing system.** The SDK renders a price and enforces `--max-spend`;
  what a credit costs and what to charge is your server's. [credits.md](./credits.md)
  is what your server has to get right.
- **Not an MCP proxy for someone else's server.** The adapter puts an
  invokable CLI *behind* MCP. It does not wrap a third-party MCP server and add
  auth or metering in front of it.
- **Not a registry.** `init` installs a tool's own instructions into a project.
  There is no public catalogue of tools or skills.
- **Not hosted approvals.** The hosted service is identity only. Fingerprints
  are issued and verified by your API with your secret.

---

## See also

- [auth.md](./auth.md) — hosted, self-hosted, or bring your own identity
- [credits.md](./credits.md) — pricing, holds and metering behind the gate
- [mcp.md](./mcp.md) — the same tool over the Model Context Protocol
- [spec-v0.1.md](./spec-v0.1.md) — the original spec, in Hebrew
