import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createMain } from '../src/cli.js';
import { scaffold, type ScaffoldSpec } from '../src/template.js';
import { nonInteractivePrompter } from '../src/prompt.js';

const execFileAsync = promisify(execFile);

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'invokable-create-'));
  dirs.push(d);
  return d;
}

const base: ScaffoldSpec = { name: 'my-tool', command: 'deploy', spends: true, auth: 'hosted' };

function fileMap(spec: ScaffoldSpec): Map<string, string> {
  return new Map(scaffold(spec).map((f) => [f.path, f.content]));
}

describe('scaffolded files', () => {
  it('includes everything a publishable CLI needs', () => {
    const paths = scaffold(base).map((f) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'package.json',
        'tsconfig.json',
        'src/tool.ts',
        'bin/my-tool.mjs',
        'README.md',
        '.gitignore',
        '.github/workflows/ci.yml',
      ]),
    );
  });

  it('declares the binary and marks it executable', () => {
    const files = scaffold(base);
    const pkg = JSON.parse(files.find((f) => f.path === 'package.json')!.content);
    expect(pkg.bin).toEqual({ 'my-tool': './bin/my-tool.mjs' });
    expect(files.find((f) => f.path === 'bin/my-tool.mjs')!.executable).toBe(true);
  });

  it('generates a checkpoint only when the command spends', () => {
    expect(fileMap({ ...base, spends: true }).get('src/tool.ts')).toContain('checkpoint(ctx');
    expect(fileMap({ ...base, spends: false }).get('src/tool.ts')).not.toContain('checkpoint(ctx');
  });

  it('sets requireSpendLimit for a spending tool', () => {
    expect(fileMap({ ...base, spends: true }).get('src/tool.ts')).toContain('requireSpendLimit');
    expect(fileMap({ ...base, spends: false }).get('src/tool.ts')).not.toContain('requireSpendLimit');
  });

  it('points at hosted or local auth as chosen', () => {
    expect(fileMap({ ...base, auth: 'hosted' }).get('src/tool.ts')).toContain('auth.invokable.dev');
    expect(fileMap({ ...base, auth: 'self-host' }).get('src/tool.ts')).toContain('127.0.0.1:8787');
  });

  it('derives the environment variable prefix from the name', () => {
    const source = fileMap({ ...base, name: 'my-deploy-tool' }).get('src/tool.ts')!;
    expect(source).toContain('MY_DEPLOY_TOOL_API');
  });

  it('lets every endpoint and the token store be redirected by environment', () => {
    // A second environment (a local server, CI) must not overwrite the token
    // for the first: they share one config.json unless CONFIG_DIR moves.
    const tool = fileMap({ ...base, name: 'my-tool' }).get('src/tool.ts')!;

    expect(tool).toContain('process.env.MY_TOOL_API');
    expect(tool).toContain('process.env.MY_TOOL_AUTH');
    expect(tool).toContain("process.env.MY_TOOL_CONFIG_DIR ?? '~/.my-tool'");
  });

  it('wires both contract checks into CI', () => {
    const ci = fileMap(base).get('.github/workflows/ci.yml')!;
    expect(ci).toContain('invokable-test');
    expect(ci).toContain('init --check');
  });

  it('pins the SDK to this package\'s own version', () => {
    // A hardcoded range goes stale on every release: the packages share one
    // version, and `^0.2.0` does not resolve to 0.3.0. A project scaffolded by
    // 0.3.0 must install the 0.3.0 SDK, not the one that was current when this
    // template was written.
    const own = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ).version;
    const pkg = JSON.parse(fileMap({ ...base, auth: 'self-host' }).get('package.json')!);

    for (const [name, range] of [
      ...Object.entries(pkg.dependencies),
      ...Object.entries(pkg.devDependencies),
    ]) {
      if (name.startsWith('@invokable/')) expect([name, range]).toEqual([name, `^${own}`]);
    }
  });

  it('names the generated plan type after the command', () => {
    const source = fileMap({ ...base, command: 'ship-it' }).get('src/tool.ts')!;
    expect(source).toContain('interface ShipItPlan');
    expect(source).toContain('client.post<ShipItPlan>');
  });
});

describe('the generated project compiles', () => {
  // A scaffolder that emits code which does not build is worse than none: the
  // first thing a new user does is run the build. This caught a real bug —
  // `client.post()` returns `unknown`, so an untyped template failed tsc.
  it.each([true, false])('typechecks with spends=%s', async (spends) => {
    const root = tempDir();
    const project = join(root, 'proj');

    for (const file of scaffold({ ...base, spends })) {
      const path = join(project, file.path);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, file.content);
    }

    // Typecheck the generated source against the real core types, without
    // needing a package install inside the test.
    const typeRoot = new URL('../../../node_modules/@types', import.meta.url).pathname;
    const coreDist = new URL('../../core/dist/index.d.ts', import.meta.url).pathname;
    const skillsDist = new URL('../../skills/dist/index.d.ts', import.meta.url).pathname;
    writeFileSync(
      join(project, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          // Mirror the real scaffolded config: `types: ["node"]`.
          types: ['node'],
          typeRoots: [typeRoot],
          strict: true,
          noEmit: true,
          resolveJsonModule: true,
          skipLibCheck: true,
          paths: {
            '@invokable/core': [coreDist],
            '@invokable/skills': [skillsDist],
          },
        },
        include: ['src/**/*.ts'],
      }),
    );

    const tsc = new URL('../../../node_modules/typescript/bin/tsc', import.meta.url).pathname;
    await expect(
      execFileAsync(process.execPath, [tsc, '-p', join(project, 'tsconfig.json')]),
    ).resolves.toBeDefined();
  }, 60_000);
});

