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
 * 1 and 2 come from `@invokable/server`. 3 is the part you write; here it is
 * two fake services, chosen to show the two shapes billing takes:
 *
 *   /v1/deploy     — a fixed price, known before the work.
 *   /v1/summarize  — a price that is not known until the work is done, because
 *                    it comes from model token usage. See docs/credits.md.
 *
 * Run `node examples/server/demo.mjs` in another terminal to drive it.
 */
import { createHash } from 'node:crypto';
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
import { memoryLedger } from './ledger.mjs';
import { actual, estimate } from './pricing.mjs';

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

  // Be specific. Guarding everything would also gate the planning calls, and the
  // CLI could never get a plan to show the user in the first place.
  requiresApproval: (request) => gatedSubject(new URL(request.url).pathname) !== null,

  // Must return the same `subject` the CLI passed to `checkpoint()`. It binds an
  // approval to one target, so an approval for service A cannot deploy B.
  subjectFor: (request) => gatedSubject(new URL(request.url).pathname) ?? '',
});

/**
 * Which routes spend, and what each one's approval is bound to.
 *
 * The subject is taken from the path rather than the body on purpose: this runs
 * before your handler, and reading the body here would consume the stream your
 * handler still needs. Putting the identifier in the URL keeps both readers
 * happy — and makes the guard readable at a glance.
 */
function gatedSubject(pathname) {
  if (pathname === '/v1/deploy') return 'svc-1';
  const summarize = /^\/v1\/summarize\/(.+)$/.exec(pathname);
  if (summarize) return summarize[1];
  return null;
}

/**
 * The approval that unlocked this request, as an idempotency key.
 *
 * A fingerprint names exactly one approved operation, is unguessable, and is
 * already on the request — so it is the natural key for "charge this at most
 * once", and it means a retried request cannot double-bill. See
 * ledger.capture().
 */
function approvalFingerprint(request) {
  const header = request.headers.get('x-invokable-checkpoint') ?? '';
  return header.split('@')[1] ?? null;
}

// ---------------------------------------------------------------------------
// 3. Your API
// ---------------------------------------------------------------------------

const state = { replicas: 3, image: 'api:2.4.1', balance: 100, deploys: [] };

// Your existing billing system, standing in for Stripe metering or a balances
// table. The flow below never invents a number it does not get from here.
const ledger = memoryLedger({ startingBalance: 100 });

