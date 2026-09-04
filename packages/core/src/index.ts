export { EXIT, EXIT_NAME, EXIT_DESCRIPTION, CUSTOM_EXIT_RANGE, isReservedExitCode, assertCustomExitCode } from './exit-codes.js';
export type { ExitName, ExitCode } from './exit-codes.js';

export {
  ok,
  errorEnvelope,
  isCheckpointEnvelope,
  serializeEnvelope,
  CHECKPOINT_SCHEMA,
} from './envelope.js';
export type {
  Envelope,
  OkEnvelope,
  ErrorEnvelope,
  CheckpointPayload,
  CheckpointChoice,
  SpendInfo,
} from './envelope.js';

export {
  InvokableError,
  isInvokableError,
  usageError,
  authError,
  notFoundError,
  networkError,
  declinedError,
} from './errors.js';
export type { InvokableErrorInit } from './errors.js';

export { Io } from './io.js';
export type { Streams } from './io.js';

export { defineTool, command } from './schema.js';
export type {
  ToolSpec,
  DefinedTool,
  CommandSpec,
  CommandContext,
  CommandRunArgs,
  OptionSpec,
  OptionsSpec,
  OptionType,
  ResolvedOptions,
  ApiSpec,
  TelemetrySpec,
} from './schema.js';

export { parseArgv, resolveOptions, GLOBAL_FLAGS } from './parse-args.js';
export type { ParsedArgv, GlobalOptions } from './parse-args.js';

export { buildManifest, renderToolHelp, renderCommandHelp } from './help.js';
export type { ToolManifest } from './help.js';

export { runTool, cli } from './run.js';
export type { RunOptions, RunResult } from './run.js';
