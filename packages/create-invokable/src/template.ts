/** `deploy-thing` -> `DeployThing`, for a generated type name. */
function pascal(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('');
}

export interface ScaffoldSpec {
  /** Binary and package name. Must be a valid skill name too. */
  name: string;
  /** First real command, e.g. `deploy`. */
  command: string;
  /** Whether the first command spends money and needs an approval gate. */
  spends: boolean;
  /** `hosted` points at auth.invokable.dev; `self-host` at localhost. */
  auth: 'hosted' | 'self-host';
  version?: string;
}

export interface ScaffoldFile {
  path: string;
  content: string;
  executable?: boolean;
}

const HOSTED_AUTH_URL = 'https://auth.invokable.dev';

function apiUrls(spec: ScaffoldSpec): { baseUrl: string; authUrl: string } {
  return spec.auth === 'hosted'
    ? { baseUrl: `https://api.${spec.name}.example.com`, authUrl: HOSTED_AUTH_URL }
    : { baseUrl: 'http://127.0.0.1:8787', authUrl: 'http://127.0.0.1:8787' };
}

function toolSource(spec: ScaffoldSpec): string {
  const { baseUrl, authUrl } = apiUrls(spec);
  const envPrefix = spec.name.toUpperCase().replace(/-/g, '_');

  // The response type is declared rather than inferred: `client.post()` returns
  // `unknown` by design, so a template that destructured it straight away would
  // ship a project that does not compile.
  const planType = `
/** Shape your \`/v1/${spec.command}/plan\` endpoint returns. Adjust to match. */
interface ${pascal(spec.command)}Plan {
  id: string;
  summary?: unknown;
  credits: number;
  balance: number;
}
`;

  const gated = `
    ${JSON.stringify(spec.command)}: command({
      description: 'Describe what this does — the agent reads this to decide when to run it.',
      options: {
        env: {
          type: 'string',
          required: true,
          choices: ['staging', 'prod'],
          description: 'Which environment to target.',
        },
      },
      // Marks the command as spending money: the generated SKILL.md warns the
      // agent, and \`--yes\` can be refused without \`--max-spend\`.
      spends: true,
      run: async ({ opts, client, ctx }) => {
        const plan = await client.post<${pascal(spec.command)}Plan>(
          '/v1/${spec.command}/plan',
          { env: opts.env },
        );

        // Stops here and exits 10 unless an approval fingerprint was supplied.
        await checkpoint(ctx, {
          gate: '${spec.command}_review',
          title: '${spec.command} plan',
          summary: plan.summary ?? plan,
          subject: plan.id,
          question: \`Run ${spec.command} against \${opts.env}?\`,
          explain: 'Approving starts the work and bills the account.',
          spend: { estimated: plan.credits, balance: plan.balance },
          reject: \`${spec.name} ${spec.command} --env \${opts.env} --dry-run\`,
        });

        return client.post('/v1/${spec.command}', { planId: plan.id });
      },
    }),`;

  const plain = `
    ${JSON.stringify(spec.command)}: command({
      description: 'Describe what this does — the agent reads this to decide when to run it.',
      options: {
        name: {
          type: 'string',
          required: true,
          description: 'What to act on.',
        },
      },
      run: async ({ opts, client, ctx }) => {
        ctx.io.note(\`working on \${opts.name}…\`); // progress → stderr
        return client.get(\`/v1/${spec.command}/\${encodeURIComponent(opts.name)}\`);
      },
    }),`;

  return `import { command, defineTool${spec.spends ? ', checkpoint' : ''} } from '@invokable/core';
import { initCommand } from '@invokable/skills';

import pkg from '../package.json' with { type: 'json' };
${spec.spends ? planType : ''}
export default defineTool({
  name: '${spec.name}',
  version: pkg.version,
  description: 'One line an agent reads to decide whether this tool is relevant.',

  api: {
    baseUrl: process.env.${envPrefix}_API ?? '${baseUrl}',
    authUrl: process.env.${envPrefix}_AUTH ?? '${authUrl}',
  },
  configDir: '~/.${spec.name}',
${spec.spends ? '\n  // Refuse `--yes` on spending commands unless `--max-spend` is also given.\n  requireSpendLimit: true,\n' : ''}
  commands: {
    // Installs agent instructions into this project. login/logout/whoami/doctor
    // are built in and need no declaration.
    init: initCommand(),
${spec.spends ? gated : plain}
  },
});
`;
}

