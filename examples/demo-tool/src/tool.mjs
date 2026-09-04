import { command, defineTool, InvokableError } from '@invokable/core';

/**
 * The smallest tool that exercises the whole contract: a success path, a
 * reserved-code failure with remediation, and a tool-defined code. No network
 * and no auth yet — those arrive with the auth client.
 */
export default defineTool({
  name: 'demo-tool',
  version: '0.1.0',
  description: 'Example invokable tool used to smoke-test the runtime.',

  commands: {
    greet: command({
      description: 'Greet someone by name.',
      options: {
        name: { type: 'string', required: true, description: 'Who to greet.', short: 'n' },
        loud: { type: 'boolean', description: 'Shout the greeting.' },
      },
      run: ({ opts, ctx }) => {
        ctx.io.note(`greeting ${opts.name}…`);
        const text = opts.loud ? `HELLO, ${opts.name.toUpperCase()}!` : `Hello, ${opts.name}.`;
        return { text };
      },
    }),

    'find-project': command({
      description: 'Look up a project by slug.',
      positionals: ['slug'],
      run: ({ ctx }) => {
        const slug = ctx.positionals[0];
        if (!slug) {
          throw new InvokableError({
            code: 'usage',
            message: 'A project slug is required.',
            remediation: 'demo-tool find-project my-project',
          });
        }
        if (slug !== 'demo') {
          throw new InvokableError({
            code: 'not_found',
            message: `No project named "${slug}".`,
            remediation: 'demo-tool find-project demo',
          });
        }
        return { slug, status: 'active' };
      },
    }),

    'check-quota': command({
      description: 'Fail with a tool-defined exit code.',
      run: () => {
        throw new InvokableError({
          code: 'quota_exhausted',
          message: 'This demo always reports the quota as used up.',
          remediation: 'demo-tool greet --name world',
          exitCode: 42,
        });
      },
    }),
  },
});
