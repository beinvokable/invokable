import { EXIT, EXIT_NAME, CUSTOM_EXIT_RANGE } from '@invokable/core';
import { invoke, type ExecOptions, type Invocation } from './exec.js';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  /** What went wrong, or what was observed. */
  detail?: string;
  /** Why an agent depends on this. Shown for failures. */
  rationale: string;
  invocations: string[];
}

export interface CheckContext extends ExecOptions {
  /** Commands the runner may execute beyond the always-safe set. */
  extraSafeCommands: readonly string[];
}

const VALID_EXIT_CODES = new Set<number>(Object.values(EXIT));

function isValidExitCode(code: number | null): boolean {
  if (code === null) return false;
  if (VALID_EXIT_CODES.has(code)) return true;
  return code >= CUSTOM_EXIT_RANGE.min && code <= CUSTOM_EXIT_RANGE.max;
}

interface ParsedStdout {
  ok: boolean;
  reason?: string;
  value?: unknown;
}

/** Exactly one JSON document, nothing else. */
function parseSingleDocument(stdout: string): ParsedStdout {
  const trimmed = stdout.trim();
  if (trimmed === '') return { ok: false, reason: 'stdout was empty' };

  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    const lines = trimmed.split('\n').filter((l) => l.trim() !== '');
    if (lines.length > 1) {
      return {
        ok: false,
        reason:
          `stdout had ${lines.length} lines and is not one JSON document. ` +
          `First line: ${JSON.stringify(lines[0]!.slice(0, 120))}`,
      };
    }
    return { ok: false, reason: `stdout is not valid JSON: ${JSON.stringify(trimmed.slice(0, 200))}` };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Strings that look like credentials, which must never reach stdout.
 *
 * The finding describes the shape and never quotes the material. A report that
 * reprinted the secret would copy it into CI logs and pasted transcripts — the
 * exact spread this check exists to prevent.
 */
function looksLikeSecret(text: string): string | null {
  const patterns: Array<[RegExp, (m: string) => string]> = [
    [
      /\b([a-z]{2,10})_[A-Za-z0-9]{24,}\b/,
      (m) => `a token-shaped string: prefix "${m.split('_')[0]}_", ${m.length} characters`,
    ],
    [/\bBearer\s+[A-Za-z0-9._-]{16,}/i, (m) => `a Bearer credential, ${m.length} characters`],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, () => 'a PEM private key block'],
  ];
  for (const [re, describe] of patterns) {
    const m = re.exec(text);
    if (m) return describe(m[0]);
  }
  return null;
}

function result(
  id: string,
  title: string,
  rationale: string,
  status: CheckStatus,
  invocations: Invocation[],
  detail?: string,
): CheckResult {
  return {
    id,
    title,
    status,
    rationale,
    invocations: invocations.map((i) => i.commandLine),
    ...(detail !== undefined ? { detail } : {}),
  };
}

/**
 * Every check runs the tool for real. Only commands that cannot change anything
 * are executed: `--help`, `--version`, `doctor`, and deliberately invalid
 * invocations. A conformance runner that executed arbitrary commands from the
 * manifest could deploy something or spend the user's money — the tools this
 * suite exists to validate are exactly the ones where that matters.
 */
