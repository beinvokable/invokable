import { runChecks } from './checks.js';
import { renderReport, summarise, type Report } from './report.js';

export interface MainOptions {
  argv: readonly string[];
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

const USAGE = `Usage: invokable-test <command> [args...] [options]

Checks that a CLI honours the invokable agent contract.

  invokable-test ./bin/mytool.mjs
  invokable-test node ./bin/mytool.mjs
  invokable-test npx mytool

Options:
      --json                 Emit the report as JSON on stdout.
      --safe-command <cmd>   Additionally run this command (repeatable).
                             Only pass commands that change nothing.
      --timeout <ms>         Per-invocation timeout. Default 30000.
  -h, --help                 Show this help.

Only commands that cannot change anything are run: --help, --version, doctor,
and deliberately invalid invocations. Commands from the manifest are never
executed on their own, because one of them may spend the user's money.
`;

/** Returns the process exit code. */
export async function conformanceMain(options: MainOptions): Promise<number> {
  const stdout = options.stdout ?? ((s) => process.stdout.write(s));
  const stderr = options.stderr ?? ((s) => process.stderr.write(s));

  const argv = [...options.argv];
  let json = false;
  let timeoutMs = 30_000;
  const safeCommands: string[] = [];
  const target: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--json') {
      json = true;
    } else if (token === '--help' || token === '-h') {
      stderr(USAGE);
      return 0;
    } else if (token === '--safe-command') {
      const value = argv[++i];
      if (value === undefined) {
        stderr('error: --safe-command needs a value\n');
        return 2;
      }
      safeCommands.push(value);
    } else if (token === '--timeout') {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0) {
        stderr('error: --timeout must be a positive number of milliseconds\n');
        return 2;
      }
      timeoutMs = value;
    } else {
      target.push(token);
    }
  }

  const command = target[0];
  if (command === undefined) {
    stderr(USAGE);
    return 2;
  }

  const checks = await runChecks({
    command,
    baseArgs: target.slice(1),
    timeoutMs,
    extraSafeCommands: safeCommands,
  });

  const report: Report = summarise(target.join(' '), checks);

  if (json) {
    stdout(JSON.stringify(report) + '\n');
  } else {
    stderr(renderReport(report));
  }

  return report.ok ? 0 : 1;
}
