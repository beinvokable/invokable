import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXIT,
  checkpoint,
  command,
  defineTool,
  runTool,
  type CheckpointEnvelope,
} from '@invokable/core';
import {
  CheckpointVerifier,
  checkpointRoutes,
  memoryCheckpointStore,
  verifyCheckpoint,
} from '../src/index.js';
import { nodeListener } from '../src/node.js';

/**
 * The whole gate, end to end: a real CLI command that plans, stops for
 * approval, and only deploys once a server-issued fingerprint is consumed.
 */

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

interface Harness {
  url: string;
  /** Mutable so a test can change the plan between approval and use. */
  replicas: number;
  deploys: number;
  verifier: CheckpointVerifier;
}

async function harness(): Promise<Harness> {
  const store = memoryCheckpointStore();
  const verifier = new CheckpointVerifier({ secret: 'test-secret', store });
  const routes = checkpointRoutes({ verifier });
  const guard = verifyCheckpoint({
    verifier,
    // Only the deploy endpoint spends; planning must stay ungated.
    requiresApproval: (req) => new URL(req.url).pathname.endsWith('/v1/deploy'),
    subjectFor: () => 'svc-1',
  });

  const state: Harness = { url: '', replicas: 3, deploys: 0, verifier };

  const listener = nodeListener(async (request: Request) => {
    const path = new URL(request.url).pathname;

    if (path === '/v1/deploy/plan' && request.method === 'POST') {
      return new Response(
        JSON.stringify({ env: 'prod', replicas: state.replicas, credits: 12, balance: 100 }),
        { headers: { 'content-type': 'application/json' } },
      );
    }

    if (path === '/v1/deploy' && request.method === 'POST') {
      const rejected = await guard(request);
      if (rejected) return rejected;
      state.deploys += 1;
      return new Response(JSON.stringify({ deployed: true, id: 'dep_1' }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    return routes(request);
  });

  const server: Server = createServer(listener);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}

function toolFor(h: Harness) {
  const dir = mkdtempSync(join(tmpdir(), 'invokable-cp-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  return defineTool({
    name: 'demo-tool',
    version: '1.0.0',
    api: { baseUrl: h.url },
    configDir: dir,
    commands: {
      deploy: command({
        description: 'Deploy the current project.',
        options: { env: { type: 'string', required: true, choices: ['staging', 'prod'] } },
        spends: true,
        run: async ({ opts, client, ctx }) => {
          const plan = await client.post<{ replicas: number; credits: number; balance: number }>(
            '/v1/deploy/plan',
            { env: opts.env },
          );

          await checkpoint(ctx, {
            gate: 'deploy_review',
            title: 'deployment plan',
            summary: { env: opts.env, replicas: plan.replicas },
            subject: 'svc-1',
            question: 'Deploy this plan?',
            explain: 'Approving starts the deploy and bills 1 credit per minute.',
            spend: { estimated: plan.credits, balance: plan.balance },
            reject: `demo-tool deploy --env ${opts.env} --dry-run`,
          });

          return client.post('/v1/deploy', { env: opts.env });
        },
      }),
    },
  });
}

class Capture extends Writable {
  text = '';
  override _write(c: unknown, _e: unknown, cb: () => void): void {
    this.text += String(c);
    cb();
  }
}

async function run(tool: ReturnType<typeof toolFor>, argv: string[]) {
  const stdout = new Capture();
  const stderr = new Capture();
  const result = await runTool(tool, { argv, streams: { stdout, stderr } });
  return {
    ...result,
    stdout: stdout.text,
    stderr: stderr.text,
    json: () => JSON.parse(stdout.text.trim()),
  };
}

describe('checkpoint gate, end to end', () => {
  it('stops at the gate with exit 10 and a runnable approve command', async () => {
    const h = await harness();
    const tool = toolFor(h);

    const r = await run(tool, ['deploy', '--env', 'prod', '--json']);

    expect(r.exitCode).toBe(EXIT.checkpoint_pending);
    const env = r.json() as CheckpointEnvelope;
    expect(env.status).toBe('checkpoint');
    expect(env.schema).toBe('invokable.checkpoint/v1');
    expect(env.gate).toBe('deploy_review');
    expect(env.fingerprint).toMatch(/^[A-Z2-7]{16}$/);
    expect(env.spend).toEqual({ estimated: 12, balance: 100 });
    expect(env.next.approve).toBe(
      `demo-tool deploy --env prod --json --approve deploy_review@${env.fingerprint}`,
    );
    expect(env.next.reject).toBe('demo-tool deploy --env prod --dry-run');

    // Nothing was deployed by merely asking.
    expect(h.deploys).toBe(0);
  });

  it('shows the human a panel describing the cost', async () => {
    const h = await harness();
    const r = await run(toolFor(h), ['deploy', '--env', 'prod', '--json']);
    const env = r.json() as CheckpointEnvelope;

    expect(env.display).toContain('DEPLOYMENT PLAN');
    // Pretty-printed JSON keeps its indentation inside the panel.
    expect(env.display).toContain('  "replicas": 3');
    expect(env.display).toContain('Cost: 12 credits');
    expect(env.display).toContain('Balance after: 88 credits');
    expect(env.display).toContain('Deploy this plan?');
  });

  it('hands back an approve command that actually runs', async () => {
    // Regression guard: an earlier version emitted `demo-tool deploy --approve …`
    // with the original options dropped, so the command the agent was told to
    // run failed with a usage error. Parse and execute what we published.
    const h = await harness();
    const tool = toolFor(h);

    const first = await run(tool, ['deploy', '--env', 'prod', '--json']);
    const approve = (first.json() as CheckpointEnvelope).next.approve;

    const argv = approve.split(' ').slice(1); // drop the binary name
    const second = await run(tool, argv);

    expect(second.exitCode).toBe(EXIT.ok);
    expect(h.deploys).toBe(1);
  });

  it('drops a previous --approve when rebuilding the command', async () => {
    const h = await harness();
    const tool = toolFor(h);

    const stale = await run(tool, [
      'deploy', '--env', 'prod', '--approve', 'deploy_review@AAAAAAAAAAAAAAAA', '--json',
    ]);
    expect(stale.exitCode).toBe(EXIT.checkpoint_stale);

    // Re-running without --approve produces a fresh gate whose approve command
    // carries exactly one --approve.
    const fresh = await run(tool, ['deploy', '--env', 'prod', '--json']);
    const approve = (fresh.json() as CheckpointEnvelope).next.approve;
    expect(approve.match(/--approve/g)).toHaveLength(1);
  });

  it('proceeds when the approval is supplied, and deploys exactly once', async () => {
    const h = await harness();
    const tool = toolFor(h);

    const first = await run(tool, ['deploy', '--env', 'prod', '--json']);
    const fp = (first.json() as CheckpointEnvelope).fingerprint;

    const second = await run(tool, [
      'deploy', '--env', 'prod', '--approve', `deploy_review@${fp}`, '--json',
    ]);

    expect(second.exitCode).toBe(EXIT.ok);
    expect(second.json()).toMatchObject({ status: 'ok', data: { deployed: true } });
    expect(h.deploys).toBe(1);
  });

  it('refuses to reuse an approval (one-shot)', async () => {
    const h = await harness();
    const tool = toolFor(h);

    const first = await run(tool, ['deploy', '--env', 'prod', '--json']);
    const fp = (first.json() as CheckpointEnvelope).fingerprint;
    const args = ['deploy', '--env', 'prod', '--approve', `deploy_review@${fp}`, '--json'];

    expect((await run(tool, args)).exitCode).toBe(EXIT.ok);

    const replay = await run(tool, args);
    expect(replay.exitCode).toBe(EXIT.checkpoint_stale);
    expect(replay.json()).toMatchObject({ status: 'error', code: 'checkpoint_stale' });
    expect(h.deploys).toBe(1);
  });

  it('rejects an approval after the plan changed underneath', async () => {
    const h = await harness();
    const tool = toolFor(h);

    const first = await run(tool, ['deploy', '--env', 'prod', '--json']);
    const fp = (first.json() as CheckpointEnvelope).fingerprint;

    // The world moved on between planning and approving.
    h.replicas = 300;

    const approved = await run(tool, [
      'deploy', '--env', 'prod', '--approve', `deploy_review@${fp}`, '--json',
    ]);

    expect(approved.exitCode).toBe(EXIT.checkpoint_stale);
    expect((approved.json() as { message: string }).message).toContain('changed');
    expect(h.deploys).toBe(0);
  });

  it('rejects a forged fingerprint', async () => {
    const h = await harness();
    const r = await run(toolFor(h), [
      'deploy', '--env', 'prod', '--approve', 'deploy_review@AAAAAAAAAAAAAAAA', '--json',
    ]);

    expect(r.exitCode).toBe(EXIT.checkpoint_stale);
    expect(h.deploys).toBe(0);
  });

  it('cannot be bypassed by calling the deploy endpoint without an approval', async () => {
    const h = await harness();
    const res = await fetch(`${h.url}/v1/deploy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ env: 'prod' }),
    });

    expect(res.status).toBe(409);
    expect(h.deploys).toBe(0);
  });

  it('--yes proceeds, warns on stderr, and still records an approval', async () => {
    const h = await harness();
    const tool = toolFor(h);

    const r = await run(tool, ['deploy', '--env', 'prod', '--yes', '--json']);

    expect(r.exitCode).toBe(EXIT.ok);
    expect(h.deploys).toBe(1);
    expect(r.stderr).toContain('auto-approved');
    // The audit trail exists even though no human answered.
    expect(r.stdout).not.toContain('auto-approved');
  });

  it('--max-spend overrides --yes and falls back to the gate', async () => {
    const h = await harness();
    const tool = toolFor(h);

    const r = await run(tool, [
      'deploy', '--env', 'prod', '--yes', '--max-spend', '5', '--json',
    ]);

    expect(r.exitCode).toBe(EXIT.checkpoint_pending);
    expect(r.stderr).toContain('exceeds --max-spend');
    expect(h.deploys).toBe(0);
  });

  it('--yes proceeds when the estimate is within --max-spend', async () => {
    const h = await harness();
    const r = await run(toolFor(h), [
      'deploy', '--env', 'prod', '--yes', '--max-spend', '50', '--json',
    ]);

    expect(r.exitCode).toBe(EXIT.ok);
    expect(h.deploys).toBe(1);
  });

  it('an approval for one gate does not authorise another', async () => {
    const h = await harness();
    const tool = toolFor(h);

    const first = await run(tool, ['deploy', '--env', 'prod', '--json']);
    const fp = (first.json() as CheckpointEnvelope).fingerprint;

    const wrongGate = await run(tool, [
      'deploy', '--env', 'prod', '--approve', `some_other_gate@${fp}`, '--json',
    ]);

    // The supplied approval is for a different gate, so this one is still pending.
    expect(wrongGate.exitCode).toBe(EXIT.checkpoint_pending);
    expect(h.deploys).toBe(0);
  });
});