export async function runChecks(ctx: CheckContext): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const runs: Invocation[] = [];
  const run = async (args: string[]): Promise<Invocation> => {
    const inv = await invoke(ctx, args);
    runs.push(inv);
    return inv;
  };

  // ---- 1. --version --------------------------------------------------------
  const version = await run(['--version', '--json']);
  {
    const parsed = parseSingleDocument(version.stdout);
    if (version.timedOut) {
      results.push(
        result('version', '`--version --json` responds', RATIONALE.responds, 'fail', [version],
          'The process timed out.'),
      );
    } else if (!parsed.ok) {
      results.push(
        result('version', '`--version --json` emits one JSON document', RATIONALE.singleDoc, 'fail',
          [version], parsed.reason),
      );
    } else if (!isRecord(parsed.value) || parsed.value['status'] !== 'ok') {
      results.push(
        result('version', '`--version --json` returns status ok', RATIONALE.envelope, 'fail',
          [version], `status was ${JSON.stringify((parsed.value as Record<string, unknown>)?.['status'])}`),
      );
    } else {
      results.push(result('version', '`--version --json` returns a valid ok envelope', RATIONALE.envelope, 'pass', [version]));
    }
  }

  // ---- 2. --help --json is a machine-readable manifest ---------------------
  const help = await run(['--help', '--json']);
  {
    const parsed = parseSingleDocument(help.stdout);
    const data = isRecord(parsed.value) ? parsed.value['data'] : undefined;
    const commands = isRecord(data) ? data['commands'] : undefined;

    if (!parsed.ok) {
      results.push(result('help', '`--help --json` emits one JSON document', RATIONALE.singleDoc, 'fail', [help], parsed.reason));
    } else if (!Array.isArray(commands) || commands.length === 0) {
      results.push(
        result('help', '`--help --json` lists commands', RATIONALE.manifest, 'fail', [help],
          'data.commands was missing or empty. An agent cannot discover the surface.'),
      );
    } else {
      results.push(
        result('help', '`--help --json` returns a command manifest', RATIONALE.manifest, 'pass', [help],
          `${commands.length} commands`),
      );
    }
  }

  // ---- 3. An unknown command is a usage error, not a crash ----------------
  const unknown = await run(['definitely-not-a-real-command-xyz', '--json']);
  {
    const parsed = parseSingleDocument(unknown.stdout);
    const env = isRecord(parsed.value) ? parsed.value : undefined;
    const problems: string[] = [];

    if (unknown.exitCode !== EXIT.usage) {
      problems.push(`exit was ${unknown.exitCode}, expected ${EXIT.usage} (usage)`);
    }
    if (!parsed.ok) problems.push(parsed.reason ?? 'stdout was not one JSON document');
    else {
      if (env?.['status'] !== 'error') problems.push(`status was ${JSON.stringify(env?.['status'])}, expected "error"`);
      if (typeof env?.['code'] !== 'string') problems.push('error envelope has no string `code`');
      if (typeof env?.['message'] !== 'string') problems.push('error envelope has no string `message`');
      if (typeof env?.['retryable'] !== 'boolean') problems.push('error envelope has no boolean `retryable`');
    }

    results.push(
      problems.length
        ? result('unknown-command', 'An unknown command exits 2 with an error envelope', RATIONALE.usage, 'fail', [unknown], problems.join('; '))
        : result('unknown-command', 'An unknown command exits 2 with an error envelope', RATIONALE.usage, 'pass', [unknown]),
    );
  }

  // ---- 4. A bare invocation does not look like success ---------------------
  const bare = await run(['--json']);
  {
    results.push(
      bare.exitCode === EXIT.ok
        ? result('bare', 'A bare invocation does not exit 0', RATIONALE.bare, 'fail', [bare],
            'Exit 0 with no command tells an agent the work succeeded when nothing ran.')
        : result('bare', 'A bare invocation does not exit 0', RATIONALE.bare, 'pass', [bare], `exit ${bare.exitCode}`),
    );
  }

  // ---- 5. doctor -----------------------------------------------------------
  const doctor = await run(['doctor', '--json']);
  {
    const parsed = parseSingleDocument(doctor.stdout);
    const data = isRecord(parsed.value) ? parsed.value['data'] : undefined;

    if (doctor.timedOut) {
      results.push(result('doctor', '`doctor --json` responds', RATIONALE.doctor, 'fail', [doctor], 'The process timed out.'));
    } else if (!parsed.ok) {
      results.push(result('doctor', '`doctor --json` emits one JSON document', RATIONALE.singleDoc, 'fail', [doctor], parsed.reason));
    } else if (!isRecord(data) || !isRecord(data['auth']) || !isRecord(data['config'])) {
      results.push(
        result('doctor', '`doctor --json` reports auth and config', RATIONALE.doctor, 'fail', [doctor],
          'Expected data.auth and data.config. An agent uses these to tell "not logged in" from "service down".'),
      );
    } else {
      results.push(result('doctor', '`doctor --json` reports auth and config state', RATIONALE.doctor, 'pass', [doctor]));
    }
  }

  // ---- 6. Optional user-nominated safe commands ----------------------------
  for (const command of ctx.extraSafeCommands) {
    const args = command.split(/\s+/).filter(Boolean);
    const inv = await run([...args, '--json']);
    const parsed = parseSingleDocument(inv.stdout);
    results.push(
      parsed.ok
        ? result(`safe:${command}`, `\`${command} --json\` emits one JSON document`, RATIONALE.singleDoc, 'pass', [inv])
        : result(`safe:${command}`, `\`${command} --json\` emits one JSON document`, RATIONALE.singleDoc, 'fail', [inv], parsed.reason),
    );
  }

  // ---- 7. Cross-cutting: exit codes ---------------------------------------
  {
    const bad = runs.filter((r) => !isValidExitCode(r.exitCode));
    results.push(
      bad.length
        ? result('exit-codes', 'Every exit code is reserved or in 30-99', RATIONALE.exitCodes, 'fail', bad,
            bad.map((r) => `\`${r.commandLine}\` exited ${r.exitCode ?? 'by signal/timeout'}`).join('; '))
        : result('exit-codes', 'Every exit code is reserved or in 30-99', RATIONALE.exitCodes, 'pass', [],
            [...new Set(runs.map((r) => r.exitCode))]
              .sort((a, b) => (a ?? 0) - (b ?? 0))
              .map((c) => `${c}${c !== null && EXIT_NAME[c] ? ` (${EXIT_NAME[c]})` : ''}`)
              .join(', ')),
    );
  }

  // ---- 8. Cross-cutting: --json stdout purity ------------------------------
  {
    const impure = runs.filter((r) => {
      if (!r.argv.includes('--json') || r.timedOut) return false;
      return !parseSingleDocument(r.stdout).ok;
    });
    results.push(
      impure.length
        ? result('json-purity', '`--json` puts exactly one JSON document on stdout', RATIONALE.singleDoc, 'fail', impure,
            impure.map((r) => `\`${r.commandLine}\`: ${parseSingleDocument(r.stdout).reason}`).join('; '))
        : result('json-purity', '`--json` puts exactly one JSON document on stdout', RATIONALE.singleDoc, 'pass', []),
    );
  }

  // ---- 9. Cross-cutting: no credentials on stdout -------------------------
  {
    const leaks = runs
      .map((r) => ({ run: r, found: looksLikeSecret(r.stdout) }))
      .filter((x) => x.found !== null);
    results.push(
      leaks.length
        ? result('no-secrets', 'No credential-shaped strings on stdout', RATIONALE.secrets, 'fail',
            leaks.map((l) => l.run),
            leaks.map((l) => `\`${l.run.commandLine}\` printed ${l.found}`).join('; '))
        : result('no-secrets', 'No credential-shaped strings on stdout', RATIONALE.secrets, 'pass', []),
    );
  }

  // ---- 10. Cross-cutting: errors carry remediation -------------------------
  {
    const errors = runs
      .filter((r) => r.argv.includes('--json'))
      .map((r) => parseSingleDocument(r.stdout).value)
      .filter((v): v is Record<string, unknown> => isRecord(v) && v['status'] === 'error');

    const missing = errors.filter((e) => typeof e['remediation'] !== 'string');
    results.push(
      errors.length === 0
        ? result('remediation', 'Errors carry a `remediation`', RATIONALE.remediation, 'skip', [], 'No error envelopes were produced.')
        : missing.length
          ? result('remediation', 'Errors carry a `remediation`', RATIONALE.remediation, 'warn', [],
              `${missing.length} of ${errors.length} error envelopes had no remediation.`)
          : result('remediation', 'Errors carry a `remediation`', RATIONALE.remediation, 'pass', []),
    );
  }

  return results;
}

const RATIONALE = {
  responds: 'An agent that gets no response cannot tell a hang from a failure.',
  singleDoc:
    'The agent parses stdout as one JSON document. A stray log line makes the parse fail, and the agent reports a broken tool rather than the real result.',
  envelope: 'The agent reads `status` before anything else.',
  manifest:
    '`--help --json` is how an agent discovers commands and options instead of guessing them.',
  usage:
    'A mistyped command must be distinguishable from a real failure, or the agent retries something that can never work.',
  bare: 'Exit 0 with no command run tells the agent the task is done.',
  doctor:
    '`doctor` is how an agent tells "not logged in" from "service unreachable" — the two failures that look identical from outside.',
  exitCodes:
    'The agent decides what to do next from the exit code alone. An unreserved code means it has no rule to apply.',
  secrets: 'stdout is captured, logged and often echoed back into a transcript.',
  remediation: 'Without it the agent has to invent the next command.',
} as const;
