#!/usr/bin/env node
/**
 * A complete invokable backend, in one file.
 *
 *   node examples/server/server.mjs
 *
 * It serves three things a tool needs, and one it provides itself:
 *
 *   1. Auth        — the device-code endpoints `login` talks to.       (SDK)
 *   2. Checkpoints — issuing and verifying approval fingerprints.      (SDK)
 *   3. Your API    — the endpoints your tool actually calls.           (yours)
 *
 * 1 and 2 come from `@invokable/server`. 3 is the part you write; here it is a
 * fake deployment service so the whole round trip can be watched.
 *
 * Run `node examples/server/demo.mjs` in another terminal to drive it.
 */
import { createServer } from 'node:http';
import {
  CheckpointVerifier,
  checkpointRoutes,
  invokableAuth,
  memoryCheckpointStore,
  memoryStore,
  verifyCheckpoint,
} from '@invokable/server';
import { nodeListener } from '@invokable/server/node';

const PORT = Number(process.env.PORT ?? 8787);

// The HMAC key that signs approval fingerprints. In production this comes from
// your secret manager and never leaves your infrastructure — that is the whole
// reason checkpoints are verified here rather than by a third party.
const CHECKPOINT_SECRET = process.env.CHECKPOINT_SECRET ?? 'dev-only-not-a-real-secret';

// ---------------------------------------------------------------------------
// 1. Auth
// ---------------------------------------------------------------------------

const authHandler = invokableAuth({
  // Development only: everything is lost on restart. Swap for a database-backed
  // store before anyone depends on staying logged in.
  store: memoryStore(),

  // Appears at the start of every issued token, e.g. `demo_a1b2c3…`.
  tokenPrefix: 'demo',

  // THE HOOK YOU MUST REPLACE.
  //
  // This runs on the approval page, in the user's browser. It answers "who is
  // signed in right now?" from your own session — a cookie, a JWT, whatever you
  // already use. Returning null means signed out, and nothing can be approved.
  //
  // Here it returns a fixed user so the flow runs without a login system.
  requireSession: (_request) => ({
    subject: 'demo@example.com',
    orgId: 'org_demo',
    displayName: 'Demo User',
  }),

  // Optional: your own branded approval page.
  //
  // If you replace the default, KEEP the part that shows which tool, version and
  // machine requested the login, and the warning to approve only a login you
  // just started. That display is the only defence against someone sending a
  // user their code and asking them to approve it.
  //
  // approvePage: ({ device, user }) => renderMyPage(device, user),

  // null = long-lived tokens, revoked explicitly by `logout`.
  tokenTtl: null,
});

// ---------------------------------------------------------------------------
// 2. Checkpoints
// ---------------------------------------------------------------------------

const verifier = new CheckpointVerifier({
  secret: CHECKPOINT_SECRET,
  // During a key rotation, set this to the old secret for 24h so approvals
  // issued just before the swap still verify.
  // previousSecret: process.env.CHECKPOINT_SECRET_PREVIOUS,
  store: memoryCheckpointStore(),
});

// Serves POST /checkpoints (issue) and POST /checkpoints/verify (check).
// `checkpoint()` in the CLI calls these; you never call them yourself.
const checkpointHandler = checkpointRoutes({ verifier });

// Guards the endpoints that actually spend. It reads the approval from the
// request header, checks it against the plan the user was shown, and burns it —
// so an approval is consumed by the operation it authorised, and cannot be
// replayed.
const requireApproval = verifyCheckpoint({
  verifier,

  // Be specific. Guarding everything would also gate the planning call, and the
  // CLI could never get a plan to show the user in the first place.
  requiresApproval: (request) => new URL(request.url).pathname === '/v1/deploy',

  // Must return the same `subject` the CLI passed to `checkpoint()`. It binds an
  // approval to one target, so an approval for service A cannot deploy B.
  subjectFor: () => 'svc-1',
});

// ---------------------------------------------------------------------------
// 3. Your API
// ---------------------------------------------------------------------------

const state = { replicas: 3, image: 'api:2.4.1', balance: 100, deploys: [] };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function handleRequest(request) {
  const { pathname } = new URL(request.url);

  // --- Planning: no approval needed. It changes nothing and produces the
  // --- summary the user is about to be asked to approve.
  if (pathname === '/v1/deploy/plan' && request.method === 'POST') {
    const { env } = await request.json().catch(() => ({}));
    return json({
      id: 'svc-1',
      env,
      replicas: state.replicas,
      image: state.image,
      credits: 12,
      balance: state.balance,
    });
  }

  // --- Spending: guarded.
  if (pathname === '/v1/deploy' && request.method === 'POST') {
    // Returns a 409 the CLI turns into exit 12 when the approval is missing,
    // stale, expired or already used. Returns null when it is good.
    const rejected = await requireApproval(request);
    if (rejected) return rejected;

    const body = await request.json().catch(() => ({}));
    const id = `dep_${state.deploys.length + 1}`;
    state.deploys.push(id);
    state.balance -= 12;
    return json({ deployed: true, id, env: body.env, balanceAfter: state.balance });
  }

  // --- Handy for watching the demo. Not part of the contract.
  if (pathname === '/v1/state') return json(state);

  // Fall through to the SDK handlers. Each returns null for paths it does not
  // own, so they compose with your routes in any order.
  return (await authHandler(request)) ?? (await checkpointHandler(request)) ?? null;
}

createServer(nodeListener(handleRequest)).listen(PORT, () => {
  console.error(`invokable example server on http://127.0.0.1:${PORT}`);
  console.error('');
  console.error('  auth        POST /device/start  GET /device  POST /device/token');
  console.error('              GET  /cli/whoami    POST /cli/logout');
  console.error('  checkpoints POST /checkpoints   POST /checkpoints/verify');
  console.error('  your api    POST /v1/deploy/plan   POST /v1/deploy  (guarded)');
  console.error('');
  console.error('  Drive it:  node examples/server/demo.mjs');
});
