import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore, resolveToken, tokenEnvVar, expandHome } from '../src/config.js';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'invokable-cfg-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('ConfigStore', () => {
  it('round-trips config and creates the file 0600 in a 0700 directory', () => {
    const store = new ConfigStore(join(tempDir(), 'nested'));
    store.write({ token: 'secret_abc', subject: 'user_1' });

    expect(store.read()).toMatchObject({ token: 'secret_abc', subject: 'user_1' });
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect(statSync(store.dir).mode & 0o777).toBe(0o700);
  });

  it('merges on write and deletes keys set to undefined', () => {
    const store = new ConfigStore(tempDir());
    store.write({ token: 'a', subject: 'user_1', orgId: 'org_1' });
    store.write({ token: undefined });

    const cfg = store.read();
    expect(cfg.token).toBeUndefined();
    expect(cfg.subject).toBe('user_1');
    expect(JSON.parse(readFileSync(store.path, 'utf8'))).not.toHaveProperty('token');
  });

  it('leaves no temp file behind', () => {
    const dir = tempDir();
    const store = new ConfigStore(dir);
    store.write({ token: 'a' });
    const leftovers = readFileSync(store.path, 'utf8');
    expect(leftovers).toContain('token');
    expect(() => statSync(`${store.path}.${process.pid}.tmp`)).toThrow();
  });

  it('survives a corrupt config rather than bricking the CLI', () => {
    const store = new ConfigStore(tempDir());
    store.write({ token: 'a' });
    writeFileSync(store.path, '{ not json');

    expect(store.read()).toEqual({});
    store.write({ token: 'b' });
    expect(store.read().token).toBe('b');
  });

  it('detects a world-readable config', () => {
    const store = new ConfigStore(tempDir());
    store.write({ token: 'a' });
    expect(store.isWorldReadable()).toBe(false);

    chmodSync(store.path, 0o644);
    expect(store.isWorldReadable()).toBe(true);
  });

  it('reports no config as absent rather than throwing', () => {
    const store = new ConfigStore(join(tempDir(), 'does-not-exist'));
    expect(store.exists()).toBe(false);
    expect(store.read()).toEqual({});
    expect(store.isWorldReadable()).toBe(false);
  });
});

describe('token precedence', () => {
  const toolName = 'demo-tool';

  it('derives the environment variable from the tool name', () => {
    expect(tokenEnvVar('demo-tool')).toBe('DEMO_TOOL_TOKEN');
  });

  it('prefers --token over the environment and config', () => {
    const r = resolveToken({
      toolName,
      flagToken: 'from-flag',
      env: { DEMO_TOOL_TOKEN: 'from-env' },
      config: { token: 'from-config' },
    });
    expect(r).toEqual({ token: 'from-flag', source: 'flag' });
  });

  it('prefers the environment over config', () => {
    const r = resolveToken({
      toolName,
      env: { DEMO_TOOL_TOKEN: 'from-env' },
      config: { token: 'from-config' },
    });
    expect(r).toEqual({ token: 'from-env', source: 'env' });
  });

  it('falls back to config, then to none', () => {
    expect(resolveToken({ toolName, env: {}, config: { token: 'c' } }).source).toBe('config');
    expect(resolveToken({ toolName, env: {}, config: {} })).toEqual({
      token: undefined,
      source: 'none',
    });
  });
});

describe('expandHome', () => {
  it('expands a leading ~', () => {
    expect(expandHome('~/x')).toMatch(/\/x$/);
    expect(expandHome('~/x').startsWith('~')).toBe(false);
  });
});