// Quotes waiting to be approved and run.
const plans = new Map();

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

  // -------------------------------------------------------------------------
  // A price that is not known until the work is done.
  //
  // Fixed prices are the easy case. This is the one people actually have: an
  // AI call whose cost depends on how many tokens go in and how many come out,
  // and neither is known when the user is asked to approve it.
  //
  // The shape below is the answer, and it is three steps, not one.
  // -------------------------------------------------------------------------

  // Step 1 — QUOTE. Estimate an upper bound and hold it. No approval needed:
  // nothing has been charged and nothing has run.
  //
  // This route MUST be idempotent, and that is not a nicety. The approved run
  // is a fresh process: it calls this endpoint again before presenting its
  // approval. If a second call minted a second plan id, the approval — bound to
  // the first — would be refused as issued for a different subject, and the
  // command could never succeed. Ask for the same quote twice, get the same
  // quote back, holding the same credits once.
  if (pathname === '/v1/summarize/plan' && request.method === 'POST') {
    const { text = '', model = 'claude-sonnet-5' } = await request.json().catch(() => ({}));
    const subject = 'demo@example.com';

    // A real implementation counts tokens with the provider's own counter
    // (Anthropic exposes POST /v1/messages/count_tokens) rather than guessing
    // from character length: tokenizers differ by model, and a guess that is
    // 30% low is a quote that is 30% low.
    const inputTokens = Math.ceil(text.length / 4);
    const maxOutputTokens = 8000;

    const quote = estimate({ model, inputTokens, maxOutputTokens });

    // Same request, same plan. Deriving the id from the request content is the
    // simplest way to get that: no state to expire, and a client that retries a
    // quote it never received does not strand a hold.
    const id =
      'plan_' +
      createHash('sha256')
        .update(JSON.stringify([subject, model, maxOutputTokens, text]))
        .digest('hex')
        .slice(0, 16);

    const existing = plans.get(id);
    if (existing) return json(existing.plan);

    // Read what is spendable BEFORE holding. The tool passes this to
    // `checkpoint()` as `spend.balance`, and the panel renders "Balance after"
    // by subtracting the estimate from it — so handing back a figure that
    // already has this quote's own hold deducted would show the cost twice.
    const availableBefore = ledger.available(subject);

    // The hold is what makes the number the user approves mean something. Two
    // plans quoted against the same balance would otherwise both look
    // affordable, and the second one would fail after being approved.
    const hold = ledger.hold(subject, quote.credits);
    if (!hold) {
      // 402 with `insufficient_spend` is the one your tool turns into exit 4.
      // Refusing here, before the approval, is the point: never ask someone to
      // approve something you already know you cannot honour.
      return json(
        {
          error: 'insufficient_spend',
          code: 'insufficient_spend',
          message: `This needs ${quote.credits} credits; ${availableBefore} available.`,
          remediation: 'Top up at https://example.com/billing, then re-run.',
        },
        402,
      );
    }

    const plan = {
      // The plan id is also the checkpoint subject and lives in the URL of the
      // spending call, so the approval is bound to this quote and no other.
      id,
      model,
      inputTokens,
      maxOutputTokens,
      // `credits` is a CEILING, not a guess. Say so in the tool's `explain`
      // text: a user who approves 20 and is charged 7 is happy; the reverse is
      // a support ticket.
      credits: quote.credits,
      available: availableBefore,
      balance: ledger.balance(subject).balance,
    };
    plans.set(id, { plan, holdId: hold.id, text, subject });
    return json(plan);
  }

  // Step 2 — DO THE WORK, then Step 3 — CAPTURE what it really cost.
  const summarize = /^\/v1\/summarize\/(.+)$/.exec(pathname);
  if (summarize && request.method === 'POST') {
    const rejected = await requireApproval(request);
    if (rejected) return rejected;

    const record = plans.get(summarize[1]);
    if (!record) return json({ error: 'not_found', message: 'No such plan.' }, 404);
    const { plan, holdId } = record;

    // The work. Stand in for a real model call; `usage` is what the provider
    // hands back. Output lands well under the ceiling, which is the normal case
    // and exactly why quoting the ceiling is safe.
    const usage = {
      input_tokens: plan.inputTokens,
      output_tokens: Math.min(plan.maxOutputTokens, Math.ceil(plan.inputTokens / 6) + 20),
      // Cached input is billed at about a tenth of the input rate. Dropping
      // these fields and charging `input + output` overcharges precisely the
      // heaviest users. See usdForUsage() in pricing.mjs.
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const charge = actual({ model: plan.model, usage });

    // Charged under the approved ceiling, so nothing to argue about. If it ever
    // came out ABOVE, you have three honest options and must pick one in
    // advance — cap at the approved number and eat the difference, fail the
    // request having charged nothing, or stop the work at the ceiling. Silently
    // charging more than was approved is not among them. docs/credits.md walks
    // through the trade-offs.
    const capped = Math.min(charge.credits, plan.credits);

    const txn = ledger.capture(holdId, {
      credits: capped,
      // The approval is the idempotency key: a client that retries because it
      // never saw the response gets the first charge back, not a second one.
      idempotencyKey: approvalFingerprint(request),
      detail: { model: plan.model, usage },
    });

    return json({
      summary: `A ${plan.inputTokens}-token document, summarised.`,
      model: plan.model,
      usage,
      estimated: plan.credits,
      charged: txn.charged,
      balanceAfter: txn.balanceAfter,
      // Say what the difference was rather than making the user derive it. This
      // is the line that turns "why 7?" into a non-question.
      note: `Quoted ${plan.credits} (ceiling of ${plan.maxOutputTokens} output tokens); used ${usage.output_tokens}.`,
    });
  }

  // --- Read-only. An agent should be able to ask what it can afford BEFORE it
  // --- starts, and to explain a charge afterwards, without spending anything.
  if (pathname === '/v1/balance' && request.method === 'GET') {
    const subject = 'demo@example.com';
    return json({ ...ledger.balance(subject), history: ledger.history(subject) });
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
  console.error('  your api    POST /v1/deploy/plan        POST /v1/deploy            (guarded)');
  console.error('              POST /v1/summarize/plan     POST /v1/summarize/:planId (guarded)');
  console.error('              GET  /v1/balance');
  console.error('');
  console.error('  Drive it:  node examples/server/demo.mjs');
});
