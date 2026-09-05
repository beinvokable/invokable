# An MCP server for an invokable CLI

A working adapter that exposes any invokable tool over the Model Context
Protocol, plus a scripted host that drives it so you can watch the exchange.

The design notes — the mapping table, what to expose, what not to, and where the
MCP spec is heading — are in [`docs/mcp.md`](../../docs/mcp.md). This file is
how to run it.

## Run it

```bash
pnpm install && pnpm build

node examples/server/server.mjs     # terminal 1 — auth, checkpoints, the API
node examples/mcp/client.mjs        # terminal 2 — an MCP host, scripted
```

The client lists the tools, signs in out of band, calls one that spends money,
answers the approval the way a person clicking "Approve" would, and then calls
one that fails — so you see all four result shapes.

## Point a real host at it

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

Sign in first, in your own terminal — the server reuses the stored token:

```bash
DEMO_TOOL_API=http://127.0.0.1:8787 node examples/demo-tool/bin/demo-tool.mjs login
```

## Use it with your own tool

Set `INVOKABLE_CLI` to your binary. Nothing else changes: the tool list, the
schemas and the spend hints are all read from `<cli> --help --json` at startup.

```bash
INVOKABLE_CLI=/path/to/bin/my-tool.mjs node examples/mcp/server.mjs
```

## Files

| File | What it is |
| --- | --- |
| `server.mjs` | The adapter. Generates the tool list, runs the CLI, maps envelopes to MCP results, turns checkpoints into elicitation. |
| `client.mjs` | A host, scripted. Stands in for Claude Desktop or an IDE. |

## What it does not do

- **Serve `login`.** The device flow needs a terminal and a browser; an MCP host
  has neither. Authentication is out of band.
- **Approve anything itself.** Every checkpoint goes to the person, or comes
  back as data. There is no path through the file that says yes on their behalf.
- **Speak MRTR.** The 2026-07-28 spec's multi-round-trip shape is a closer fit
  than elicitation, but the TypeScript SDK does not implement it yet. See
  `docs/mcp.md`.
