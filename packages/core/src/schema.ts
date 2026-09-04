/**
 * The command schema. This is the single source of truth that the runtime, the
 * SKILL.md generator (@invokable/skills) and the future MCP adapter all read —
 * a tool author describes their surface once (spec 5.1, 5.6, 7/P2).
 */

export type OptionType = 'string' | 'number' | 'boolean';

export interface OptionSpec {
  type: OptionType;
  description?: string;
  required?: boolean;
  /** Allowed values; validated before the command runs. `string` options only. */
  choices?: readonly string[];
  default?: string | number | boolean;
  /** Single-character alias, e.g. `e` for `--env`. */
  short?: string;
}

export type OptionsSpec = Record<string, OptionSpec>;

/** Resolved option values handed to `run()`. */
export type ResolvedOptions = Record<string, string | number | boolean | undefined>;

export interface CommandContext {
  /** The tool definition, for building remediation strings and reading config. */
  tool: ToolSpec;
  /** On-disk config + token store, rooted at the tool's configDir. */
  config: import('./config.js').ConfigStore;
  /** How the active token was found, or 'none'. */
  tokenSource: import('./config.js').TokenSource;
  /** Global `--json` flag. Commands should not format output themselves. */
  json: boolean;
  /** Global `--yes`: pre-approve gates in this run. See spec 5.1. */
  yes: boolean;
  /** Global `--max-spend`, when supplied. Overrides `--yes` for spend gates. */
  maxSpend: number | undefined;
  /** `gate@fingerprint` values passed via `--approve`. */
  approvals: readonly string[];
  /** The command being run, e.g. `deploy`. Used for telemetry headers. */
  commandName: string;
  /** Human-facing output. Never write to stdout directly. */
  io: import('./io.js').Io;
  /** Raw positional arguments after the command name. */
  positionals: readonly string[];
}

export interface CommandRunArgs<O extends OptionsSpec> {
  opts: ResolvedOptionsFor<O>;
  /** HTTP client bound to `api.baseUrl`, with auth and telemetry headers set. */
  client: import('./http.js').ApiClient;
  ctx: CommandContext;
}

/** Maps an OptionsSpec to the concrete value type each option resolves to. */
export type ResolvedOptionsFor<O extends OptionsSpec> = {
  [K in keyof O]: OptionValue<O[K]>;
};

type OptionValue<S extends OptionSpec> = S['type'] extends 'number'
  ? NumberOrUndefined<S>
  : S['type'] extends 'boolean'
    ? boolean
    : StringOrUndefined<S>;

type NumberOrUndefined<S extends OptionSpec> = S extends { required: true }
  ? number
  : S extends { default: number }
    ? number
    : number | undefined;

type StringOrUndefined<S extends OptionSpec> = S extends { required: true }
  ? StringChoice<S>
  : S extends { default: string }
    ? StringChoice<S>
    : StringChoice<S> | undefined;

type StringChoice<S extends OptionSpec> = S extends { choices: readonly (infer C)[] }
  ? C
  : string;

export interface CommandSpec<O extends OptionsSpec = OptionsSpec> {
  description: string;
  options?: O;
  /** Positional argument names, for help text and the skill generator. */
  positionals?: readonly string[];
  /**
   * Marks the command as money-spending. The skill generator emits an explicit
   * approval warning for it, and the runtime refuses `--yes` without an
   * accompanying `--max-spend` when `requireSpendLimit` is set on the tool.
   */
  spends?: boolean;
  /** Extra exit codes this command can produce, as `code -> description`. */
  exitCodes?: Readonly<Record<number, string>>;
  run: (args: CommandRunArgs<O>) => Promise<unknown> | unknown;
}

/**
 * Identity helper that pins the option types so `run()` gets precise `opts`.
 * Purely a type-inference device — it returns its argument unchanged.
 */
export function command<const O extends OptionsSpec>(spec: CommandSpec<O>): CommandSpec<O> {
  return spec;
}

export interface ApiSpec {
  baseUrl: string;
  /** Device-flow + checkpoint issuer. Defaults to `baseUrl` when omitted. */
  authUrl?: string;
}

export interface TelemetrySpec {
  endpoint: string;
  optOutEnv: string;
}

export interface ToolSpec {
  /** Binary name, e.g. `mytool`. Used verbatim in generated `next.approve`. */
  name: string;
  version: string;
  description?: string;
  api?: ApiSpec;
  /** Where config.json + token live. `~` is expanded. Default `~/.<name>`. */
  configDir?: string;
  telemetry?: TelemetrySpec;
  /** Refuse `--yes` on spending commands unless `--max-spend` is also given. */
  requireSpendLimit?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  commands: Record<string, CommandSpec<any>>;
}

export interface DefinedTool extends ToolSpec {
  readonly __invokable: 'tool';
}

export function defineTool(spec: ToolSpec): DefinedTool {
  if (!/^[a-z][a-z0-9-]*$/.test(spec.name)) {
    throw new TypeError(
      `Tool name "${spec.name}" must be lowercase alphanumeric with dashes — it is used as the binary name.`,
    );
  }
  for (const [name, cmd] of Object.entries(spec.commands)) {
    if (!cmd.description) {
      throw new TypeError(`Command "${name}" needs a description; the skill generator requires it.`);
    }
  }
  return { ...spec, __invokable: 'tool' };
}
