# Building an MCP server for an invokable tool

invokable does not ship an MCP server. This document is how to write one, and
what it has to contain.

`examples/mcp/` is a working implementation — about 200 lines, most of them
comments. `node examples/mcp/client.mjs` runs it against a real backend and
prints the whole exchange.

> **Spec revision.** Written against MCP **2026-07-28**, with the TypeScript SDK
> at **1.30.0**, which implements protocol **2025-11-25**. Where the two differ
> it is called out below — that gap is temporary and worth knowing about.

---

## Why this is a thin adapter and not a rewrite

An MCP server has to answer three questions about every tool it exposes:

1. What can be called, and with what arguments?
2. Did the call succeed, and what came back?
3. What should happen when something needs a human?

An invokable CLI already answers all three, in a machine-readable form, because
the output contract was designed for exactly this. So the adapter translates —
it does not decide anything.

| MCP needs | invokable already has |
| --- | --- |
| `tools/list` with JSON Schema | `--help --json` → a manifest with every command, option, type, `choices` and `required` |
| A structured result | The `--json` envelope: one JSON document on stdout, nothing else |
| `isError` + something the model can act on | `status: "error"` with `code`, `retryable`, `remediation` |
| A way to ask the user mid-call | `status: "checkpoint"` with a rendered panel and a fingerprint |
| Read-only vs destructive hints | `spends: true` on the command |

The practical consequence: **write no per-command code.** The example's tool
list is generated at startup, so adding a command to the CLI adds it to the MCP
surface with no edit to the adapter. Hand-maintaining a second description of
your tool guarantees the two drift.

```js
// examples/mcp/server.mjs
const manifest = await readManifest();          // <cli> --help --json

for (const command of manifest.commands) {
  server.registerTool(command.name, {
    description: command.description,
    inputSchema: inputSchemaFor(command),       // options → Zod shape
    annotations: { destructiveHint: command.spends },
  }, handler);
}
```

---

## What the server must contain

### 1. One invocation per call, always `--json`

```js
spawn(process.execPath, [CLI, ...args, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
```

Parse stdout as one JSON document. This works because the runtime guarantees
stdout purity — progress, warnings and prompts all go to stderr, and a stray
`console.log` inside a command is diverted rather than allowed to corrupt the
document. You do not need a parser, a delimiter, or a heuristic.

Keep stderr. When stdout is empty the process died before the runtime took over
(missing binary, syntax error), and stderr is the only diagnostic you have.

### 2. Schemas derived from the manifest

```js
for (const opt of command.options ?? []) {
  let field;
  if (opt.type === 'boolean') field = z.boolean();
  else if (opt.choices?.length) field = z.enum([...opt.choices]);
  else field = z.string();

  if (opt.description) field = field.describe(opt.description);
  shape[opt.name] = opt.required ? field : field.optional();
}
```

`choices` becoming an enum matters more than it looks: the host rejects a bad
`--env` before a process is spawned, so the model gets a schema error instead of
burning a round trip on exit 2.

### 3. Errors that keep their structure

The single worst thing an adapter can do is flatten an error into a string.

```js
return {
  isError: true,
  content: [{ type: 'text', text: `${message}\nTry: ${remediation}` }],
  structuredContent: { status: 'error', code, message, retryable, remediation, exitCode },
};
```

`retryable` is the CLI's own judgement about whether trying again could possibly
help. `remediation` is usually a literal command that fixes the problem. An
agent that gets `"No project named \"nope\""` and nothing else will retry it;
an agent that also gets `retryable: false` and `demo-tool find-project demo`
will not.

### 4. Checkpoints → elicitation

This is the part that justifies the whole exercise.

```js
if (envelope.status === 'checkpoint') {
  const answer = await server.server.elicitInput({
    message: `${cp.display}\n\n${cp.question}`,
    requestedSchema: {
      type: 'object',
      properties: { approve: { type: 'boolean', title: cp.question } },
      required: ['approve'],
    },
  });

  if (answer.action !== 'accept' || !answer.content?.approve) {
    return { content: [{ type: 'text', text: 'Declined. Nothing was run.' }] };
  }

  return runCli([...argv, '--approve', `${cp.gate}@${cp.fingerprint}`]);
}
```

Elicitation asks the **person**, not the model. That distinction is the entire
value of the gate: a model that can approve its own spending is not a control,
it is a formality. Everything else here is plumbing; this is the control.

Three rules for this block:

- **Pass `display` through unchanged.** It is the record of what the person
  agreed to, and the server's HMAC is over that plan. A summary written by a
  model is not the same artefact, and the difference is exactly where an
  injection lands.
- **Rebuild the approved command from your own arguments**, not by splitting
  `next.approve` on spaces. That string is shell syntax — a file path with a
  space in it gets torn in half.
- **Never auto-approve.** If the host cannot prompt (see below), return the
  checkpoint as data and stop. Approving on the user's behalf because it was
  inconvenient not to is the one unrecoverable mistake in this file.

### 5. A fallback for hosts that cannot prompt

Elicitation is a client capability. A host that did not declare it will reject
the request.

```js
} catch (error) {
  return {
    content: [{ type: 'text', text: `${cp.display}\n\n${cp.question}` }],
    structuredContent: {
      status: 'checkpoint', gate: cp.gate, fingerprint: cp.fingerprint,
      spend: cp.spend, approveWith: cp.next?.approve,
    },
  };
}
```

The host shows the panel and calls the tool again with an `approve` argument.
Degraded, but honest: the person still sees the number and still decides.

### 6. A decision about what *not* to expose

```js
if (['login', 'logout', 'init'].includes(command.name)) continue;
```

