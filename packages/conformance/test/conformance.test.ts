import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runChecks, type CheckResult } from '../src/checks.js';
import { conformanceMain } from '../src/cli.js';
import { summarise, renderReport } from '../src/report.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

async function check(name: string, extraSafeCommands: string[] = []): Promise<CheckResult[]> {
  return runChecks({
    command: process.execPath,
    baseArgs: [fixture(name)],
    timeoutMs: 15_000,
    extraSafeCommands,
  });
}

function statusOf(results: CheckResult[], id: string): string {
  const found = results.find((r) => r.id === id);
  if (!found) throw new Error(`no check "${id}"; have: ${results.map((r) => r.id).join(', ')}`);
  return found.status;
}

describe('a compliant tool passes', () => {
  it('reports no failures', async () => {
    const results = await check('compliant.mjs');
    const failures = results.filter((r) => r.status === 'fail');
    expect(failures.map((f) => `${f.id}: ${f.detail}`)).toEqual([]);
  });
});

describe('violations are actually caught', () => {
  // A conformance runner that only ever passes is worse than none: it certifies
  // tools that will break in front of a user. Each case below is a real
  // violation that must be detected.

  it('catches a log line on stdout', async () => {
    const results = await check('impure-stdout.mjs');
    expect(statusOf(results, 'json-purity')).toBe('fail');
    const detail = results.find((r) => r.id === 'json-purity')!.detail!;
    expect(detail).toContain('lines');
  });

  it('catches an exit code outside the contract', async () => {
    const results = await check('bad-exit-code.mjs');
    expect(statusOf(results, 'exit-codes')).toBe('fail');
    expect(results.find((r) => r.id === 'exit-codes')!.detail).toContain('200');
  });

  it('catches an unknown command that reports success', async () => {
    const results = await check('silent-success.mjs');
    expect(statusOf(results, 'unknown-command')).toBe('fail');
    expect(statusOf(results, 'bare')).toBe('fail');
  });

  it('catches a credential printed to stdout', async () => {
    const results = await check('leaks-token.mjs');
    expect(statusOf(results, 'no-secrets')).toBe('fail');
    const detail = results.find((r) => r.id === 'no-secrets')!.detail!;
    expect(detail).toContain('token-shaped');
    // A report that reprinted the secret would copy it into CI logs and pasted
    // transcripts — the exact spread this check exists to prevent. Only the
    // prefix and the length may appear.
    expect(detail).toContain('mtl_');
    expect(detail).not.toContain('9fKq2ZxA');
  });

  it('catches a doctor that reports nothing actionable', async () => {
    const results = await check('useless-doctor.mjs');
    expect(statusOf(results, 'doctor')).toBe('fail');
  });

  it('catches --help --json that is not a manifest', async () => {
    const results = await check('no-manifest.mjs');
    expect(statusOf(results, 'help')).toBe('fail');
  });
});

describe('safety', () => {
  it('never runs a command from the manifest on its own', async () => {
    // The manifest of `compliant.mjs` lists `doctor`; nothing else may be run.
    // A runner that executed every listed command could deploy something.
    const results = await check('compliant.mjs');
    const invoked = results.flatMap((r) => r.invocations);
    const commandsRun = new Set(
      invoked.map((line) =>
        line
          .split(/\s+/)
          .slice(2) // drop the interpreter and the script path
          .find((t) => !t.startsWith('-')),
      ),
    );
    commandsRun.delete(undefined);
    expect([...commandsRun].sort()).toEqual(['definitely-not-a-real-command-xyz', 'doctor']);
  });

  it('runs an explicitly nominated safe command', async () => {
    const results = await check('compliant.mjs', ['doctor']);
    expect(statusOf(results, 'safe:doctor')).toBe('pass');
  });
});

describe('the CLI', () => {
  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) };
  }

  it('exits 0 and prints a report for a compliant tool', async () => {
    const c = capture();
    const code = await conformanceMain({
      argv: [process.execPath, fixture('compliant.mjs')],
      stdout: c.stdout,
      stderr: c.stderr,
    });
    expect(code).toBe(0);
    expect(c.err.join('')).toContain('passed');
  });

  it('exits 1 for a non-compliant tool', async () => {
    const c = capture();
    const code = await conformanceMain({
      argv: [process.execPath, fixture('impure-stdout.mjs')],
      stdout: c.stdout,
      stderr: c.stderr,
    });
    expect(code).toBe(1);
  });

  it('emits a machine-readable report with --json, keeping the human text off stdout', async () => {
    const c = capture();
    await conformanceMain({
      argv: [process.execPath, fixture('compliant.mjs'), '--json'],
      stdout: c.stdout,
      stderr: c.stderr,
    });

    const parsed = JSON.parse(c.out.join('')) as { ok: boolean; checks: unknown[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.checks.length).toBeGreaterThan(5);
    expect(c.err.join('')).toBe('');
  });

  it('exits 2 with usage when no target is given', async () => {
    const c = capture();
    expect(await conformanceMain({ argv: [], stdout: c.stdout, stderr: c.stderr })).toBe(2);
    expect(c.err.join('')).toContain('Usage:');
  });

  it('rejects a bad --timeout instead of silently using the default', async () => {
    const c = capture();
    const code = await conformanceMain({
      argv: [process.execPath, fixture('compliant.mjs'), '--timeout', 'soon'],
      stdout: c.stdout,
      stderr: c.stderr,
    });
    expect(code).toBe(2);
  });
});

describe('the report', () => {
  it('explains why a failing check matters', async () => {
    const results = await check('impure-stdout.mjs');
    const text = renderReport(summarise('tool', results));
    expect(text).toContain('Why:');
    expect(text).toContain('Reproduce:');
  });
});