function readme(spec: ScaffoldSpec): string {
  const envPrefix = spec.name.toUpperCase().replace(/-/g, '_');
  return `# ${spec.name}

An agent-native CLI built with [invokable](https://github.com/beinvokable/invokable).

## Develop

\`\`\`bash
npm install
npm run build
node bin/${spec.name}.mjs --help
\`\`\`

## Try it

\`\`\`bash
# Install agent instructions into a project
node bin/${spec.name}.mjs init

# Check connectivity and auth
node bin/${spec.name}.mjs doctor --json
\`\`\`
${
  spec.auth === 'self-host'
    ? `
### Run the auth server

This project is configured for self-hosted auth. Start a server that mounts
\`@invokable/server\` on \`${apiUrls(spec).authUrl}\`, then:

\`\`\`bash
node bin/${spec.name}.mjs login
\`\`\`
`
    : `
### Sign in

Auth points at \`${HOSTED_AUTH_URL}\`. Override for local development:

\`\`\`bash
${envPrefix}_AUTH=http://127.0.0.1:8787 node bin/${spec.name}.mjs login
\`\`\`
`
}
## The contract

Every command emits **one JSON document on stdout** with \`--json\`, and a
semantic exit code. Progress goes to stderr.

\`\`\`console
$ ${spec.name} ${spec.command} --json
{"status":"ok","data":{ ... }}

$ echo $?
0
\`\`\`

Check it holds:

\`\`\`bash
npx invokable-test node bin/${spec.name}.mjs
\`\`\`
${
  spec.spends
    ? `
## Approval gate

\`${spec.command}\` spends money, so it stops first:

\`\`\`console
$ ${spec.name} ${spec.command} --env prod --json
{"status":"checkpoint","gate":"${spec.command}_review","fingerprint":"…",
 "next":{"approve":"${spec.name} ${spec.command} --env prod --json --approve ${spec.command}_review@…"}}
$ echo $?
10
\`\`\`

The fingerprint is issued by your API, bound to the plan the user was shown,
and consumed once. Mount \`checkpointRoutes()\` and \`verifyCheckpoint()\` from
\`@invokable/server\` to issue and verify them.
`
    : ''
}
## Agent instructions

\`${spec.name} init\` writes a portable \`SKILL.md\` for Claude Code, Codex, Cursor
and Gemini CLI, plus sections in \`AGENTS.md\` and Copilot instructions. Re-run it
whenever you add a command; \`init --check\` fails CI when they are stale.
`;
}

export function scaffold(spec: ScaffoldSpec): ScaffoldFile[] {
  const version = spec.version ?? '0.1.0';

  const pkg = {
    name: spec.name,
    version,
    description: 'An agent-native CLI.',
    type: 'module',
    bin: { [spec.name]: `./bin/${spec.name}.mjs` },
    files: ['bin', 'dist'],
    engines: { node: '>=20' },
    scripts: {
      build: 'tsc -p tsconfig.json',
      dev: 'tsc -p tsconfig.json --watch',
      test: 'invokable-test node bin/' + spec.name + '.mjs',
      prepublishOnly: 'npm run build',
    },
    dependencies: {
      '@invokable/core': '^0.1.0',
      '@invokable/skills': '^0.1.0',
    },
    devDependencies: {
      '@invokable/conformance': '^0.1.0',
      '@types/node': '^22.0.0',
      typescript: '^5.9.0',
    },
  };

  return [
    { path: 'package.json', content: JSON.stringify(pkg, null, 2) + '\n' },
    {
      path: 'tsconfig.json',
      content:
        JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2023',
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              types: ['node'],
              strict: true,
              declaration: true,
              resolveJsonModule: true,
              outDir: 'dist',
              rootDir: 'src',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ) + '\n',
    },
    { path: 'src/tool.ts', content: toolSource(spec) },
    {
      path: `bin/${spec.name}.mjs`,
      executable: true,
      content: `#!/usr/bin/env node
import { cli } from '@invokable/core';
import tool from '../dist/tool.js';

await cli(tool);
`,
    },
    { path: 'README.md', content: readme(spec) },
    {
      path: '.gitignore',
      content: 'node_modules/\ndist/\n*.tsbuildinfo\n.env\n.env.*\n!.env.example\n',
    },
    {
      path: '.github/workflows/ci.yml',
      content: `name: CI

on:
  push:
    branches: ['**']
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm run build

      # The contract an agent depends on.
      - run: npx invokable-test node bin/${spec.name}.mjs

      # Fails when a command was added but the agent instructions were not
      # regenerated.
      - run: node bin/${spec.name}.mjs init --check
`,
    },
  ];
}
