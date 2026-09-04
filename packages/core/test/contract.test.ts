import { describe, expect, it } from 'vitest';
import { defineTool, command } from '../src/schema.js';
import { EXIT } from '../src/exit-codes.js';
import { InvokableError } from '../src/errors.js';
import { invoke } from './helpers.js';

const tool = defineTool({
  name: 'demo',
  version: '1.2.3',
  description: 'A tool used to pin down the output contract.',
  commands: {
    greet: command({
      description: 'Greet someone.',
      options: {
        name: { type: 'string', required: true, description: 'Who to greet.' },
        loud: { type: 'boolean', description: 'Shout it.' },
        times: { type: 'number', default: 1, description: 'Repeat count.' },
      },
      run: ({ opts }) => {
        const text = opts.loud ? `HELLO ${opts.name.toUpperCase()}` : `hello ${opts.name}`;
        return { text, times: opts.times };
      },
    }),
    'pick-env': command({
      description: 'Exercise choice validation.',
      options: { env: { type: 'string', required: true, choices: ['staging', 'prod'] } },
      run: ({ opts }) => ({ env: opts.env }),
    }),
    noisy: command({
      description: 'Writes to stdout directly, which must not corrupt the envelope.',
      run: () => {
        console.log('a stray log line');
        process.stdout.write('raw bytes on stdout\n');
        return { ok: true };
      },
    }),
    boom: command({
      description: 'Fails with a reserved code.',
      run: () => {
        throw new InvokableError({
          code: 'not_found',
          message: 'No such project.',
          remediation: 'demo list-projects',
        });
      },
    }),
    'boom-custom': command({
      description: 'Fails with a tool-defined code.',
      run: () => {
        throw new InvokableError({
          code: 'quota_exhausted',
          message: 'Monthly quota used up.',
          exitCode: 42,
          retryable: false,
        });
      },
    }),
    'boom-unexpected': command({
      description: 'Throws a plain Error.',
      run: () => {
        throw new Error('something unplanned');
      },
    }),
  },
});

describe('stdout is exactly one JSON document', () => {
  it('emits a single ok envelope', async () => {
    const r = await invoke(tool, ['greet', '--name', 'ada', '--json']);
    expect(r.json()).toEqual({ status: 'ok', data: { text: 'hello ada', times: 1 } });
    expect(r.exitCode).toBe(EXIT.ok);
  });

  // `console.log` is not asserted here: vitest installs its own console
  // interception, so it never reaches `process.stdout.write` in-process. Both
  // paths are covered end-to-end in stdout-purity.test.ts, which spawns a real
  // process — the only setting where the guarantee is meaningful.
  it('keeps stray stdout writes out of the document', async () => {
    const r = await invoke(tool, ['noisy', '--json']);
    expect(r.json()).toEqual({ status: 'ok', data: { ok: true } });
    expect(r.stderr).toContain('raw bytes on stdout');
  });

  it('writes nothing to stdout without --json', async () => {
    const r = await invoke(tool, ['greet', '--name', 'ada']);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('hello ada');
  });
});

describe('error envelopes and exit codes', () => {
  it('maps a reserved code to its exit code and carries remediation', async () => {
    const r = await invoke(tool, ['boom', '--json']);
    expect(r.json()).toEqual({
      status: 'error',
      code: 'not_found',
      message: 'No such project.',
      remediation: 'demo list-projects',
      retryable: false,
    });
    expect(r.exitCode).toBe(EXIT.not_found);
  });

  it('supports tool-defined codes in 30-99', async () => {
    const r = await invoke(tool, ['boom-custom', '--json']);
    expect(r.exitCode).toBe(42);
    expect(r.json()).toMatchObject({ status: 'error', code: 'quota_exhausted' });
  });

  it('turns an unexpected throw into exit 1 without leaking a stack to stdout', async () => {
    const r = await invoke(tool, ['boom-unexpected', '--json']);
    expect(r.exitCode).toBe(EXIT.error);
    const env = r.json() as { status: string; code: string; message: string };
    expect(env.status).toBe('error');
    expect(env.code).toBe('error');
    expect(JSON.stringify(env)).not.toContain('at ');
  });

  it('rejects an unknown command with exit 2', async () => {
    const r = await invoke(tool, ['nope', '--json']);
    expect(r.exitCode).toBe(EXIT.usage);
    expect(r.json()).toMatchObject({ status: 'error', code: 'usage' });
  });

  it('rejects an unknown option rather than ignoring it', async () => {
    const r = await invoke(tool, ['greet', '--name', 'ada', '--colour', 'red', '--json']);
    expect(r.exitCode).toBe(EXIT.usage);
    expect((r.json() as { message: string }).message).toContain('--colour');
  });

  it('reports a missing required option', async () => {
    const r = await invoke(tool, ['greet', '--json']);
    expect(r.exitCode).toBe(EXIT.usage);
    expect((r.json() as { message: string }).message).toContain('--name');
  });

  it('enforces choices', async () => {
    const r = await invoke(tool, ['pick-env', '--env', 'dev', '--json']);
    expect(r.exitCode).toBe(EXIT.usage);
    expect((r.json() as { message: string }).message).toContain('staging, prod');
  });

  it('exits 2 on a bare invocation so an agent does not read it as success', async () => {
    const r = await invoke(tool, ['--json']);
    expect(r.exitCode).toBe(EXIT.usage);
  });
});

describe('option parsing', () => {
  it('accepts --key=value', async () => {
    const r = await invoke(tool, ['greet', '--name=ada', '--json']);
    expect(r.json()).toMatchObject({ data: { text: 'hello ada' } });
  });

  it('accepts boolean flags and --no- negation', async () => {
    const loud = await invoke(tool, ['greet', '--name', 'ada', '--loud', '--json']);
    expect(loud.json()).toMatchObject({ data: { text: 'HELLO ADA' } });
    const quiet = await invoke(tool, ['greet', '--name', 'ada', '--no-loud', '--json']);
    expect(quiet.json()).toMatchObject({ data: { text: 'hello ada' } });
  });

  it('coerces numbers and applies defaults', async () => {
    const r = await invoke(tool, ['greet', '--name', 'ada', '--times', '3', '--json']);
    expect(r.json()).toMatchObject({ data: { times: 3 } });
  });

  it('rejects a non-numeric number option', async () => {
    const r = await invoke(tool, ['greet', '--name', 'ada', '--times', 'many', '--json']);
    expect(r.exitCode).toBe(EXIT.usage);
  });
});

describe('built-ins', () => {
  it('--version reports the tool version', async () => {
    const r = await invoke(tool, ['--version', '--json']);
    expect(r.json()).toEqual({ status: 'ok', data: { name: 'demo', version: '1.2.3' } });
  });

  it('--help --json returns a machine-readable manifest', async () => {
    const r = await invoke(tool, ['--help', '--json']);
    const env = r.json() as { data: { commands: Array<{ name: string }>; exitCodes: unknown[] } };
    expect(env.data.commands.map((c) => c.name)).toContain('greet');
    expect(env.data.exitCodes.length).toBeGreaterThan(10);
    expect(r.exitCode).toBe(EXIT.ok);
  });

  it('warns on stderr when --token is used', async () => {
    const r = await invoke(tool, ['greet', '--name', 'ada', '--token', 'secret', '--json']);
    expect(r.stderr).toContain('ps');
    expect(r.stdout).not.toContain('secret');
  });
});
