/** Quotes an argument only when a shell would otherwise mangle it. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export interface RebuildOptions {
  /** Flags to remove, along with their value when they take one. */
  drop?: readonly string[];
  /** Flags to append. */
  add?: readonly string[];
}

/**
 * Reconstructs the invocation that produced the current state, with edits.
 *
 * Every command handed back to an agent — `next.approve`, a `remediation` —
 * has to actually run. Building one from the tool and command name alone drops
 * the original options, so it fails with a usage error the moment any option is
 * required, which is worse than giving no suggestion at all.
 */
export function rebuildCommand(
  toolName: string,
  argv: readonly string[],
  options: RebuildOptions = {},
): string {
  const drop = new Set(options.drop ?? []);
  const args: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (drop.has(token)) {
      i++; // also skip its value
      continue;
    }
    if ([...drop].some((flag) => token.startsWith(`${flag}=`))) continue;
    args.push(token);
  }

  // Only argv is quoted. `add` tokens come from the caller and are already
  // shell-ready — quoting them would turn a `<number>` placeholder into the
  // literal string `'<number>'`.
  return [toolName, ...args.map(shellQuote), ...(options.add ?? [])].join(' ');
}
