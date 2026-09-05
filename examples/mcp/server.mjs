#!/usr/bin/env node
/**
 * An MCP server for an invokable CLI — the whole thing, in one file.
 *
 *   node examples/mcp/server.mjs                 # speaks MCP over stdio
 *   node examples/mcp/client.mjs                 # drives it, prints the exchange
 *
 * Note what this file does NOT contain: a list of tools, a JSON Schema, a
 * description of what `deploy` does, or any knowledge that `deploy` costs money.
 * All of that is read out of the CLI at startup with `--help --json`. Adding a
 * command to the CLI adds it to the MCP surface with no edit here — which is the
 * point, because the alternative is two descriptions of one tool drifting apart.
 *
 * The design notes, and the mapping table this implements, are in docs/mcp.md.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const CLI =
  process.env.INVOKABLE_CLI ??
  fileURLToPath(new URL('../demo-tool/bin/demo-tool.mjs', import.meta.url));

// ---------------------------------------------------------------------------
// Running the CLI
// ---------------------------------------------------------------------------

/**
 * One invocation. Always `--json`, so stdout is exactly one envelope.
 *
 * The two streams are kept apart on purpose, and this is the property that
 * makes the adapter trivial: stdout is machine-readable and complete, stderr is
 * progress for humans. A CLI that interleaved them would need parsing here.
 */
function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args, '--json'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => {
      let envelope;
      try {
        envelope = JSON.parse(stdout);
      } catch {
        // No envelope means the process died before the runtime took over —
        // a missing binary, a syntax error. Surface it as an error rather than
        // pretending it succeeded.
        return resolve({
          code,
          envelope: {
            status: 'error',
            code: 'internal',
            message: stderr.trim() || `${CLI} exited ${code} without an envelope.`,
            retryable: false,
          },
        });
      }
      resolve({ code, envelope, stderr });
    });
  });
}

/** The CLI's own description of itself: commands, options, types, exit codes. */
async function readManifest() {
  const { envelope } = await runCli(['--help']);
  return envelope.data ?? envelope;
}

// ---------------------------------------------------------------------------
// CLI options -> MCP input schema
// ---------------------------------------------------------------------------

/**
 * The input schema for one command, from the manifest.
 *
 * `choices` becomes an enum and `required` stays required, so the model is
 * constrained by the same rules the CLI enforces — a wrong `--env` is rejected
 * by the host before a process is even spawned. Everything here is derived;
 * there is no per-command code.
 */
function inputSchemaFor(command) {
  const shape = {};

  for (const opt of command.options ?? []) {
    let field;
    if (opt.type === 'boolean') field = z.boolean();
    else if (opt.choices?.length) field = z.enum([...opt.choices]);
    else field = z.string();

    if (opt.description) field = field.describe(opt.description);
    shape[opt.name] = opt.required ? field : field.optional();
  }

  for (const positional of command.positionals ?? []) {
    shape[positional] = z.string();
  }

  return shape;
}

/** The inverse: MCP arguments back into argv. */
function argvFor(command, args) {
  const argv = [command.name];
  for (const positional of command.positionals ?? []) {
    if (args[positional] !== undefined) argv.push(String(args[positional]));
  }
  for (const opt of command.options ?? []) {
    const value = args[opt.name];
    if (value === undefined || value === null) continue;
    if (opt.type === 'boolean') {
      if (value) argv.push(`--${opt.name}`);
    } else {
      argv.push(`--${opt.name}`, String(value));
    }
  }
  return argv;
}

// ---------------------------------------------------------------------------
// Envelope -> MCP tool result
// ---------------------------------------------------------------------------

function okResult(envelope) {
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope.data ?? null, null, 2) }],
    structuredContent: { status: 'ok', data: envelope.data ?? null },
  };
}

/**
 * An error the model can act on.
 *
 * `isError: true` is what tells the client this failed. The rest is what tells
 * the model whether to try again: `retryable` is the CLI's own judgement, and
 * `remediation` is usually a literal command that fixes the problem. Collapsing
 * all of this into a bare string throws away the only actionable part.
 */
