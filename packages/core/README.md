# @invokable/core

The runtime for CLI tools that coding agents drive: output envelope, exit codes,
command schema, config store, device-code login, and approval gates.

```js
import { cli, command, defineTool } from '@invokable/core';

const tool = defineTool({
  name: 'demo-tool',
  version: '0.1.0',
  api: { baseUrl: 'https://api.example.com' },
  commands: {
    greet: command({
      description: 'Greet someone by name.',
      options: { name: { type: 'string', required: true, short: 'n' } },
      run: ({ opts, ctx }) => {
        ctx.io.note('working…');            // → stderr, always
        return { text: `Hello, ${opts.name}.` };
      },
    }),
  },
});

await cli(tool);
```

```console
$ demo-tool greet --name Ido --json
working…                                             # stderr
{"status":"ok","data":{"text":"Hello, Ido."}}        # stdout, exactly one document
$ echo $?
0
```

## What you get

**One JSON document on stdout**, enforced rather than requested: while a command
runs, `process.stdout.write` is diverted to stderr, so a stray `console.log` in
any dependency cannot corrupt the document the agent parses.

**Semantic exit codes.** `0 ok · 1 error · 2 usage · 3 auth · 4
insufficient_spend · 5 not_found · 6 conflict · 7 rate_limited · 10
checkpoint_pending · 11 timeout · 12 checkpoint_stale · 15 network · 20
declined`. Tools may add codes in 30–99.

**`remediation` on every error** — the literal next command to run.

**Four built-in commands** with no code: `login` (device-code flow), `logout`,
`whoami`, `doctor`. The token is stored at `~/.<tool>/config.json`, directory
`0700`, file `0600`, written atomically.

**Approval gates** via `checkpoint()`, for commands that spend money:

```js
await checkpoint(ctx, {
  gate: 'deploy_review',
  title: 'deployment plan',
  summary: { env: opts.env, replicas: plan.replicas },
  subject: serviceId,
  question: 'Deploy this plan to production?',
  spend: { estimated: plan.credits, balance: plan.balance },
});
```

The command stops with `status: "checkpoint"` and exit 10, carrying a rendered
panel and the exact command that approves it. Fingerprints are issued by your
server (see [`@invokable/server`](https://www.npmjs.com/package/@invokable/server)),
bound to the plan the user was shown, and consumed once.

## Related

- [`@invokable/server`](https://www.npmjs.com/package/@invokable/server) — auth endpoints and checkpoint verification
- [`@invokable/skills`](https://www.npmjs.com/package/@invokable/skills) — generates agent instructions from the schema
- [`@invokable/conformance`](https://www.npmjs.com/package/@invokable/conformance) — checks a CLI honours the contract
- [`create-invokable`](https://www.npmjs.com/package/create-invokable) — scaffolds a project

Full documentation: https://github.com/beinvokable/invokable

## License

MIT
