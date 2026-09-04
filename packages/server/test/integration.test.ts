import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClient, deviceLogin, defineTool, command, runTool, EXIT } from '@invokable/core';
import { invokableAuth, memoryStore } from '../src/index.js';
import { nodeListener } from '../src/node.js';
import type { SessionUser } from '../src/handler.js';

/**
 * The point of this file: the real @invokable/core client driving the real
 * @invokable/server handler over a real socket. Token hashing, polling,
 * back-off and revocation are exercised as they ship, not as test doubles.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

interface Harness {
  url: string;
  store: ReturnType<typeof memoryStore>;
  setUser: (user: SessionUser | null) => void;
  approveViaBrowser: (userCode: string, decision?: 'approve' | 'deny') => Promise<Response>;
}

async function harness(opts: { pollIntervalSeconds?: number } = {}): Promise<Harness> {
  const store = memoryStore();
  let user: SessionUser | null = { subject: 'ido@example.com', orgId: 'org_acme' };

  const handler = invokableAuth({
    store,
    requireSession: () => user,
    tokenPrefix: 'tst',
    pollIntervalSeconds: opts.pollIntervalSeconds ?? 0,
  });

  const server: Server = createServer(nodeListener(handler));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));

  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    store,
    setUser: (u) => {
      user = u;
    },
    approveViaBrowser: (userCode, decision = 'approve') =>
      fetch(`${url}/device/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userCode, decision }),
      }),
  };
}

function client(url: string, token?: string): ApiClient {
  return new ApiClient({
    baseUrl: url,
    toolName: 'demo-tool',
    toolVersion: '1.0.0',
    ...(token !== undefined ? { token } : {}),
  });
}

const noSleep = async (): Promise<void> => {};

async function startDevice(c: ApiClient, hostname = 'laptop') {
  return c.post<{ deviceCode: string; userCode: string }>(
    '/device/start',
    { clientName: 'demo-tool', hostname, toolVersion: '1.0.0' },
    { anonymous: true },
  );
}

describe('core client against the real server', () => {
  it('completes a device login and returns a usable token', async () => {
    const h = await harness();

    const result = await deviceLogin({
      client: client(h.url),
      toolName: 'demo-tool',
      toolVersion: '1.0.0',
      sleep: noSleep,
      hooks: { onPrompt: (start) => void h.approveViaBrowser(start.userCode) },
    });

    expect(result.token).toMatch(/^tst_[A-Za-z0-9]{32}$/);
    expect(result.subject).toBe('ido@example.com');
    expect(result.orgId).toBe('org_acme');

    const who = await client(h.url, result.token).get<{ subject: string }>('/cli/whoami');
    expect(who.subject).toBe('ido@example.com');
  });

  it('never stores the token in plaintext', async () => {
    const h = await harness();
    const result = await deviceLogin({
      client: client(h.url),
      toolName: 'demo-tool',
      toolVersion: '1.0.0',
      sleep: noSleep,
      hooks: { onPrompt: (start) => void h.approveViaBrowser(start.userCode) },
    });

    const stored = [...h.store._tokens.values()];
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(result.token);
    expect(stored[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('burns the device code so it cannot be replayed into a second token', async () => {
    const h = await harness();
    const c = client(h.url);

    const start = await startDevice(c);
    await h.approveViaBrowser(start.userCode);

    const first = await c.post<{ token: string }>(
      '/device/token',
      { deviceCode: start.deviceCode },
      { anonymous: true },
    );
    expect(first.token).toBeTruthy();

    await expect(
      c.post('/device/token', { deviceCode: start.deviceCode }, { anonymous: true }),
    ).rejects.toMatchObject({ message: expect.stringContaining('expired_token') });
    expect(h.store._tokens.size).toBe(1);
  });

  it('answers slow_down when polled faster than the interval', async () => {
    const h = await harness({ pollIntervalSeconds: 5 });
    const c = client(h.url);
    const start = await startDevice(c);

    await expect(
      c.post('/device/token', { deviceCode: start.deviceCode }, { anonymous: true }),
    ).rejects.toMatchObject({ message: expect.stringContaining('authorization_pending') });

    await expect(
      c.post('/device/token', { deviceCode: start.deviceCode }, { anonymous: true }),
    ).rejects.toMatchObject({ message: expect.stringContaining('slow_down') });
  });

  it('propagates a denial as the declined contract error', async () => {
    const h = await harness();
    await expect(
      deviceLogin({
        client: client(h.url),
        toolName: 'demo-tool',
        toolVersion: '1.0.0',
        sleep: noSleep,
        hooks: { onPrompt: (start) => void h.approveViaBrowser(start.userCode, 'deny') },
      }),
    ).rejects.toMatchObject({ code: 'declined', exitCode: EXIT.declined });
  });

  it('refuses to approve without a browser session', async () => {
    const h = await harness();
    h.setUser(null);

    const start = await startDevice(client(h.url));
    const res = await h.approveViaBrowser(start.userCode);
    expect(res.status).toBe(401);
  });

  it('rejects a revoked token', async () => {
    const h = await harness();
    const result = await deviceLogin({
      client: client(h.url),
      toolName: 'demo-tool',
      toolVersion: '1.0.0',
      sleep: noSleep,
      hooks: { onPrompt: (start) => void h.approveViaBrowser(start.userCode) },
    });

    const authed = client(h.url, result.token);
    await authed.post('/cli/logout');

    await expect(authed.get('/cli/whoami')).rejects.toMatchObject({
      code: 'auth',
      exitCode: EXIT.auth,
    });
  });

  it('rejects a forged token', async () => {
    const h = await harness();
    await expect(client(h.url, 'tst_totallymadeup').get('/cli/whoami')).rejects.toMatchObject({
      code: 'auth',
    });
  });

  it('renders an approval page showing what is being approved', async () => {
    const h = await harness();
    const start = await startDevice(client(h.url), 'my-laptop');

    const page = await (await fetch(`${h.url}/device?code=${start.userCode}`)).text();
    expect(page).toContain(start.userCode);
    expect(page).toContain('my-laptop');
    expect(page).toContain('demo-tool');
    // The user must be able to recognise a code they did not initiate.
    expect(page).toContain('Only approve this if you just started a login');
  });

  it('rejects approving the same code twice', async () => {
    const h = await harness();
    const start = await startDevice(client(h.url));

    expect((await h.approveViaBrowser(start.userCode)).status).toBe(200);
    expect((await h.approveViaBrowser(start.userCode)).status).toBe(409);
  });
});

describe('built-in CLI commands against the real server', () => {
  class Capture extends Writable {
    text = '';
    override _write(c: unknown, _e: unknown, cb: () => void): void {
      this.text += String(c);
      cb();
    }
  }

  it('login, whoami, doctor and logout work through the real runtime', async () => {
    const h = await harness();
    const dir = mkdtempSync(join(tmpdir(), 'invokable-int-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const tool = defineTool({
      name: 'demo-tool',
      version: '1.0.0',
      api: { baseUrl: h.url, authUrl: h.url },
      configDir: dir,
      commands: { noop: command({ description: 'noop', run: () => ({}) }) },
    });

    const run = async (argv: string[]) => {
      const stdout = new Capture();
      const stderr = new Capture();
      const r = await runTool(tool, { argv, streams: { stdout, stderr } });
      return { ...r, stdout: stdout.text, stderr: stderr.text };
    };

    // Approve as soon as the server reports a pending device, standing in for
    // the user clicking Approve in the browser.
    const approver = setInterval(() => {
      const pending = [...h.store._devices.values()].find((d) => d.state === 'pending');
      if (pending) void h.approveViaBrowser(pending.userCode);
    }, 10);
    cleanups.push(() => clearInterval(approver));

    const login = await run(['login', '--json']);
    clearInterval(approver);
    expect(login.exitCode).toBe(EXIT.ok);
    expect(JSON.parse(login.stdout)).toMatchObject({
      status: 'ok',
      data: { signedIn: true, subject: 'ido@example.com' },
    });

    const who = await run(['whoami', '--json']);
    expect(JSON.parse(who.stdout)).toMatchObject({ data: { subject: 'ido@example.com' } });

    const doctor = await run(['doctor', '--json']);
    const report = JSON.parse(doctor.stdout).data;
    expect(report.api.reachable).toBe(true);
    expect(report.auth.ok).toBe(true);

    const out = await run(['logout', '--json']);
    expect(JSON.parse(out.stdout)).toMatchObject({ data: { revoked: true } });

    const after = await run(['whoami', '--json']);
    expect(after.exitCode).toBe(EXIT.auth);
  });
});