function errorResult(envelope, exitCode) {
  const lines = [envelope.message];
  if (envelope.remediation) lines.push(`Try: ${envelope.remediation}`);
  if (!envelope.retryable) lines.push('Do not retry this without changing something.');

  return {
    isError: true,
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: {
      status: 'error',
      code: envelope.code,
      message: envelope.message,
      retryable: envelope.retryable ?? false,
      remediation: envelope.remediation ?? null,
      exitCode,
    },
  };
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

const manifest = await readManifest();

const server = new McpServer(
  { name: `${manifest.name}-mcp`, version: manifest.version },
  { capabilities: { tools: {} } },
);

for (const command of manifest.commands) {
  // Deciding what NOT to expose is part of writing the adapter.
  //
  //   login/logout — the device flow prints a code and waits for a browser. An
  //     MCP host has no terminal to print it to and no business holding the
  //     credential. Authentication happens out of band: the person runs
  //     `demo-tool login` once, and this server uses the token it stored.
  //   init — writes agent instruction files into a project. A developer action,
  //     not something a model should reach for mid-conversation.
  //
  // Commands that need auth and do not have it still fail correctly: exit 2,
  // `remediation: "demo-tool login"`, surfaced to the model as an error it can
  // relay to the person.
  if (['login', 'logout', 'init'].includes(command.name)) continue;

  server.registerTool(
    command.name,
    {
      description: command.description,
      inputSchema: inputSchemaFor(command),
      annotations: {
        title: command.name,
        // Straight from the manifest. A host that surfaces these lets a person
        // see which tools can change things before granting anything.
        readOnlyHint: !command.spends && /^(whoami|doctor|balance|find-)/.test(command.name),
        destructiveHint: command.spends,
        openWorldHint: true,
      },
    },
    async (args) => {
      const argv = argvFor(command, args ?? {});
      const first = await runCli(argv);

      if (first.envelope.status === 'ok') return okResult(first.envelope);
      if (first.envelope.status === 'error') return errorResult(first.envelope, first.code);

      // ---- status: "checkpoint" -------------------------------------------
      //
      // The command stopped and spent nothing. Someone has to say yes.
      //
      // Elicitation is how a server asks the *person* rather than the model.
      // That distinction is the entire value of the gate: a model that could
      // approve its own spending is not a control, it is a formality.
      const cp = first.envelope;

      let answer;
      try {
        answer = await server.server.elicitInput({
          // The panel the CLI already rendered — costs, balance, the plan. Do
          // not paraphrase it. It is the record of what the person agreed to,
          // and a summary written by a model is not that.
          message: `${cp.display}\n\n${cp.question}`,
          requestedSchema: {
            type: 'object',
            properties: {
              approve: {
                type: 'boolean',
                title: cp.question,
                description: cp.explain ?? 'Approve this action?',
              },
            },
            required: ['approve'],
          },
        });
      } catch (error) {
        // A client with no elicitation support. Hand the checkpoint back as a
        // normal result instead: the host can show it and call again with
        // `approve`. Never fall through to approving it yourself.
        return {
          content: [{ type: 'text', text: `${cp.display}\n\n${cp.question}` }],
          structuredContent: {
            status: 'checkpoint',
            gate: cp.gate,
            fingerprint: cp.fingerprint,
            question: cp.question,
            spend: cp.spend ?? null,
            approveWith: cp.next?.approve ?? null,
            reason: `This client cannot prompt: ${error instanceof Error ? error.message : error}`,
          },
        };
      }

      if (answer.action !== 'accept' || !answer.content?.approve) {
        return {
          content: [{ type: 'text', text: 'Declined. Nothing was run and nothing was charged.' }],
          structuredContent: { status: 'declined', gate: cp.gate },
        };
      }

      // Approved. Re-run with the fingerprint attached.
      //
      // Rebuilt from the same arguments rather than by splitting
      // `next.approve` on spaces: that string is shell syntax, and a path with
      // a space in it would be torn in half by a naive split.
      const second = await runCli([...argv, '--approve', `${cp.gate}@${cp.fingerprint}`]);
      if (second.envelope.status === 'ok') return okResult(second.envelope);
      return errorResult(second.envelope, second.code);
    },
  );
}

await server.connect(new StdioServerTransport());
