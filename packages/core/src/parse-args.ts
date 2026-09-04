import { usageError } from './errors.js';
import type { OptionsSpec, ResolvedOptions } from './schema.js';

/** Global flags the runtime owns; a command may not redefine them. */
export const GLOBAL_FLAGS = [
  'json',
  'yes',
  'help',
  'version',
  'token',
  'max-spend',
  'approve',
  'no-browser',
] as const;

export interface GlobalOptions {
  json: boolean;
  yes: boolean;
  help: boolean;
  version: boolean;
  token: string | undefined;
  maxSpend: number | undefined;
  approvals: string[];
  noBrowser: boolean;
}

export interface ParsedArgv {
  command: string | undefined;
  globals: GlobalOptions;
  /** Raw option tokens for the command, still unvalidated. */
  raw: Map<string, string | boolean>;
  positionals: string[];
}

function toFlagName(token: string): string {
  return token.replace(/^--?/, '');
}

/**
 * Splits argv into the command name, global flags, command flags and
 * positionals. Deliberately small: `--flag`, `--flag value`, `--flag=value`,
 * `--no-flag`, short aliases, and `--` to stop parsing.
 */
export function parseArgv(argv: readonly string[]): ParsedArgv {
  const globals: GlobalOptions = {
    json: false,
    yes: false,
    help: false,
    version: false,
    token: undefined,
    maxSpend: undefined,
    approvals: [],
    noBrowser: false,
  };
  const raw = new Map<string, string | boolean>();
  const positionals: string[] = [];
  let command: string | undefined;
  let stopped = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (stopped) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      stopped = true;
      continue;
    }

    if (token.startsWith('-') && token !== '-') {
      let name = toFlagName(token);
      let inlineValue: string | undefined;

      const eq = name.indexOf('=');
      if (eq !== -1) {
        inlineValue = name.slice(eq + 1);
        name = name.slice(0, eq);
      }

      // `--no-foo` sets boolean foo to false, except for the real `--no-browser`.
      let negated = false;
      if (name.startsWith('no-') && name !== 'no-browser') {
        negated = true;
        name = name.slice(3);
      }

      const takeValue = (): string => {
        if (inlineValue !== undefined) return inlineValue;
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith('-') && next !== '-')) {
          throw usageError(`Option --${name} requires a value.`);
        }
        i++;
        return next;
      };

      switch (name) {
        case 'json':
          globals.json = !negated;
          continue;
        case 'yes':
          globals.yes = !negated;
          continue;
        case 'help':
        case 'h':
          globals.help = true;
          continue;
        case 'version':
        case 'V':
          globals.version = true;
          continue;
        case 'no-browser':
          globals.noBrowser = true;
          continue;
        case 'token':
          globals.token = takeValue();
          continue;
        case 'max-spend': {
          const v = Number(takeValue());
          if (!Number.isFinite(v) || v < 0) {
            throw usageError('--max-spend must be a non-negative number.');
          }
          globals.maxSpend = v;
          continue;
        }
        case 'approve':
          globals.approvals.push(takeValue());
          continue;
        default:
          break;
      }

      if (negated) {
        raw.set(name, false);
      } else if (inlineValue !== undefined) {
        raw.set(name, inlineValue);
      } else {
        // Defer the value/boolean decision to coercion, which knows the spec.
        const next = argv[i + 1];
        if (next !== undefined && !(next.startsWith('-') && next !== '-')) {
          raw.set(name, next);
          i++;
        } else {
          raw.set(name, true);
        }
      }
      continue;
    }

    if (command === undefined) {
      command = token;
    } else {
      positionals.push(token);
    }
  }

  return { command, globals, raw, positionals };
}

/**
 * Validates raw tokens against the command's declared options and coerces them
 * to their declared types. Unknown options are a usage error (exit 2) rather
 * than being silently ignored — a typo'd flag must not look like success.
 */
export function resolveOptions(
  spec: OptionsSpec | undefined,
  raw: Map<string, string | boolean>,
  commandName: string,
): ResolvedOptions {
  const options = spec ?? {};
  const byShort = new Map<string, string>();
  for (const [name, o] of Object.entries(options)) {
    if (o.short) byShort.set(o.short, name);
  }

  const out: ResolvedOptions = {};
  const seen = new Set<string>();

  for (const [key, value] of raw) {
    const name = options[key] ? key : byShort.get(key);
    if (name === undefined) {
      const known = Object.keys(options);
      throw usageError(
        `Unknown option --${key} for command "${commandName}".` +
          (known.length ? ` Known options: ${known.map((k) => '--' + k).join(', ')}.` : ''),
        known.length ? `${commandName} --help` : undefined,
      );
    }
    const optSpec = options[name]!;
    out[name] = coerce(name, optSpec.type, value, optSpec.choices);
    seen.add(name);
  }

  for (const [name, o] of Object.entries(options)) {
    if (seen.has(name)) continue;
    if (o.default !== undefined) {
      out[name] = o.default;
    } else if (o.required) {
      throw usageError(
        `Missing required option --${name} for command "${commandName}".`,
        `${commandName} --help`,
      );
    } else if (o.type === 'boolean') {
      out[name] = false;
    }
  }

  return out;
}

function coerce(
  name: string,
  type: OptionsSpec[string]['type'],
  value: string | boolean,
  choices: readonly string[] | undefined,
): string | number | boolean {
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw usageError(`Option --${name} is a flag and does not take the value "${value}".`);
  }

  if (typeof value === 'boolean') {
    throw usageError(`Option --${name} requires a value.`);
  }

  if (type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw usageError(`Option --${name} must be a number; received "${value}".`);
    }
    return n;
  }

  if (choices && !choices.includes(value)) {
    throw usageError(
      `Option --${name} must be one of: ${choices.join(', ')}; received "${value}".`,
    );
  }
  return value;
}
