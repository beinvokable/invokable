#!/usr/bin/env node
// A hand-rolled CLI that honours the contract, written without @invokable/core
// so the checks are exercised against something the runtime did not produce.
const argv = process.argv.slice(2);
const json = argv.includes('--json');
const cmd = argv.find((a) => !a.startsWith('-'));
const out = (o, code) => { if (json) process.stdout.write(JSON.stringify(o) + '\n'); process.exitCode = code; };

if (argv.includes('--version')) out({ status: 'ok', data: { version: '1.0.0' } }, 0);
else if (argv.includes('--help')) out({ status: 'ok', data: { commands: [{ name: 'doctor' }] } }, 0);
else if (cmd === 'doctor') out({ status: 'ok', data: { auth: { ok: false }, config: { source: 'none' }, api: { reachable: true } } }, 0);
else if (cmd === undefined) out({ status: 'error', code: 'usage', message: 'No command.', remediation: 'x --help', retryable: false }, 2);
else out({ status: 'error', code: 'usage', message: `Unknown command "${cmd}".`, remediation: 'x --help', retryable: false }, 2);
