import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defineTool, command } from '../src/schema.js';
import { ApiClient } from '../src/http.js';
import { deviceLogin } from '../src/device-flow.js';
import { EXIT } from '../src/exit-codes.js';
import { startFakeAuthServer, type FakeAuthServer } from './auth-server.js';
import { invoke } from './helpers.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempConfigDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'invokable-auth-'));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

async function server(): Promise<FakeAuthServer> {
  const s = await startFakeAuthServer();
  cleanups.push(() => s.close());
  return s;
}

function toolFor(s: FakeAuthServer, configDir: string) {
  return defineTool({
    name: 'demo-tool',
    version: '9.9.9',
    api: { baseUrl: s.url, authUrl: s.url },
    configDir,
    commands: {
      ping: command({
        description: 'Authenticated call.',
        run: async ({ client }) => client.get('/cli/whoami'),
      }),
    },
  });
}

const noSleep = async (): Promise<void> => {};

describe('device-code flow', () => {
  it('polls until approval and returns the token', async () => {
    const s = await server();
    const client = new ApiClient({ baseUrl: s.url, toolName: 'demo-tool', toolVersion: '9.9.9' });

    const result = await deviceLogin({
      client,
      toolName: 'demo-tool',
      toolVersion: '9.9.9',
      sleep: noSleep,
      hooks: { onPrompt: (start) => s.approve(start.userCode) },
    });

    expect(result.token).toMatch(/^tst_/);
    expect(result.subject).toBe('user_1');
    expect(result.orgId).toBe('org_1');
  });

  it('keeps polling through authorization_pending', async () => {
    const s = await server();
    const client = new ApiClient({ baseUrl: s.url, toolName: 'demo-tool', toolVersion: '9.9.9' });

    let polls = 0;
    const result = await deviceLogin({
      client,
      toolName: 'demo-tool',
      toolVersion: '9.9.9',
      sleep: noSleep,
      hooks: {
        onPrompt: () => {},
        onPoll: (attempt) => {
          polls = attempt;
          // Approve only on the third poll, so two return authorization_pending.
          if (attempt === 3) s.approve('CODE-1');
        },
      },
    });

    expect(polls).toBeGreaterThanOrEqual(3);
    expect(result.token).toBeTruthy();
  });

  it('backs off when the server says slow_down', async () => {
    const s = await server();
    const client = new ApiClient({ baseUrl: s.url, toolName: 'demo-tool', toolVersion: '9.9.9' });
    s.slowDownFor(2);

    const waits: number[] = [];
    const result = await deviceLogin({
      client,
      toolName: 'demo-tool',
      toolVersion: '9.9.9',
      sleep: async (ms) => {
        waits.push(ms);
      },
      hooks: { onPrompt: (start) => s.approve(start.userCode) },
    });

    expect(result.token).toBeTruthy();
    // Each slow_down doubles the interval rather than repeating it.
    expect(waits[1]).toBeGreaterThan(waits[0]!);
    expect(waits[2]).toBeGreaterThan(waits[1]!);
  });

  it('maps access_denied to the declined contract error', async () => {
    const s = await server();
    const client = new ApiClient({ baseUrl: s.url, toolName: 'demo-tool', toolVersion: '9.9.9' });

    await expect(
      deviceLogin({
        client,
        toolName: 'demo-tool',
        toolVersion: '9.9.9',
        sleep: noSleep,
        hooks: { onPrompt: (start) => s.deny(start.userCode) },
      }),
    ).rejects.toMatchObject({ code: 'declined', exitCode: EXIT.declined });
  });

  it('maps expired_token to a retryable timeout', async () => {
    const s = await server();
    const client = new ApiClient({ baseUrl: s.url, toolName: 'demo-tool', toolVersion: '9.9.9' });

    await expect(
      deviceLogin({
        client,
        toolName: 'demo-tool',
        toolVersion: '9.9.9',
        sleep: noSleep,
        hooks: { onPrompt: (start) => s.expire(start.userCode) },
      }),
    ).rejects.toMatchObject({ code: 'timeout', retryable: true });
  });
});

