/**
 * Reserved exit codes. These are part of the public contract with the calling
 * agent and MUST NOT change meaning between versions — an agent keys its next
 * action off the number alone.
 *
 * Spec 5.2. Tool authors may define their own codes in the range 30-99.
 */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  auth: 3,
  insufficient_spend: 4,
  not_found: 5,
  conflict: 6,
  rate_limited: 7,
  checkpoint_pending: 10,
  timeout: 11,
  checkpoint_stale: 12,
  network: 15,
  declined: 20,
} as const;

export type ExitName = keyof typeof EXIT;
export type ExitCode = (typeof EXIT)[ExitName];

/** Reverse lookup, for diagnostics and generated docs. */
export const EXIT_NAME: Readonly<Record<number, ExitName>> = Object.freeze(
  Object.fromEntries(Object.entries(EXIT).map(([name, code]) => [code, name])) as Record<
    number,
    ExitName
  >,
);

/** One-line explanation per code, consumed by the SKILL.md generator. */
export const EXIT_DESCRIPTION: Readonly<Record<ExitName, string>> = Object.freeze({
  ok: 'Command succeeded.',
  error: 'Unexpected failure. Read `message`; do not blindly retry.',
  usage: 'Bad invocation (unknown flag, missing required option). Fix the command.',
  auth: 'Not authenticated or token rejected. Run the tool’s `login` command.',
  insufficient_spend: 'Not enough credits/balance to perform the action. Do not retry.',
  not_found: 'The referenced resource does not exist.',
  conflict: 'The resource changed or already exists. Re-read state before retrying.',
  rate_limited: 'Too many requests. Never retry automatically — surface to the user.',
  checkpoint_pending: 'Approval required. This is NOT a failure: show the panel to the user and run `next.approve` only if they agree.',
  timeout: 'The operation timed out. Retrying once is usually safe.',
  checkpoint_stale: 'The approval token no longer matches current state. Re-run without `--approve`.',
  network: 'The API was unreachable. Retrying once is usually safe.',
  declined: 'The user declined the action. Stop; do not retry.',
});

/** Lowest and highest exit code a tool author may claim for custom conditions. */
export const CUSTOM_EXIT_RANGE = { min: 30, max: 99 } as const;

export function isReservedExitCode(code: number): boolean {
  return code in EXIT_NAME;
}

export function assertCustomExitCode(code: number): void {
  const { min, max } = CUSTOM_EXIT_RANGE;
  if (!Number.isInteger(code) || code < min || code > max) {
    throw new RangeError(
      `Custom exit codes must be integers in ${min}-${max}; received ${code}. ` +
        `Codes outside that range are reserved by @invokable/core.`,
    );
  }
}
