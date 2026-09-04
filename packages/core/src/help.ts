import { EXIT, EXIT_DESCRIPTION, type ExitName } from './exit-codes.js';
import { resolveCommands } from './builtins.js';
import type { CommandSpec, DefinedTool, OptionSpec, OptionsSpec } from './schema.js';

/** Machine-readable description of the tool, emitted by `--help --json`. */
export interface ToolManifest {
  name: string;
  version: string;
  description: string | undefined;
  commands: Array<{
    name: string;
    description: string;
    spends: boolean;
    positionals: readonly string[];
    options: Array<{ name: string } & OptionSpec>;
  }>;
  exitCodes: Array<{ code: number; name: string; description: string }>;
}

export function buildManifest(tool: DefinedTool): ToolManifest {
  return {
    name: tool.name,
    version: tool.version,
    description: tool.description,
    commands: Object.entries(resolveCommands(tool)).map(([name, cmd]) => ({
      name,
      description: cmd.description,
      spends: cmd.spends ?? false,
      positionals: cmd.positionals ?? [],
      options: optionEntries(cmd).map(([optName, spec]) => ({
        name: optName,
        ...spec,
      })),
    })),
    exitCodes: (Object.keys(EXIT) as ExitName[]).map((name) => ({
      code: EXIT[name],
      name,
      description: EXIT_DESCRIPTION[name],
    })),
  };
}

/** `CommandSpec<any>` erases the option map, so re-narrow it in one place. */
function optionEntries(cmd: CommandSpec): Array<[string, OptionSpec]> {
  return Object.entries((cmd.options ?? {}) as OptionsSpec);
}

function formatOption(name: string, spec: OptionSpec): string {
  const flag = spec.short ? `-${spec.short}, --${name}` : `    --${name}`;
  const value = spec.type === 'boolean' ? '' : ` <${spec.type}>`;
  const bits: string[] = [];
  if (spec.required) bits.push('required');
  if (spec.choices) bits.push(spec.choices.join('|'));
  if (spec.default !== undefined) bits.push(`default: ${String(spec.default)}`);
  const suffix = bits.length ? ` (${bits.join(', ')})` : '';
  return `  ${(flag + value).padEnd(30)} ${spec.description ?? ''}${suffix}`.trimEnd();
}

export function renderToolHelp(tool: DefinedTool): string {
  const lines: string[] = [];
  lines.push(`${tool.name} ${tool.version}`);
  if (tool.description) lines.push(tool.description);
  lines.push('');
  lines.push(`Usage: ${tool.name} <command> [options]`);
  lines.push('');
  lines.push('Commands:');
  const all = resolveCommands(tool);
  const width = Math.max(...Object.keys(all).map((c) => c.length), 8);
  for (const [name, cmd] of Object.entries(all)) {
    const marker = cmd.spends ? '  $' : '';
    lines.push(`  ${name.padEnd(width)}  ${cmd.description}${marker}`);
  }
  lines.push('');
  lines.push('Global options:');
  lines.push('      --json                     Emit one JSON envelope on stdout.');
  lines.push('      --yes                      Auto-approve gates (audited server-side).');
  lines.push('      --max-spend <number>       Cap spend; overrides --yes.');
  lines.push('      --approve <gate@fp>        Supply an approval fingerprint.');
  lines.push('      --token <token>            Override the stored token (visible in ps).');
  lines.push('  -h, --help                     Show this help.');
  lines.push('  -V, --version                  Show the version.');
  lines.push('');
  lines.push('$ marks commands that can spend money.');
  return lines.join('\n');
}

export function renderCommandHelp(
  tool: DefinedTool,
  name: string,
  cmd: CommandSpec,
): string {
  const lines: string[] = [];
  const positionals = (cmd.positionals ?? []).map((p) => `<${p}>`).join(' ');
  lines.push(`Usage: ${tool.name} ${name}${positionals ? ' ' + positionals : ''} [options]`);
  lines.push('');
  lines.push(cmd.description);
  if (cmd.spends) {
    lines.push('');
    lines.push('This command can spend money. It will stop at an approval gate (exit 10)');
    lines.push('unless an --approve fingerprint is supplied.');
  }
  const options = optionEntries(cmd);
  if (options.length) {
    lines.push('');
    lines.push('Options:');
    for (const [optName, spec] of options) lines.push(formatOption(optName, spec));
  }
  return lines.join('\n');
}
