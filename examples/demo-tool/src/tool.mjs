import { checkpoint, command, defineTool, InvokableError } from '@invokable/core';
import { initCommand } from '@invokable/skills';

/**
 * The smallest tool that exercises the whole contract: a success path, a
 * reserved-code failure with remediation, and a tool-defined code. No network
 * and no auth yet — those arrive with the auth client.
 */
export default defineTool({
  name: 'demo-tool',
  version: '0.1.0',
  description: 'Example invokable tool used to smoke-test the runtime.',

  // Overridable so the example can be pointed at a local auth server while
  // developing. A real tool would hard-code its own URLs here.
  api: {
    baseUrl: process.env.DEMO_TOOL_API ?? 'https://api.demo-tool.invalid',
    authUrl: process.env.DEMO_TOOL_API ?? 'https://auth.demo-tool.invalid',
  },
  configDir: process.env.DEMO_TOOL_CONFIG_DIR ?? '~/.demo-tool',

  commands: {
    init: initCommand(),

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

    deploy: command({
      description: 'Deploy the current project. Stops for approval before spending.',
      options: {
        env: { type: 'string', required: true, choices: ['staging', 'prod'] },
      },
      spends: true,
      run: async ({ opts, client, ctx }) => {
        const plan = await client.post('/v1/deploy/plan', { env: opts.env });

        await checkpoint(ctx, {
          gate: 'deploy_review',
          title: 'deployment plan',
          summary: { env: opts.env, replicas: plan.replicas, image: plan.image },
          subject: plan.serviceId,
          question: `Deploy to ${opts.env}?`,
          explain: 'Approving starts the deploy and bills 1 credit per minute.',
          spend: { estimated: plan.credits, balance: plan.balance },
          reject: `demo-tool deploy --env ${opts.env} --dry-run`,
        });

        return client.post('/v1/deploy', { env: opts.env, planId: plan.id });
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
