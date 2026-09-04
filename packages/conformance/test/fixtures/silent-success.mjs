#!/usr/bin/env node
// Violations: an unknown command and a bare invocation both exit 0.
const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('-'));
const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exitCode = 0; };
if (argv.includes('--version')) out({ status: 'ok', data: {} });
else if (argv.includes('--help')) out({ status: 'ok', data: { commands: [{ name: 'doctor' }] } });
else if (cmd === 'doctor') out({ status: 'ok', data: { auth: {}, config: {} } });
else out({ status: 'ok', data: {} });
