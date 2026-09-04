# invokable

Build CLI tools that coding agents can drive without breaking.

Every team shipping "a tool an agent runs" rewrites the same four layers:
installing instructions into the agent, machine auth, an output format the agent
can parse without guessing, and a gate that stops the agent before it spends
money. `invokable` is that layer, as a library.

> **Status: early.** The runtime contract, machine auth, approval gates and the
> agent-instruction generator are implemented and tested. The scaffolder is not
> built yet. See [Roadmap](#roadmap).

## Packages

| Package | Status | What it does |
|---|---|---|
| `@invokable/core` | 🟢 contract, auth, gates | Output envelope, exit codes, command schema, config store, device-code login, `checkpoint()` |
| `@invokable/server` | 🟢 device flow + gates | Device-flow endpoints, checkpoint issuance and one-shot verification |
| `@invokable/skills` | 🟢 generator done | Generates a portable `SKILL.md` and installs it for every major agent |
| `create-invokable` | ⚪ not started | Project scaffolder |

The hosted auth service lives in a separate private repository; see
[ADR 0001](docs/adr/0001-repository-topology.md) for why.

## The contract

A tool defines its surface once:

```js
import { defineTool, command, cli } from '@invokable/core';

const tool = defineTool({
  name: 'demo-tool',
  version: '0.1.0',
  commands: {
    greet: command({
      description: 'Greet someone by name.',
      options: { name: { type: 'string', required: true, short: 'n' } },
      run: ({ opts, ctx }) => {
        ctx.io.note('working…');          // → stderr, always
        return { text: `Hello, ${opts.name}.` };
      },
    }),
  },
});

await cli(tool);
```

and the runtime guarantees what the agent sees:

```console
$ demo-tool greet --name Ido --json
working…                                              # stderr
{"status":"ok","data":{"text":"Hello, Ido."}}         # stdout, exactly one document
$ echo $?
0

$ demo-tool find-project nope --json
{"status":"error","code":"not_found","message":"No project named \"nope\".",
 "retryable":false,"remediation":"demo-tool find-project demo"}
$ echo $?
5
```

Three properties do the work:

**One JSON document on stdout.** Enforced, not requested: while a command runs,
`process.stdout.write` is diverted to stderr, so a stray `console.log` in any
dependency cannot corrupt the document. See
[ADR 0002](docs/adr/0002-output-contract-is-enforced.md).

**Semantic exit codes.** `0 ok · 1 error · 2 usage · 3 auth · 4 insufficient_spend
· 5 not_found · 6 conflict · 7 rate_limited · 10 checkpoint_pending · 11 timeout ·
12 checkpoint_stale · 15 network · 20 declined`. Tools may add codes in 30–99. The
agent decides what to do next from the number alone.

**`remediation` on every error.** The literal next command to run, so the agent
does not have to invent one.

## Approval gates

One call stops a command before it spends money:

```js
await checkpoint(ctx, {
  gate: 'deploy_review',
  title: 'deployment plan',
  summary: { env: opts.env, replicas: plan.replicas },
  subject: serviceId,
  question: 'Deploy this plan to production?',
  explain: 'Approving starts the deploy and bills 1 credit per minute.',
  spend: { estimated: plan.credits, balance: plan.balance },
  reject: `deployer deploy --env ${opts.env} --dry-run`,
});
```

The agent gets a third status and exit 10 — not an error, and not a success:

```console
$ deployer deploy --env prod --json
{"status":"checkpoint","schema":"invokable.checkpoint/v1","gate":"deploy_review",
 "fingerprint":"GCI3HOREK4LY34J7","display":"…","spend":{"estimated":12,"balance":100},
 "next":{"approve":"deployer deploy --env prod --json --approve deploy_review@GCI3HOREK4LY34J7",
         "reject":"deployer deploy --env prod --dry-run"}}
$ echo $?
10
```

`display` is a pre-rendered panel, so every agent shows the user the same thing
rather than paraphrasing what they are about to pay for:

```
┌──────────────────────────────────────────────────────────────────┐
│ DEPLOYMENT PLAN                                                  │
├──────────────────────────────────────────────────────────────────┤
│ {                                                                │
│   "env": "prod",                                                 │
│   "replicas": 3,                                                 │
│   "image": "api:2.4.1"                                           │
│ }                                                                │
│                                                                  │
│ Cost: 12 credits                                                 │
│ Balance after: 88 credits                                        │
│                                                                  │
│ Deploy this plan to production?                                  │
└──────────────────────────────────────────────────────────────────┘
```

At a real terminal it prompts instead. `next.approve` is the original invocation
with the approval appended, so it runs as given.

**The fingerprint is issued by the server, never computed locally.** It is bound
to (gate, subject, summary), expires after 24h, and is consumed exactly once — by
the action it authorises, via the `verifyCheckpoint` middleware. So a replayed
approval fails, and an approval whose plan changed underneath fails:

```console
$ deployer deploy --env prod --json --approve deploy_review@GCI3HOREK4LY34J7
{"status":"error","code":"checkpoint_stale","message":"The plan changed since this approval was issued."}
$ echo $?
12
```

`--yes` auto-approves and says so on stderr, and the server still records the
approval. `--max-spend` overrides it: an estimate above the cap falls back to the
gate rather than proceeding.

## Auth, for free

Every tool gets `login`, `logout`, `whoami` and `doctor` without writing them.
`login` runs the device-code flow, then stores the token in `~/.<tool>/config.json`
— directory `0700`, file `0600`, written atomically so a crash cannot truncate a
credential the user would have to re-issue.

```console
$ demo-tool login
  To finish signing in to demo-tool, open:
    https://auth.example.com/device?code=WXYZ-1234
  and confirm this code:  WXYZ-1234
  Waiting for approval…

$ demo-tool whoami --json
{"status":"ok","data":{"subject":"ido@example.com","orgId":"org_acme"}}

$ demo-tool logout --json && demo-tool whoami --json; echo "exit $?"
{"status":"error","code":"auth","message":"Not signed in.","remediation":"demo-tool login"}
exit 3
```

Token precedence is `--token` > `DEMO_TOOL_TOKEN` > config file. Passing `--token`
warns on stderr, because it is visible to other users via `ps`.

`doctor` separates the failures that look alike from the outside:

```console
$ demo-tool doctor --json | jq '{api:.data.api.reachable, auth:.data.auth.ok, cfg:.data.config.source}'
{"api": true, "auth": false, "cfg": "none"}
```

A server that answers `401` is *reachable* — only a network or timeout failure
marks it unreachable. Telling those apart is most of what "it doesn't work" turns
out to be.

## Agent instructions, generated

`init` turns the tool schema into instructions and installs them for every agent
the user might be running:

```console
$ demo-tool init
created: .claude/skills/demo-tool/SKILL.md
created: .codex/skills/demo-tool/SKILL.md
created: .cursor/skills/demo-tool/SKILL.md
created: .gemini/skills/demo-tool/SKILL.md
created: .agents/skills/demo-tool/SKILL.md
updated: AGENTS.md
created: CLAUDE.md
created: .github/copilot-instructions.md
created: .cursor/rules/demo-tool.mdc
```

The `SKILL.md` written to those five directories is **byte-identical**. That is
the [Agent Skills standard](https://agentskills.io) doing its job, and it is why
the generator emits only the six frontmatter fields the spec allows rather than
the wider set Claude Code alone accepts — anything else fails to upload to
claude.ai or the Skills API. See
[ADR 0004](docs/adr/0004-agent-instruction-formats.md).

`AGENTS.md`, Copilot instructions and Cursor rules get a short section between
`<!-- invokable:begin -->` markers; the rest of those files is never touched.
`CLAUDE.md` gets `@AGENTS.md`, because Claude Code reads `CLAUDE.md` and not
`AGENTS.md`, and duplicating the section would load it twice every session.

Anything you write inside `<!-- invokable:custom -->` survives regeneration.
`init --check` exits **30** when the generated files are stale, so CI catches a
schema change nobody regenerated:

```yaml
- run: npx demo-tool init --check
```

## Try it

```bash
pnpm install
pnpm build
pnpm test

node examples/demo-tool/bin/demo-tool.mjs greet --name Ido --json
node examples/demo-tool/bin/demo-tool.mjs find-project nope --json; echo "exit $?"
```

To exercise the full login flow, run the self-hosted auth server and point the
example tool at it:

```bash
node examples/self-host-auth/server.mjs &

DEMO_TOOL_API=http://127.0.0.1:8787 \
DEMO_TOOL_CONFIG_DIR=/tmp/demo-cfg \
  node examples/demo-tool/bin/demo-tool.mjs login
```

It prints a code and a URL; open the URL and click Approve.

## What this does not do

The approval gate is a **usability and audit** mechanism, not a sandbox. An agent
that ignores its instructions can pass `--yes` and spend money; the server-side
record shows that it did. Fingerprints (once implemented) guarantee that an
approval is fresh and used once — they do not contain a hostile agent. The
security boundary is the human at the terminal. See
[ADR 0003](docs/adr/0003-open-questions-from-spec.md).

## Roadmap

Slices, in dependency order. Each one ships working and tested.

- [x] **1 — Contract.** Envelope, exit codes, schema, parser, stdout guard, help.
- [x] **2a — Config + auth client.** Token store (0700/0600, atomic), device-code
      client with `slow_down` backoff, `login` / `logout` / `whoami` / `doctor`,
      HTTP client mapping status codes onto the exit contract, agent detection.
- [x] **2b — `@invokable/server`.** The device-flow endpoints and a memory store,
      with hashed tokens and single-use device codes. Verified by driving the
      real client against the real server over a socket.
- [x] **3 — Checkpoints.** `checkpoint()`, server-issued HMAC fingerprints,
      one-shot consumption bound to the action, secret rotation, ASCII panel,
      interactive prompt.
- [x] **4 — Skills.** Portable `SKILL.md` generator, installers for Claude Code,
      Codex, Cursor, Gemini CLI, Copilot and `AGENTS.md`, custom-block
      preservation, `init --check` for CI.
- [ ] **5 — Scaffolder + conformance.** `create-invokable`, `invokable-test`.

Design docs: [`docs/spec-v0.1.md`](docs/spec-v0.1.md) (original spec) and
[`docs/adr/`](docs/adr/).

## License

MIT