describe('built-in commands end to end', () => {
  it('login stores a token, whoami reads it, logout revokes it', async () => {
    const s = await server();
    const dir = tempConfigDir();
    const tool = toolFor(s, dir);

    // Approve as soon as the code is shown. `login` prints the prompt to
    // stderr, so poll the server's request log instead of hooking internals.
    const approver = setInterval(() => s.approve('CODE-1'), 5);
    cleanups.push(() => clearInterval(approver));

    const login = await invoke(tool, ['login', '--json']);
    clearInterval(approver);
    expect(login.exitCode).toBe(EXIT.ok);
    expect(login.json()).toMatchObject({ status: 'ok', data: { signedIn: true, subject: 'user_1' } });
    expect(login.stderr).toContain('CODE-1');
    // The secret must never appear on stdout.
    expect(login.stdout).not.toContain('tst_');

    const who = await invoke(tool, ['whoami', '--json']);
    expect(who.exitCode).toBe(EXIT.ok);
    expect(who.json()).toMatchObject({ status: 'ok', data: { subject: 'user_1' } });

    const out = await invoke(tool, ['logout', '--json']);
    expect(out.exitCode).toBe(EXIT.ok);
    expect(out.json()).toMatchObject({ data: { revoked: true, localTokenCleared: true } });
    expect(s.revoked).toHaveLength(1);

    const after = await invoke(tool, ['whoami', '--json']);
    expect(after.exitCode).toBe(EXIT.auth);
    expect(after.json()).toMatchObject({ code: 'auth', remediation: 'demo-tool login' });
  });

  it('whoami without a token exits 3 with a remediation', async () => {
    const s = await server();
    const tool = toolFor(s, tempConfigDir());

    const r = await invoke(tool, ['whoami', '--json']);
    expect(r.exitCode).toBe(EXIT.auth);
    expect(r.json()).toMatchObject({
      status: 'error',
      code: 'auth',
      remediation: 'demo-tool login',
      retryable: false,
    });
  });

  it('logout clears the local token even when the server is unreachable', async () => {
    const s = await server();
    const dir = tempConfigDir();
    const tool = toolFor(s, dir);

    const approver = setInterval(() => s.approve('CODE-1'), 5);
    await invoke(tool, ['login', '--json']);
    clearInterval(approver);

    await s.close();

    const out = await invoke(tool, ['logout', '--json']);
    expect(out.exitCode).toBe(EXIT.ok);
    const data = (out.json() as { data: { revoked: boolean; localTokenCleared: boolean } }).data;
    expect(data.revoked).toBe(false);
    expect(data.localTokenCleared).toBe(true);

    const who = await invoke(tool, ['whoami', '--json']);
    expect(who.exitCode).toBe(EXIT.auth);
  });

  it('doctor reports connectivity, auth and config state', async () => {
    const s = await server();
    const dir = tempConfigDir();
    const tool = toolFor(s, dir);

    const before = await invoke(tool, ['doctor', '--json']);
    const r1 = (before.json() as { data: Record<string, any> }).data;
    expect(r1.api.reachable).toBe(true);
    expect(r1.auth.ok).toBe(false);
    expect(r1.auth.error).toBe('No token stored.');
    expect(r1.config.source).toBe('none');
    expect(r1.config.envVar).toBe('DEMO_TOOL_TOKEN');
    // The skills generator does not exist yet; doctor must not claim otherwise.
    expect(r1.skills).toEqual({ checked: false, installed: null });

    const approver = setInterval(() => s.approve('CODE-1'), 5);
    await invoke(tool, ['login', '--json']);
    clearInterval(approver);

    const after = await invoke(tool, ['doctor', '--json']);
    const r2 = (after.json() as { data: Record<string, any> }).data;
    expect(r2.api.reachable).toBe(true);
    expect(r2.auth.ok).toBe(true);
    expect(r2.auth.subject).toBe('user_1');
    expect(r2.config.source).toBe('config');
    expect(r2.config.worldReadable).toBe(false);
  });

  it('doctor separates unreachable from unauthenticated', async () => {
    const s = await server();
    const tool = toolFor(s, tempConfigDir());
    await s.close();

    const r = await invoke(tool, ['doctor', '--json']);
    const data = (r.json() as { data: Record<string, any> }).data;
    expect(data.api.reachable).toBe(false);
    expect(data.api.error).toBeTruthy();
  });

  it('a tool may override a built-in', async () => {
    const s = await server();
    const tool = defineTool({
      name: 'demo-tool',
      version: '1.0.0',
      api: { baseUrl: s.url },
      configDir: tempConfigDir(),
      commands: {
        doctor: command({
          description: 'Custom doctor.',
          run: () => ({ custom: true }),
        }),
      },
    });

    const r = await invoke(tool, ['doctor', '--json']);
    expect(r.json()).toEqual({ status: 'ok', data: { custom: true } });
  });
});

describe('automatic headers', () => {
  it('sends client, command and agent identification', async () => {
    const s = await server();
    const tool = toolFor(s, tempConfigDir());

    await invoke(tool, ['ping', '--json']);

    const call = s.requests.find((r) => r.path === '/cli/whoami');
    expect(call?.headers['x-invokable-client']).toBe('demo-tool/9.9.9');
    expect(call?.headers['x-invokable-command']).toBe('ping');
    expect(call?.headers['x-invokable-agent']).toBeTruthy();
  });
});
