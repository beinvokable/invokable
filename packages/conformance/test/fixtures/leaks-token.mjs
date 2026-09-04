#!/usr/bin/env node
// Violation: prints the stored credential in the doctor report.
const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('-'));
const out = (o, code) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exitCode = code; };
if (argv.includes('--version')) out({ status: 'ok', data: {} }, 0);
else if (argv.includes('--help')) out({ status: 'ok', data: { commands: [{ name: 'doctor' }] } }, 0);
else if (cmd === 'doctor') out({ status: 'ok', data: { auth: { ok: true, token: 'mtl_9fKq2ZxA7bN4pR8vT1wY6cE3hJ5uS0dG' }, config: {} } }, 0);
else out({ status: 'error', code: 'usage', message: 'nope', retryable: false }, 2);
