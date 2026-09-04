import { EXIT } from './exit-codes.js';
import { ok, type Envelope } from './envelope.js';
import { InvokableError, isInvokableError, usageError } from './errors.js';
import { Io, type Streams } from './io.js';
import { parseArgv, resolveOptions } from './parse-args.js';
import { buildManifest, renderCommandHelp, renderToolHelp } from './help.js';
import { ConfigStore, resolveToken } from './config.js';
import { ApiClient, unconfiguredClient } from './http.js';
import { resolveCommands } from './builtins.js';
import { CheckpointPending } from './checkpoint.js';
import type { CommandContext, DefinedTool, ResolvedOptions } from './schema.js';

export interface RunOptions {
  argv?: readonly string[];
  streams?: Partial<Streams>;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  exitCode: number;
  envelope: Envelope | undefined;
}

/**
 * Executes one CLI invocation and returns the exit code instead of calling
 * `process.exit`, so the whole runtime is testable in-process. `cli()` is the
 * thin wrapper that binds it to a real process.
 */
export async function runTool(tool: DefinedTool, options: RunOptions = {}): Promise<RunResult> {
  const argv = options.argv ?? process.argv.slice(2);

  // Parsing itself can raise a usage error, so `io` must exist first. `--json`
  // is detected up front by a cheap scan: we cannot format the error envelope
  // correctly without knowing the output mode.
  const jsonRequested = argv.includes('--json');
  const io = new Io({
    json: jsonRequested,
    ...(options.streams !== undefined ? { streams: options.streams } : {}),
  });

  try {
    const parsed = parseArgv(argv);
    const { globals } = parsed;

    if (globals.version) {
      return finish(io, ok({ name: tool.name, version: tool.version }), EXIT.ok, () =>
        io.note(tool.version),
      );
    }

    if (globals.token) {
      io.warn(
        'warning: --token is visible to other processes via `ps`. Prefer the environment variable or `login`.',
      );
    }

    const commands = resolveCommands(tool);
    const commandName = parsed.command;

    if (commandName === undefined || globals.help) {
      if (commandName !== undefined && commands[commandName]) {
        const cmd = commands[commandName]!;
        return finish(io, ok(buildManifest(tool)), EXIT.ok, () =>
          io.note(renderCommandHelp(tool, commandName, cmd)),
        );
      }
      if (commandName === undefined && !globals.help) {
        // Bare invocation: help text, but exit 2 so an agent sees a usage problem.
        return finish(io, undefined, EXIT.usage, () => io.note(renderToolHelp(tool)), {
          error: usageError('No command given.', `${tool.name} --help`),
        });
      }
      return finish(io, ok(buildManifest(tool)), EXIT.ok, () => io.note(renderToolHelp(tool)));
    }

    const cmd = commands[commandName];
    if (!cmd) {
      const known = Object.keys(commands).sort().join(', ');
      throw usageError(
        `Unknown command "${commandName}". Known commands: ${known}.`,
        `${tool.name} --help`,
      );
    }

    if (cmd.spends && globals.yes && tool.requireSpendLimit && globals.maxSpend === undefined) {
      throw usageError(
        `"${commandName}" can spend money, and this tool requires --max-spend alongside --yes.`,
        `${tool.name} ${commandName} --yes --max-spend <number>`,
      );
    }

    const opts: ResolvedOptions = resolveOptions(cmd.options, parsed.raw, commandName);

    const config = new ConfigStore(tool.configDir ?? `~/.${tool.name}`);
    const env = options.env ?? process.env;
    const { token, source: tokenSource } = resolveToken({
      toolName: tool.name,
      flagToken: globals.token,
      env,
      config: config.read(),
    });

    const client = tool.api?.baseUrl
      ? new ApiClient({
          baseUrl: tool.api.baseUrl,
          token,
          toolName: tool.name,
          toolVersion: tool.version,
          commandName,
          env,
        })
      : unconfiguredClient(tool.name);

    const checkpointClient = tool.api?.baseUrl ? client : undefined;

    const ctx: CommandContext = {
      tool,
      config,
      tokenSource,
      checkpointClient,
      attachCheckpoint: (gate, fingerprint) => client.setCheckpoint(gate, fingerprint),
      json: globals.json,
      yes: globals.yes,
      maxSpend: globals.maxSpend,
      approvals: globals.approvals,
      commandName,
      io,
      positionals: parsed.positionals,
      argv,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await io.guardStdout(async () => cmd.run({ opts: opts as any, client, ctx }));

    return finish(io, ok(data ?? null), EXIT.ok, () => {
      if (data === undefined || data === null) return;
      const rendered = cmd.formatHuman ? cmd.formatHuman(data) : formatHuman(data);
      if (rendered !== null) io.note(rendered);
    });
  } catch (e) {
    return failure(io, e);
  }
}

function finish(
  io: Io,
  envelope: Envelope | undefined,
  exitCode: number,
  humanOutput: () => void,
  extra?: { error?: InvokableError },
): RunResult {
  if (io.json) {
    const env = envelope ?? extra?.error?.toEnvelope();
    if (env) io.emit(env);
    return { exitCode, envelope: env };
  }
  humanOutput();
  if (extra?.error) io.note(`error: ${extra.error.message}`);
  return { exitCode, envelope };
}

function failure(io: Io, e: unknown): RunResult {
  // A pending gate is not a failure: it is the documented way a command stops
  // to ask. It carries its own envelope and the reserved exit code 10.
  if (e instanceof CheckpointPending) {
    if (io.json) {
      if (!io.hasEmitted) io.emit(e.envelope);
    } else {
      io.note(e.envelope.display);
      io.note('');
      io.note(`To approve, run:\n  ${e.envelope.next.approve}`);
      if (e.envelope.next.reject) io.note(`To decline, run:\n  ${e.envelope.next.reject}`);
    }
    return { exitCode: EXIT.checkpoint_pending, envelope: e.envelope };
  }

  const err = isInvokableError(e)
    ? e
    : new InvokableError({
        code: 'error',
        message: e instanceof Error ? e.message : String(e),
        cause: e,
      });

  const envelope = err.toEnvelope();

  if (io.json) {
    if (!io.hasEmitted) io.emit(envelope);
  } else {
    io.note(`error: ${err.message}`);
    if (err.remediation) io.note(`try: ${err.remediation}`);
  }

  // The stack is a debugging aid for humans, never part of the contract.
  if (!isInvokableError(e) && e instanceof Error && e.stack && process.env['INVOKABLE_DEBUG']) {
    io.note(e.stack);
  }

  return { exitCode: err.exitCode, envelope };
}

function formatHuman(data: unknown): string {
  if (typeof data === 'string') return data;
  return JSON.stringify(data, null, 2);
}

/** Process-bound entry point. Sets `process.exitCode`; does not force-exit. */
export async function cli(tool: DefinedTool, argv?: readonly string[]): Promise<void> {
  const result = await runTool(tool, argv !== undefined ? { argv } : {});
  process.exitCode = result.exitCode;
}
