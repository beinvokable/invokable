#!/usr/bin/env node
/**
 * A self-hosted auth server in about thirty lines.
 *
 *   node examples/self-host-auth/server.mjs
 *   DEMO_TOOL_API=http://127.0.0.1:8787 \
 *   DEMO_TOOL_CONFIG_DIR=/tmp/demo-cfg \
 *     node examples/demo-tool/bin/demo-tool.mjs login
 *
 * `requireSession` is where a real deployment plugs in its own login. Here it
 * returns a fixed user so the flow can be exercised without one.
 */
import { createServer } from 'node:http';
import { invokableAuth, memoryStore } from '@invokable/server';
import { nodeListener } from '@invokable/server/node';

const port = Number(process.env.PORT ?? 8787);

const handler = invokableAuth({
  store: memoryStore(),
  tokenPrefix: 'demo',

  // Replace with your own session lookup. Returning null means "signed out",
  // and no device code can be approved.
  requireSession: () => ({
    subject: 'demo@example.com',
    orgId: 'org_demo',
    displayName: 'Demo User',
  }),

  // Optional: supply a branded page. The default explains what is being
  // approved, which is the part that matters.
  // approvePage: ({ device, user }) => renderMyPage(device, user),
});

createServer(nodeListener(handler)).listen(port, () => {
  console.error(`invokable auth listening on http://127.0.0.1:${port}`);
  console.error(`approval page: http://127.0.0.1:${port}/device?code=<USER-CODE>`);
});