describe('the CLI', () => {
  it('creates the project directory', async () => {
    const cwd = tempDir();
    const code = await createMain({
      argv: ['my-tool', '--yes'],
      cwd,
      stderr: () => {},
      prompter: nonInteractivePrompter(),
    });

    expect(code).toBe(0);
    expect(statSync(join(cwd, 'my-tool', 'package.json')).isFile()).toBe(true);
    expect(statSync(join(cwd, 'my-tool', 'bin', 'my-tool.mjs')).mode & 0o111).toBeTruthy();
  });

  it('refuses a name that could not become a skill name', async () => {
    const errors: string[] = [];
    const code = await createMain({
      argv: ['My_Tool', '--yes'],
      cwd: tempDir(),
      stderr: (s) => errors.push(s),
      prompter: nonInteractivePrompter(),
    });

    expect(code).toBe(2);
    expect(errors.join('')).toContain('not a usable tool name');
  });

  it('refuses to overwrite a non-empty directory', async () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, 'my-tool'), { recursive: true });
    writeFileSync(join(cwd, 'my-tool', 'important.txt'), 'do not lose me');

    const errors: string[] = [];
    const code = await createMain({
      argv: ['my-tool', '--yes'],
      cwd,
      stderr: (s) => errors.push(s),
      prompter: nonInteractivePrompter(),
    });

    expect(code).toBe(6);
    expect(errors.join('')).toContain('already exists');
    expect(readFileSync(join(cwd, 'my-tool', 'important.txt'), 'utf8')).toBe('do not lose me');
  });

  it('rejects an invalid --auth value', async () => {
    const errors: string[] = [];
    const code = await createMain({
      argv: ['my-tool', '--auth', 'magic', '--yes'],
      cwd: tempDir(),
      stderr: (s) => errors.push(s),
      prompter: nonInteractivePrompter(),
    });

    expect(code).toBe(2);
    expect(errors.join('')).toContain('--auth');
  });

  it('honours flags over prompts', async () => {
    const cwd = tempDir();
    await createMain({
      argv: ['my-tool', '--command', 'publish', '--no-spends', '--auth', 'self-host', '--yes'],
      cwd,
      stderr: () => {},
      prompter: nonInteractivePrompter(),
    });

    const source = readFileSync(join(cwd, 'my-tool', 'src', 'tool.ts'), 'utf8');
    expect(source).toContain('"publish"');
    expect(source).not.toContain('checkpoint(ctx');
    expect(source).toContain('127.0.0.1:8787');
  });
});

describe('the self-host scaffold ships a working server', () => {
  // Telling someone to "start a server that mounts @invokable/server" and
  // handing them nothing is where the self-host path used to break: the CLI
  // half was scaffolded and the other half was a sentence.
  it('includes server.mjs only for self-host', () => {
    const selfHost = scaffold({ ...base, auth: 'self-host' }).map((f) => f.path);
    const hosted = scaffold({ ...base, auth: 'hosted' }).map((f) => f.path);

    expect(selfHost).toContain('server.mjs');
    expect(hosted).not.toContain('server.mjs');
  });

  it('depends on @invokable/server only when it ships one', () => {
    const deps = (spec: ScaffoldSpec) =>
      JSON.parse(fileMap(spec).get('package.json')!).dependencies;

    expect(deps({ ...base, auth: 'self-host' })).toHaveProperty('@invokable/server');
    expect(deps({ ...base, auth: 'hosted' })).not.toHaveProperty('@invokable/server');
  });

  it('adds an `npm run server` script for self-host', () => {
    const scripts = (spec: ScaffoldSpec) =>
      JSON.parse(fileMap(spec).get('package.json')!).scripts;

    expect(scripts({ ...base, auth: 'self-host' }).server).toBe('node server.mjs');
    expect(scripts({ ...base, auth: 'hosted' })).not.toHaveProperty('server');
  });

  it('guards the spending endpoint but not the planning one', () => {
    // Guarding the plan call too would mean the CLI could never fetch a plan to
    // show the user, and the gate could never open.
    const server = fileMap({ ...base, auth: 'self-host', spends: true }).get('server.mjs')!;
    expect(server).toContain("requiresApproval: (request) => new URL(request.url).pathname === '/v1/deploy'");
    expect(server).toContain('/v1/deploy/plan');
  });

  it('omits the checkpoint wiring when the command does not spend', () => {
    const server = fileMap({ ...base, auth: 'self-host', spends: false }).get('server.mjs')!;
    expect(server).not.toContain('verifyCheckpoint(');
  });

  it('marks every hook that must be replaced before production', () => {
    const server = fileMap({ ...base, auth: 'self-host' }).get('server.mjs')!;
    expect(server).toContain('THE HOOK YOU MUST REPLACE');
    expect(server).toContain('Development only');
    expect(server).toContain('CHECKPOINT_SECRET');
  });

  it('tells the reader in the README what to change', () => {
    const readme = fileMap({ ...base, auth: 'self-host' }).get('README.md')!;
    expect(readme).toContain('npm run server');
    expect(readme).toContain('Before this is production');
    expect(readme).toContain('requireSession');
    expect(readme).toContain('postgresAuthStore');
  });

  it('ships the server executable', () => {
    const file = scaffold({ ...base, auth: 'self-host' }).find((f) => f.path === 'server.mjs');
    expect(file?.executable).toBe(true);
  });
});
