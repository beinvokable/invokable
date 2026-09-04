# invokable

Build CLI tools that coding agents can drive without breaking.

Every team shipping "a tool an agent runs" rewrites the same four layers:
installing instructions into the agent, machine auth, an output format the agent
can parse without guessing, and a gate that stops the agent before it spends
money. `invokable` is that layer, as a library.

> **Status: early.** The runtime contract (`@invokable/core`) is implemented and
> tested. Auth, checkpoints, the skill generator and the scaffolder are not built
> yet. See [Roadmap](#roadmap).

## Packages

| Package | Status | What it does |
|---|---|---|
| `@invokable/core` | 🟢 contract layer done | Output envelope, exit codes, command schema, arg parsing |
| `@invokable/server` | ⚪ not started | Device-flow endpoints, checkpoint verification (self-host) |
| `@invokable/skills` | ⚪ not started | Generates `SKILL.md` / `AGENTS.md` / Cursor rules from the schema |
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

## Try it

```bash
pnpm install
pnpm build
pnpm test

node examples/demo-tool/bin/demo-tool.mjs greet --name Ido --json
node examples/demo-tool/bin/demo-tool.mjs find-project nope --json; echo "exit $?"
```

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
- [ ] **2 — Config + auth.** Token store (0600), device-code client, `login` /
      `logout` / `whoami` / `doctor`, `@invokable/server` with a memory store.
- [ ] **3 — Checkpoints.** `checkpoint()`, server-issued HMAC fingerprints,
      one-shot verification, ASCII panel. Blocked on
      [ADR 0003 §1](docs/adr/0003-open-questions-from-spec.md).
- [ ] **4 — Skills.** `SKILL.md` generator + `.claude/skills` and `AGENTS.md`
      installers.
- [ ] **5 — Scaffolder + conformance.** `create-invokable`, `invokable-test`.

Design docs: [`docs/spec-v0.1.md`](docs/spec-v0.1.md) (original spec) and
[`docs/adr/`](docs/adr/).

## License

MIT
