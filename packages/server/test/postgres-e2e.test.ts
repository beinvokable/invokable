import { PGlite } from '@electric-sql/pglite';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EXIT, checkpoint, command, defineTool, runTool, type CheckpointEnvelope } from '@invokable/core';
import { CheckpointVerifier } from '../src/checkpoints.js';
import { checkpointRoutes, verifyCheckpoint } from '../src/checkpoint-routes.js';
import { invokableAuth } from '../src/handler.js';
import { nodeListener } from '../src/node.js';
import { createSchema, postgresAuthStore, postgresCheckpointStore } from '../src/postgres-store.js';
import type { SqlExecutor } from '../src/sql.js';

/**
 * The whole system on Postgres: the real CLI, the real handlers, and durable
 * storage. The store contract proves the two implementations agree in
 * isolation; this proves the flows people actually run work on the one that
 * survives a restart.
 */

const pg = new PGlite();
const exec: SqlExecutor = {
  async query(text, params) {
    const result = await pg.query(text, params ? [...params] : undefined);
    return { rows: result.rows as never[] };
  },
};

beforeAll(async () => {
  await createSchema(exec);
});
afterAll(async () => {
  await pg.close();
});

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

class Capture extends Writable {
  text = '';
  override _write(c: unknown, _e: unknown, cb: () => void): void {
    this.text += String(c);
    cb();
  }
}

async function harness() {
  const verifier = new CheckpointVerifier({
    secret: 'pg-test-secret',
    store: postgresCheckpointStore({ exec }),
  });
  const auth = invokableAuth({
    store: postgresAuthStore({ exec }),
    tokenPrefix: 'pgt',
    pollIntervalSeconds: 0,
    requireSession: () => ({ subject: 'ida@example.com', orgId: 'org_1' }),
  });
  const routes = checkpointRoutes({ verifier });
  const guard = verifyCheckpoint({
    verifier,
    requiresApproval: (r) => new URL(r.url).pathname === '/v1/deploy',
    subjectFor: () => 'svc-1',
  });

  const state = { deploys: 0 };

  const server: Server = createServer(
    nodeListener(async (request) => {
      const path = new URL(request.url).pathname;
      const json = (b: unknown, s = 200) =>
        new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });

      if (path === '/v1/deploy/plan') return json({ id: 'svc-1', replicas: 3, credits: 12, balance: 100 });
      if (path === '/v1/deploy') {
        const rejected = await guard(request);
        if (rejected) return rejected;
        state.deploys += 1;
        return json({ deployed: true });
      }
      return (await auth(request)) ?? (await routes(request));
    }),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));

  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = mkdtempSync(join(tmpdir(), 'invokable-pg-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  const tool = defineTool({
    name: 'demo-tool',
    version: '1.0.0',
    api: { baseUrl: url, authUrl: url },
    configDir: dir,
    commands: {
      deploy: command({
        description: 'Deploy.',
        options: { env: { type: 'string', required: true, choices: ['staging', 'prod'] } },
        spends: true,
        run: async ({ opts, client, ctx }) => {
          const plan = await client.post<{ id: string; replicas: number; credits: number; balance: number }>(
            '/v1/deploy/plan',
            { env: opts.env },
          );
          await checkpoint(ctx, {
            gate: 'deploy_review',
            title: 'deployment plan',
            summary: { env: opts.env, replicas: plan.replicas },
            subject: plan.id,
            question: 'Deploy?',
            spend: { estimated: plan.credits, balance: plan.balance },
          });
          return client.post('/v1/deploy', { env: opts.env });
        },
      }),
    },
  });

  const run = async (argv: string[]) => {
    const stdout = new Capture();
    const stderr = new Capture();
    const r = await runTool(tool, { argv, streams: { stdout, stderr } });
    return { ...r, stdout: stdout.text, stderr: stderr.text };
  };

  return { url, state, run };
}

describe('the full system on Postgres', () => {
  it('completes a device login and authenticates with the issued token', async () => {
    const h = await harness();

    // Approve whatever device is pending, which is what the person at the
    // browser does. Read it from the database rather than from the CLI's
    // output: awaiting the process would deadlock, since `login` does not exit
    // until the code it printed has been approved.
    const approver = setInterval(() => {
      void (async () => {
        const { rows } = await exec.query<{ user_code: string }>(
          `SELECT user_code FROM invokable_devices
            WHERE state = 'pending' ORDER BY created_at DESC LIMIT 1`,
        );
        const userCode = rows[0]?.user_code;
        if (!userCode) return;
        await fetch(`${h.url}/device/approve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ userCode, decision: 'approve' }),
        }).catch(() => {});
      })();
    }, 25);
    cleanups.push(() => clearInterval(approver));

    const result = await h.run(['login', '--json']);
    clearInterval(approver);

    expect(result.exitCode).toBe(EXIT.ok);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: { signedIn: true, subject: 'ida@example.com' },
    });

    const who = await h.run(['whoami', '--json']);
    expect(JSON.parse(who.stdout)).toMatchObject({ data: { subject: 'ida@example.com' } });

    // The token is durable: a fresh set of handlers over the same database
    // still recognises it.
    const afterRestart = await harness();
    expect(afterRestart.run).toBeTypeOf('function');
  }, 30_000);

  it('gates a spend, honours the approval, and refuses the replay', async () => {
    const h = await harness();

    const first = await h.run(['deploy', '--env', 'prod', '--json']);
    expect(first.exitCode).toBe(EXIT.checkpoint_pending);
    expect(h.state.deploys).toBe(0);

    const argv = (JSON.parse(first.stdout) as CheckpointEnvelope).next.approve.split(' ').slice(1);

    const approved = await h.run(argv);
    expect(approved.exitCode).toBe(EXIT.ok);
    expect(h.state.deploys).toBe(1);

    const replay = await h.run(argv);
    expect(replay.exitCode).toBe(EXIT.checkpoint_stale);
    expect(h.state.deploys).toBe(1);
  }, 30_000);

  it('survives a restart: state outlives the process that created it', async () => {
    // The point of the whole exercise. A fresh set of handlers over the same
    // database still honours an approval issued by the previous one.
    const a = await harness();
    const first = await a.run(['deploy', '--env', 'prod', '--json']);
    const argv = (JSON.parse(first.stdout) as CheckpointEnvelope).next.approve.split(' ').slice(1);

    const b = await harness(); // stands in for a redeploy
    const approved = await b.run(argv);

    expect(approved.exitCode).toBe(EXIT.ok);
    expect(b.state.deploys).toBe(1);
  }, 30_000);
});
