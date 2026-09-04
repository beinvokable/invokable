// Fixture CLI spawned as a real subprocess. Verifying stdout purity in-process
// is not possible under vitest, which installs its own console interception;
// only a real process proves the guarantee an agent actually depends on.
import { defineTool, command, cli } from '../../dist/index.js';

const tool = defineTool({
  name: 'noisy',
  version: '0.0.1',
  commands: {
    run: command({
      description: 'Emits stray output on stdout while returning a result.',
      run: () => {
        console.log('STRAY_CONSOLE_LOG');
        process.stdout.write('STRAY_RAW_WRITE\n');
        console.error('INTENTIONAL_STDERR');
        return { ok: true };
      },
    }),
    fail: command({
      description: 'Exits with a reserved code.',
      run: () => {
        throw new (class extends Error {})('unused');
      },
    }),
  },
});

await cli(tool);
