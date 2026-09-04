import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const fixture = fileURLToPath(new URL('./fixtures/noisy-tool.mjs', import.meta.url));

async function run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [fixture, ...args]);
    return { stdout, stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout: string; stderr: string; code: number };
    return { stdout: err.stdout, stderr: err.stderr, code: err.code };
  }
}

describe('stdout purity, verified in a real process', () => {
  it('diverts stray stdout writes to stderr and leaves one JSON document', async () => {
    const { stdout, stderr, code } = await run(['run', '--json']);

    expect(stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(stdout)).toEqual({ status: 'ok', data: { ok: true } });
    expect(code).toBe(0);

    expect(stderr).toContain('STRAY_CONSOLE_LOG');
    expect(stderr).toContain('STRAY_RAW_WRITE');
    expect(stderr).toContain('INTENTIONAL_STDERR');
  });

  it('propagates the exit code to the process', async () => {
    const { code } = await run(['does-not-exist', '--json']);
    expect(code).toBe(2);
  });
});
