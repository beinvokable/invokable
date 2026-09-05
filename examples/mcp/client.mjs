#!/usr/bin/env node
/**
 * Drives the MCP server so the whole exchange is visible.
 *
 *   node examples/server/server.mjs     # terminal 1 — the backend
 *   node examples/mcp/client.mjs        # terminal 2 — this
 *
 * It stands in for Claude Desktop, an IDE, or any other MCP host: it lists the
 * tools, calls a read-only one, then calls one that spends — and answers the
 * elicitation the way a person clicking "Approve" would.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const SERVER = process.env.SERVER ?? 'http://127.0.0.1:8787';
const configDir = mkdtempSync(join(tmpdir(), 'invokable-mcp-'));

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const step = (t) => console.log(`\n${bold(`── ${t} ${'─'.repeat(Math.max(0, 56 - t.length))}`)}`);

if (!(await fetch(`${SERVER}/v1/state`).then(() => true).catch(() => false))) {
  console.error(`No backend at ${SERVER}. Start it first:\n\n  node examples/server/server.mjs\n`);
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('./server.mjs', import.meta.url))],
  env: { ...process.env, DEMO_TOOL_API: SERVER, DEMO_TOOL_CONFIG_DIR: configDir },
});

const client = new Client(
  { name: 'demo-host', version: '0.0.0' },
  // Declaring elicitation is what lets the server ask a person. A host that
  // omits it gets the checkpoint back as data instead — see server.mjs.
  { capabilities: { elicitation: {} } },
);

// What a host does when the server asks for approval: show the panel, get an
// answer from the person, send it back. Auto-answering "yes" here is the demo
// faking the click — in a real host this is a dialog, and the whole point is
// that a model cannot answer it.
let pendingApproval = null;
client.setRequestHandler(ElicitRequestSchema, async (request) => {
  pendingApproval = request.params.message;
  return { action: 'accept', content: { approve: true } };
});

try {
  await client.connect(transport);

  step('1. What can this server do?');
  console.log(dim('  Generated from the CLI manifest — nothing hand-written.'));
  const { tools } = await client.listTools();
  for (const tool of tools) {
    const spends = tool.annotations?.destructiveHint ? ' [spends]' : '';
    console.log(`  ${tool.name}${spends}`);
  }

  step('2. Sign in — OUT OF BAND, not through MCP');
  console.log(dim('  The device flow needs a terminal and a browser. An MCP host'));
  console.log(dim('  has neither, so the person does this once and the server'));
  console.log(dim('  reuses the stored token. Note `login` is not in the list above.'));
  await signInWithCli();

  step('3. A tool that spends — the server asks the PERSON');
  const doc = join(configDir, 'report.txt');
  writeFileSync(doc, 'Quarterly figures and the commentary around them. '.repeat(1600));
  const result = await client.callTool({ name: 'summarize', arguments: { file: doc } });

  console.log(dim('\n  The server elicited this before running anything:\n'));
  console.log(pendingApproval);

  console.log(dim('\n  Approved, so the command re-ran with the fingerprint:\n'));
  console.log(JSON.stringify(result.structuredContent, null, 2));

  step('4. A failure the model can act on');
  console.log(dim('  isError, plus the remediation and whether retrying is worth it.'));
  const failed = await client.callTool({ name: 'find-project', arguments: { slug: 'nope' } });
  console.log(JSON.stringify(failed.structuredContent, null, 2));

  console.log(dim('\n  One CLI. Terminal, agent skill, and MCP — same contract.\n'));
} finally {
  await client.close().catch(() => {});
  rmSync(configDir, { recursive: true, force: true });
}

/**
 * Runs the real CLI's device flow, performing the browser click over HTTP.
 *
 * This is deliberately NOT an MCP call. It is what the person does in their own
 * terminal before pointing a host at the server.
 */
function signInWithCli() {
  const cli = fileURLToPath(new URL('../demo-tool/bin/demo-tool.mjs', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'login', '--json'], {
      env: { ...process.env, DEMO_TOOL_API: SERVER, DEMO_TOOL_CONFIG_DIR: configDir },
    });
    let err = '';
    let sent = false;
    child.stderr.on('data', (chunk) => {
      err += chunk;
      const code = /[A-Z0-9]{4}-[A-Z0-9]{4}/.exec(err)?.[0];
      if (code && !sent) {
        sent = true;
        // What the approval page's form does when the person clicks Approve.
        fetch(`${SERVER}/device/approve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ userCode: code, decision: 'approve' }),
        }).catch(reject);
      }
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`login exited ${code}\n${err}`)),
    );
  }).then(() => console.log(dim('  Signed in. Token stored where the MCP server will find it.')));
}
