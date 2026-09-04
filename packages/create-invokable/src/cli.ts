import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { scaffold, type ScaffoldSpec } from './template.js';
import { nonInteractivePrompter, terminalPrompter, type Prompter } from './prompt.js';

export interface CreateOptions {
  argv: readonly string[];
  cwd?: string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  prompter?: Prompter;
}

const USAGE = `Usage: create-invokable <name> [options]

Scaffolds an agent-native CLI.

Options:
      --command <name>   First command. Default: deploy.
      --spends           The first command spends money and needs approval.
      --no-spends        It does not.
      --auth <mode>      hosted | self-host. Default: hosted.
  -y, --yes              Accept every default; do not prompt.
  -h, --help             Show this help.
`;

/** Skill-name rules, so `init` can generate a valid SKILL.md later. */
const NAME_PATTERN = /^[a-z0-9-]{1,64}$/;

export async function createMain(options: CreateOptions): Promise<number> {
  const stderr = options.stderr ?? ((s) => process.stderr.write(s));
  const cwd = options.cwd ?? process.cwd();

  const argv = [...options.argv];
  let name: string | undefined;
  let commandName: string | undefined;
  let spends: boolean | undefined;
  let auth: ScaffoldSpec['auth'] | undefined;
  let acceptDefaults = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--help' || token === '-h') {
      stderr(USAGE);
      return 0;
    } else if (token === '--yes' || token === '-y') {
      acceptDefaults = true;
    } else if (token === '--spends') {
      spends = true;
    } else if (token === '--no-spends') {
      spends = false;
    } else if (token === '--command') {
      commandName = argv[++i];
    } else if (token === '--auth') {
      const value = argv[++i];
      if (value !== 'hosted' && value !== 'self-host') {
        stderr(`error: --auth must be "hosted" or "self-host"; got ${JSON.stringify(value)}\n`);
        return 2;
      }
      auth = value;
    } else if (token.startsWith('-')) {
      stderr(`error: unknown option ${token}\n${USAGE}`);
      return 2;
    } else if (name === undefined) {
      name = token;
    }
  }

  const prompter =
    options.prompter ??
    (acceptDefaults || !process.stdin.isTTY ? nonInteractivePrompter() : terminalPrompter());

  try {
    if (name === undefined) {
      name = await prompter.text('Tool name?', 'my-tool');
    }
    if (!NAME_PATTERN.test(name)) {
      stderr(
        `error: "${name}" is not a usable tool name. Use lowercase letters, digits and ` +
          'hyphens — it becomes the binary name and the skill name.\n',
      );
      return 2;
    }

    const target = resolve(cwd, name);
    if (existsSync(target) && readdirSync(target).length > 0) {
      stderr(`error: ${target} already exists and is not empty.\n`);
      return 6;
    }

    if (auth === undefined) {
      auth = await prompter.choice(
        'Auth server?',
        ['hosted', 'self-host'] as const,
        'hosted',
      );
    }
    if (commandName === undefined) {
      commandName = await prompter.text('First command?', 'deploy');
    }
    if (spends === undefined) {
      spends = await prompter.confirm('Does it spend money or need approval?', true);
    }

    const files = scaffold({ name, command: commandName, spends, auth });

    for (const file of files) {
      const path = join(target, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content, 'utf8');
      if (file.executable) chmodSync(path, 0o755);
    }

    stderr(`\nCreated ${target}\n\n`);
    for (const file of files) stderr(`  ${file.path}\n`);
    // Spelled out because `${name} login` is the first thing people try, and
    // it is not a command until the package is linked. Getting
    // "command not found" straight after a successful scaffold reads as the
    // tool being broken.
    const lines = [
      '',
      'Next:',
      `  cd ${name}`,
      '  npm install',
      '  npm run build',
      '',
      `Run it with the full path — \`${name}\` is not on your PATH yet:`,
      `  node bin/${name}.mjs --help`,
      `  node bin/${name}.mjs doctor --json`,
      '',
      `To type \`${name}\` instead, link it once:`,
      '  npm link',
      `  ${name} --help`,
      '',
    ];

    if (auth === 'self-host') {
      lines.push(
        'This project is self-hosted, so it ships its own server.',
        'Start it in another terminal before you sign in:',
        '  npm run server',
        `  node bin/${name}.mjs login`,
        '',
      );
    } else {
      lines.push(
        'Sign in (opens a browser):',
        `  node bin/${name}.mjs login`,
        '',
      );
    }

    lines.push('Then check the contract holds:', `  npx invokable-test node bin/${name}.mjs`, '');

    stderr(lines.join('\n'));
    return 0;
  } finally {
    prompter.close();
  }
}
