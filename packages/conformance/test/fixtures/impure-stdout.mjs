#!/usr/bin/env node
// Violation: writes a log line to stdout alongside the envelope.
const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('-'));
console.log('[info] starting up');
const out = (o, code) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exitCode = code; };
if (argv.includes('--version')) out({ status: 'ok', data: {} }, 0);
else if (argv.includes('--help')) out({ status: 'ok', data: { commands: [{ name: 'doctor' }] } }, 0);
else if (cmd === 'doctor') out({ status: 'ok', data: { auth: {}, config: {} } }, 0);
else out({ status: 'error', code: 'usage', message: 'nope', retryable: false }, 2);
