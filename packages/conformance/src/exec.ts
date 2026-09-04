import { execFile } from 'node:child_process';

export interface Invocation {
  /** Args passed after the base command. */
  argv: readonly string[];
  /** The full command line, for reproducing the run. */
  commandLine: string;
  stdout: string;
  stderr: string;
  /** Null when the process was killed by a signal or timed out. */
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export interface ExecOptions {
  command: string;
  baseArgs: readonly string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/**
 * Runs the tool under test as a real subprocess.
 *
 * Everything is measured on actual file descriptors: stdout purity is only
 * meaningful at the process boundary, which is where the agent reads it.
 */
export function invoke(opts: ExecOptions, args: readonly string[]): Promise<Invocation> {
  const argv = [...opts.baseArgs, ...args];
  const started = Date.now();

  return new Promise((resolve) => {
    execFile(
      opts.command,
      argv,
      {
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: 16 * 1024 * 1024,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        env: {
          ...process.env,
          ...opts.env,
          // Keep the tool from picking up ambient credentials or an interactive
          // path: a conformance run must be reproducible on any machine.
          NO_COLOR: '1',
          CI: '1',
        },
      },
      (error, stdout, stderr) => {
        const err = error as (Error & { code?: number | string; killed?: boolean }) | null;
        const timedOut = Boolean(err?.killed) || err?.code === 'ETIMEDOUT';
        resolve({
          argv,
          commandLine: [opts.command, ...argv].join(' '),
          stdout: String(stdout),
          stderr: String(stderr),
          exitCode: timedOut ? null : typeof err?.code === 'number' ? err.code : 0,
          timedOut,
          durationMs: Date.now() - started,
        });
      },
    );
  });
}
