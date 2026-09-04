import { readFileSync } from 'node:fs';

/**
 * The `@invokable/*` range a scaffolded project depends on.
 *
 * Read from this package's own version rather than written down. Every package
 * in the monorepo shares one version, and a caret range on 0.x does not cross a
 * minor bump — so a hardcoded `^0.2.0` left here would make
 * `create-invokable@0.3.0` scaffold projects pinned to an SDK it was never
 * tested against.
 */
function sdkRange(): string {
  const manifest = new URL('../package.json', import.meta.url);
  const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as { version: string };
  return `^${version}`;
}

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

/**
 * A runnable server for `--auth self-host`.
 *
 * Telling someone to "start a server that mounts @invokable/server" and handing
 * them nothing is where the self-host path used to break: the CLI half was
 * scaffolded and the other half was a sentence. This is the other half.
 */
function serverSource(spec: ScaffoldSpec): string {
  return `#!/usr/bin/env node
/**
 * Development auth + checkpoint server for ${spec.name}.
 *
 *   npm run server        # this file, on :8787
 *   npm run build && node bin/${spec.name}.mjs login
 *
 * Three things are served: auth and checkpoints come from @invokable/server,
 * and the ${spec.command} endpoints are yours to replace with the real thing.
 */
import { createServer } from 'node:http';
import {
  CheckpointVerifier,
  checkpointRoutes,
  invokableAuth,
  memoryCheckpointStore,
  memoryStore,
  verifyCheckpoint,
} from '@invokable/server';
import { nodeListener } from '@invokable/server/node';

const PORT = Number(process.env.PORT ?? 8787);

// Signs approval fingerprints. In production this comes from your secret
// manager and never leaves your infrastructure.
const CHECKPOINT_SECRET = process.env.CHECKPOINT_SECRET ?? 'dev-only-change-me-0123456789abcdef';

const verifier = new CheckpointVerifier({
  secret: CHECKPOINT_SECRET,
  // Development only — everything is lost on restart, and on serverless there
  // is no shared memory at all. Swap for postgresCheckpointStore() before
  // anyone depends on this. See the @invokable/server README.
  store: memoryCheckpointStore(),
});

const auth = invokableAuth({
  store: memoryStore(),
  tokenPrefix: '${spec.name.replace(/-/g, '').slice(0, 4)}',
  tokenTtl: null,

  // THE HOOK YOU MUST REPLACE.
  //
  // Runs on the approval page, in the browser. It answers "who is signed in
  // right now?" from your own session — a cookie, a JWT, whatever you already
  // have. Returning null means signed out, and nothing can be approved.
  requireSession: (_request) => ({
    subject: 'dev@example.com',
    displayName: 'Local Developer',
  }),

  // Optional: your own branded approval page. If you replace the default, KEEP
  // the part naming the tool, version and machine, and the warning to approve
  // only a login you just started — that display is the only defence against
  // someone sending a user a code and asking them to approve it.
  // approvePage: ({ device, user }) => renderMyPage(device, user),
});

const checkpoints = checkpointRoutes({ verifier });
${
  spec.spends
    ? `
// Guards only the endpoint that spends. Guarding the planning call too would
// mean the CLI could never fetch a plan to show the user, and the gate could
// never open.
const requireApproval = verifyCheckpoint({
  verifier,
  requiresApproval: (request) => new URL(request.url).pathname === '/v1/${spec.command}',
  // Must return the same \`subject\` the CLI passes to checkpoint(). It binds an
  // approval to one target, so an approval for A cannot act on B.
  subjectFor: () => 'svc-1',
});
`
    : ''
}
const state = { runs: [], balance: 100 };
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

createServer(
  nodeListener(async (request) => {
    const { pathname } = new URL(request.url);
${
  spec.spends
    ? `
    // Planning changes nothing, so it is not gated. It produces the summary the
    // user is about to be asked to approve.
    if (pathname === '/v1/${spec.command}/plan' && request.method === 'POST') {
      const { env } = await request.json().catch(() => ({}));
      return json({ id: 'svc-1', env, credits: 12, balance: state.balance, summary: { env } });
    }

    if (pathname === '/v1/${spec.command}' && request.method === 'POST') {
      // Returns a 409 the CLI turns into exit 12 when the approval is missing,
      // stale, expired or already used. Returns null when it is good.
      const rejected = await requireApproval(request);
      if (rejected) return rejected;

      const id = \`run_\${state.runs.length + 1}\`;
      state.runs.push(id);
      state.balance -= 12;
      return json({ ok: true, id, balanceAfter: state.balance });
    }
`
    : `
    if (pathname.startsWith('/v1/${spec.command}/')) {
      return json({ ok: true, name: decodeURIComponent(pathname.split('/').pop() ?? '') });
    }
`
}
    // Each returns null for paths it does not own, so they compose with yours.
    return (await auth(request)) ?? (await checkpoints(request));
  }),
).listen(PORT, () => {
  console.error(\`${spec.name} dev server on http://127.0.0.1:\${PORT}\`);
  console.error('');
  console.error('  auth        POST /device/start   GET /device   POST /device/token');
  console.error('  checkpoints POST /checkpoints    POST /checkpoints/verify');
  console.error('  yours       ${spec.spends ? `POST /v1/${spec.command}/plan   POST /v1/${spec.command}` : `GET /v1/${spec.command}/:name`}');
  console.error('');
  console.error('  Next:  npm run build && node bin/${spec.name}.mjs login');
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

\`${spec.name}\` is not on your PATH until you link it, so run it by path while
developing. To type the bare name instead:

\`\`\`bash
npm link          # once
${spec.name} --help
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
### Run the server

This project is self-hosted, so it ships its own server — \`server.mjs\` in this
directory. It serves three things:

| | |
|---|---|
| Auth | the device-code endpoints \`login\` talks to (from \`@invokable/server\`) |
| Checkpoints | issuing and verifying approval fingerprints (from \`@invokable/server\`) |
| \`/v1/${spec.command}\` | **yours** — replace with the real thing |

\`\`\`bash
npm run server                       # terminal 1, on :8787
npm run build
node bin/${spec.name}.mjs login      # terminal 2
\`\`\`

\`login\` prints a code and a URL. Open the URL, approve, and the CLI finishes on
its own.

### Before this is production

\`server.mjs\` is wired for a laptop. Three things must change, and each is
marked in the file:

- **\`requireSession\`** returns a fixed user. Replace it with your own session
  lookup — a cookie, a JWT, whatever you already have. Returning \`null\` means
  signed out, and nothing can be approved.
- **\`memoryStore()\` and \`memoryCheckpointStore()\`** lose everything on
  restart, and on serverless there is no shared memory at all. Swap for
  \`postgresAuthStore()\` and \`postgresCheckpointStore()\`; see the
  [\`@invokable/server\` README](https://www.npmjs.com/package/@invokable/server).
- **\`CHECKPOINT_SECRET\`** is a literal. Move it to your secret manager.

Two things the SDK deliberately leaves to you: CSRF protection on
\`/device/approve\` if you serve a cookie-authenticated form, and rate limiting
on \`/device/start\`.

Mounting in an app you already have? The handlers are
\`(Request) => Promise<Response | null>\` and return \`null\` for paths they do not
own, so they compose with your routes. \`@invokable/server/node\` adapts them to
Express.
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
  const sdk = sdkRange();

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
      ...(spec.auth === 'self-host' ? { server: 'node server.mjs' } : {}),
      prepublishOnly: 'npm run build',
    },
    dependencies: {
      '@invokable/core': sdk,
      '@invokable/skills': sdk,
      // Only self-host projects ship a server; hosted tools talk to one.
      ...(spec.auth === 'self-host' ? { '@invokable/server': sdk } : {}),
    },
    devDependencies: {
      '@invokable/conformance': sdk,
      '@types/node': '^22.0.0',
      typescript: '^5.9.0',
    },
  };

  const files: ScaffoldFile[] = [
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

  if (spec.auth === 'self-host') {
    files.push({ path: 'server.mjs', content: serverSource(spec), executable: true });
  }

  return files;
}
