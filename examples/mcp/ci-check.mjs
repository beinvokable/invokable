#!/usr/bin/env node
/**
 * Checks that the MCP adapter still exposes the CLI's real surface.
 *
 *   node examples/mcp/ci-check.mjs
 *
 * No backend needed — the tool list comes from `--help --json`, so this catches
 * the adapter drifting from the CLI without a network round trip. The three
 * things asserted are the three that would be quietly wrong for a long time:
 * interactive auth leaking onto the MCP surface, a spending command losing its
 * destructive flag, and `choices` failing to survive as an enum.
 */
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const fail = (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const client = new Client({ name: 'ci', version: '0.0.0' }, { capabilities: {} });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('./server.mjs', import.meta.url))],
  }),
);

try {
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  // The device flow needs a terminal and a browser. An MCP host has neither,
  // and should never be handed the credential either.
  for (const name of ['login', 'logout', 'init']) {
    if (byName.has(name)) fail(`${name} must not be exposed over MCP`);
  }

  // A host that surfaces annotations lets a person see what can spend before
  // granting anything. Losing the flag loses that.
  const deploy = byName.get('deploy');
  if (!deploy) fail('deploy is missing from the tool list');
  if (!deploy.annotations?.destructiveHint) fail('deploy is not marked destructive');

  // `choices` becoming an enum is what lets the host reject a bad value before
  // a process is spawned.
  const env = deploy.inputSchema?.properties?.env;
  if (JSON.stringify(env?.enum) !== JSON.stringify(['staging', 'prod'])) {
    fail(`deploy --env lost its choices: ${JSON.stringify(env)}`);
  }

  console.log(`✓ ${tools.length} tools exposed, spend flags and enums intact`);
} finally {
  await client.close().catch(() => {});
}