Not every command belongs on the MCP surface, and working out which is a real
part of the job:

- **`login` / `logout`** — the device flow prints a code and waits for a browser.
  An MCP host has no terminal to print it to and no business holding the
  credential. Authentication is **out of band**: the person runs
  `mytool login` in their own terminal once, and the server uses the stored
  token. Commands that need auth and lack it still fail correctly — exit 2 with
  `remediation: "mytool login"`, which the model relays.
- **`init`** — writes agent instruction files into a project directory. A
  developer action, not something a model reaches for mid-conversation.

---

## Where the spec is going: MRTR

The 2026-07-28 revision made MCP's core **stateless** and replaced
server-initiated requests over held-open streams with **Multi Round-Trip
Requests**. Instead of the server calling back to the client mid-execution, it
returns:

```jsonc
{
  "resultType": "input_required",
  "inputRequests": {
    "confirm": { "type": "elicit", "params": { /* an elicitation request */ } }
  },
  "requestState": "<opaque token>"
}
```

and the client **retries the original call** with `inputResponses` and the
echoed `requestState`.

If that shape looks familiar, it should. It is the same design as a checkpoint:

| MRTR | invokable checkpoint |
| --- | --- |
| `resultType: "input_required"` | `status: "checkpoint"`, exit 10 |
| `inputRequests` | `question` + `display` |
| `requestState` (opaque, echoed back) | `fingerprint` (opaque, echoed back) |
| Retry the original call with answers | Re-run the original command with `--approve` |

Both arrived at "return, don't hold; carry an opaque token; the retry is the
resumption" because both are solving the same problem: a server that cannot keep
a connection open still needs a human in the loop. A checkpoint fingerprint does
more than `requestState` — it is HMAC-signed over the plan, single-use, and
expires — but the flow is the same, and an adapter maps one onto the other
almost mechanically.

**Not yet in the TypeScript SDK.** Version 1.30.0 implements protocol
2025-11-25; its `input_required` is a *Task* status, not the MRTR result type.
So the example uses `elicitInput`, which works today. When the SDK catches up,
the change is confined to that one block.

---

## Running the example

```bash
pnpm install && pnpm build
node examples/server/server.mjs     # terminal 1 — auth, checkpoints, the API
node examples/mcp/client.mjs        # terminal 2 — an MCP host, scripted
```

Real output, from the run that produced this document:

```
── 1. What can this server do? ─────────────────────────────
  Generated from the CLI manifest — nothing hand-written.
  whoami
  doctor
  greet
  find-project
  deploy [spends]
  summarize [spends]
  balance
  check-quota

── 3. A tool that spends — the server asks the PERSON ──────

  The server elicited this before running anything:

┌──────────────────────────────────────────────────────────────────┐
│ SUMMARISE                                                        │
├──────────────────────────────────────────────────────────────────┤
│   "inputTokens": 20000,                                          │
│   "maxOutputTokens": 8000                                        │
│                                                                  │
│ Cost: 17 credits                                                 │
│ Balance after: 83 credits                                        │
│                                                                  │
│ At most 17 credits — you are charged for the output actually     │
│ produced.                                                        │
└──────────────────────────────────────────────────────────────────┘

  Approved, so the command re-ran with the fingerprint:

{ "status": "ok", "data": { "estimated": 17, "charged": 11, "balanceAfter": 89 } }
```

---

## Pointing a real host at it

```jsonc
{
  "mcpServers": {
    "demo-tool": {
      "command": "node",
      "args": ["/absolute/path/to/examples/mcp/server.mjs"],
      "env": { "DEMO_TOOL_API": "http://127.0.0.1:8787" }
    }
  }
}
```

For your own tool, set `INVOKABLE_CLI` to its binary — the adapter reads
everything else from `--help --json` and needs no other change.

---

## MCP or a skill?

You do not have to choose, and the answer differs per host.

|  | Agent Skill (`mytool init`) | MCP server |
| --- | --- | --- |
| How the agent calls it | Runs the CLI itself | Calls a tool over a protocol |
| Setup | A file in the repo | A configured server process |
| Where it works | Anything that reads skills or `AGENTS.md` | Anything that speaks MCP |
| Approval | The agent shows `display`, relays `next.approve` | The host prompts via elicitation |
| Best for | Coding agents already in a terminal | Hosts with no shell, or a curated tool surface |

Both drive the same binary and the same contract. A skill costs nothing to ship
— `mytool init` writes it — so ship it, and add MCP when a host needs it.

---

## Checklist

- [ ] Tool list generated from `--help --json`, not hand-written.
- [ ] Every invocation passes `--json`; stdout parsed as one document.
- [ ] stderr kept, and used when stdout is empty.
- [ ] `choices` → enum, `required` → required.
- [ ] `spends` → `destructiveHint`.
- [ ] Errors keep `code`, `retryable` and `remediation`, with `isError: true`.
- [ ] Checkpoints go to elicitation, with `display` passed through verbatim.
- [ ] The approved re-run is rebuilt from your own argv, not a split string.
- [ ] A fallback path for hosts without elicitation.
- [ ] `login` / `logout` / `init` excluded; auth happens out of band.
- [ ] No path in the file approves a checkpoint on the user's behalf.

---

## See also

- `examples/mcp/server.mjs` — the adapter
- `examples/mcp/client.mjs` — a host, scripted
- [`docs/credits.md`](./credits.md) — pricing the operations behind these tools
- [MCP 2026-07-28 specification](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [Multi-round-trip requests](https://py.sdk.modelcontextprotocol.io/handlers/multi-round-trip/)
