#!/usr/bin/env node
/**
 * Drives the example server with the example CLI so the whole exchange is
 * visible: login, an approval gate, and the deploy that the approval unlocks.
 *
 *   node examples/server/server.mjs        # terminal 1
 *   node examples/server/demo.mjs          # terminal 2
 *
 * Every command shown is one a person or an agent would really run. The only
 * thing faked is the browser click, which this script performs by POSTing to
 * the approve endpoint the way the approval page's form would.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SERVER = process.env.SERVER ?? 'http://127.0.0.1:8787';
const CLI = fileURLToPath(new URL('../demo-tool/bin/demo-tool.mjs', import.meta.url));
const configDir = mkdtempSync(join(tmpdir(), 'invokable-demo-'));

const env = { ...process.env, DEMO_TOOL_API: SERVER, DEMO_TOOL_CONFIG_DIR: configDir };

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function step(title) {
  console.log(`\n${bold(`── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`)}`);
}

async function run(args, { expectFailure = false } = {}) {
  console.log(dim(`\n$ demo-tool ${args.join(' ')}`));
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { env });
    if (stderr.trim()) console.log(dim(stderr.trimEnd()));
    if (stdout.trim()) console.log(stdout.trimEnd());
    return { code: 0, stdout };
  } catch (e) {
    if (e.stderr?.trim()) console.log(dim(e.stderr.trimEnd()));
    if (e.stdout?.trim()) console.log(e.stdout.trimEnd());
    console.log(dim(`  exit ${e.code}`));
    if (!expectFailure) throw e;
    return { code: e.code, stdout: e.stdout ?? '' };
  }
}

async function serverIsUp() {
  try {
    await fetch(`${SERVER}/v1/state`);
    return true;
  } catch {
    return false;
  }
}

try {
  if (!(await serverIsUp())) {
    console.error(`No server at ${SERVER}. Start it first:\n\n  node examples/server/server.mjs\n`);
    process.exit(1);
  }

  step('1. Before signing in');
  console.log(dim('  doctor tells an agent whether the problem is auth or the network.'));
  await run(['doctor', '--json']);

  step('2. Sign in');
  console.log(dim('  login prints a code and waits. The browser click is faked below.'));
  console.log(dim(`\n$ demo-tool login`));

  // Read the code off the CLI's stderr as it prints, exactly as a person reads
  // it off their screen. Awaiting the process instead would deadlock: it does
  // not exit until the code has been approved.
  const approved = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'login', '--json'], { env });
    let out = '';
    let err = '';
    let sent = false;

    child.stdout.on('data', (c) => {
      out += c;
    });
    child.stderr.on('data', (c) => {
      const text = String(c);
      err += text;
      process.stdout.write(dim(text));

      const code = /[A-Z0-9]{4}-[A-Z0-9]{4}/.exec(err)?.[0];
      if (code && !sent) {
        sent = true;
        // What the approval page's form does when the user clicks Approve.
        fetch(`${SERVER}/device/approve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ userCode: code, decision: 'approve' }),
        }).catch(reject);
      }
    });

    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`login exited ${code}\n${err}`)),
    );
  });

  console.log(approved.trim());

  step('3. Who am I?');
  await run(['whoami', '--json']);

  step('4. Try to deploy — the gate stops it');
  console.log(dim('  Exit 10. Nothing was deployed. `display` is what the user must see.'));
  const gate = await run(['deploy', '--env', 'prod', '--json'], { expectFailure: true });

  const envelope = JSON.parse(gate.stdout);
  console.log(`\n${envelope.display}`);

  step('5. Approve, and only now does it deploy');
  console.log(dim('  next.approve is a complete command; run it verbatim.'));
  const approveArgs = envelope.next.approve.split(' ').slice(1);
  await run(approveArgs);

  step('6. The same approval cannot be used twice');
  console.log(dim('  Exit 12. One approval, one deploy — a replay is refused.'));
  await run(approveArgs, { expectFailure: true });

  step('7. Server state');
  const state = await (await fetch(`${SERVER}/v1/state`)).json();
  console.log(`  deploys: ${JSON.stringify(state.deploys)}   balance: ${state.balance}`);
  console.log(dim('\n  One deploy, not two. That is the gate doing its job.'));

  // -------------------------------------------------------------------------
  // The harder billing case: a price nobody knows until the work is done.
  // -------------------------------------------------------------------------

  step('8. What can I afford?');
  console.log(dim('  Read-only and free, so an agent can check before it plans.'));
  await run(['balance', '--json']);

  step('9. Summarise — the quote is a CEILING, not a guess');
  console.log(dim('  Cost depends on tokens in and out, and neither is known yet.'));
  const doc = join(configDir, 'report.txt');
  writeFileSync(doc, 'Quarterly figures and the commentary around them. '.repeat(1600));
  const meterGate = await run(['summarize', '--file', doc, '--json'], { expectFailure: true });
  const meterEnvelope = JSON.parse(meterGate.stdout);
  console.log(`\n${meterEnvelope.display}`);

  step('10. Approve — and the charge lands under the quote');
  await run(meterEnvelope.next.approve.split(' ').slice(1));
  console.log(
    dim('\n  Charged less than quoted, because the model wrote less than the ceiling.'),
  );

  step('11. The ledger explains itself');
  console.log(dim('  estimated vs charged, per transaction. "Why that number?" has an answer.'));
  await run(['balance', '--json']);
  console.log(dim('\n  Two shapes of billing, one gate.\n'));
} finally {
  rmSync(configDir, { recursive: true, force: true });
}
