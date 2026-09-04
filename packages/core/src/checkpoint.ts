import { createInterface } from 'node:readline/promises';
import { CHECKPOINT_SCHEMA, type CheckpointChoice, type CheckpointEnvelope, type SpendInfo } from './envelope.js';
import { InvokableError } from './errors.js';
import { summaryHash } from './canonical.js';
import { isInteractive } from './agent.js';
import type { CommandContext } from './schema.js';

export interface CheckpointOptions {
  /** Stable identifier for this gate, e.g. `deploy_review`. */
  gate: string;
  /** Short human title for the panel. */
  title: string;
  /** The plan being approved. Hashed into the fingerprint. */
  summary: unknown;
  /** What the user is being asked. */
  question: string;
  /** Consequences of approving — cost, irreversibility. */
  explain?: string;
  spend?: SpendInfo;
  choices?: CheckpointChoice[];
  /**
   * Identifies WHAT is being approved, beyond the gate name — a deployment id,
   * a video id. Two concurrent approvals of the same gate for different
   * subjects must not be interchangeable.
   */
  subject?: string;
  /** The command to run instead of approving. */
  reject?: string;
  /** The command that approves. `gate@<fp>` is appended automatically. */
  approveCommand?: string;
}

export interface CheckpointResult {
  approved: true;
  /** How approval was obtained, for the caller to log if it wants. */
  via: 'approve-flag' | 'yes-flag' | 'prompt';
  fingerprint: string;
}

interface IssueResponse {
  fingerprint: string;
  expiresAt?: string | number;
}

/**
 * Thrown to unwind out of a command when the gate is pending. `runTool` catches
 * it and emits the checkpoint envelope with exit 10 — a command body should not
 * have to know how to terminate the process.
 */
export class CheckpointPending extends Error {
  readonly envelope: CheckpointEnvelope;
  constructor(envelope: CheckpointEnvelope) {
    super(`Checkpoint "${envelope.gate}" is awaiting approval.`);
    this.name = 'CheckpointPending';
    this.envelope = envelope;
  }
}

const BOX_WIDTH = 68;

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.trim() === '') {
      out.push('');
      continue;
    }
    // Leading whitespace is meaningful: the summary is usually pretty-printed
    // JSON, and collapsing its indentation makes the plan harder to read at
    // exactly the moment the user is deciding whether to pay for it.
    const indent = paragraph.slice(0, paragraph.length - paragraph.trimStart().length);
    if (paragraph.length <= width) {
      out.push(paragraph);
      continue;
    }
    let line = indent;
    for (const word of paragraph.trimStart().split(/\s+/)) {
      if (line === indent) line += word;
      else if ((line + ' ' + word).length <= width) line += ' ' + word;
      else {
        out.push(line);
        line = indent + word;
      }
    }
    if (line.trim()) out.push(line);
  }
  return out;
}

/**
 * Renders the panel a human reads before approving. It is built here rather
 * than left to the agent so that the user sees the same thing regardless of
 * which agent is relaying it — an agent paraphrasing a spend prompt is exactly
 * the failure this gate exists to prevent.
 */
export function renderCheckpointPanel(input: {
  title: string;
  summary: unknown;
  question: string;
  explain?: string | undefined;
  spend?: SpendInfo | undefined;
  choices?: CheckpointChoice[] | undefined;
}): string {
  const inner = BOX_WIDTH - 4;
  const lines: string[] = [];
  const push = (s = ''): void => {
    lines.push(`│ ${s.padEnd(inner)} │`);
  };

  lines.push('┌' + '─'.repeat(BOX_WIDTH - 2) + '┐');
  push(input.title.toUpperCase());
  lines.push('├' + '─'.repeat(BOX_WIDTH - 2) + '┤');

  const body =
    typeof input.summary === 'string'
      ? input.summary
      : JSON.stringify(input.summary, null, 2);
  for (const line of wrap(body, inner)) push(line);

  if (input.spend) {
    push();
    const currency = input.spend.currency ?? 'credits';
    push(`Cost: ${input.spend.estimated} ${currency}`);
    if (input.spend.balance !== undefined) {
      push(`Balance after: ${input.spend.balance - input.spend.estimated} ${currency}`);
    }
  }

  if (input.choices?.length) {
    push();
    push('Options:');
    for (const c of input.choices) {
      push(`  [${c.id}] ${c.label}${c.recommended ? '  (recommended)' : ''}`);
      if (c.detail) for (const l of wrap(c.detail, inner - 6)) push(`      ${l}`);
    }
  }

  if (input.explain) {
    push();
    for (const line of wrap(input.explain, inner)) push(line);
  }

  push();
  for (const line of wrap(input.question, inner)) push(line);
  lines.push('└' + '─'.repeat(BOX_WIDTH - 2) + '┘');
  return lines.join('\n');
}

/** Quotes an argument only when a shell would otherwise mangle it. */
function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Rebuilds the invocation that produced this gate, with the approval added.
 *
 * Using just `<tool> <command>` drops the original options, so the command
 * handed to the agent fails with a usage error the moment any option is
 * required — the approve command has to actually run.
 */
function buildApproveCommand(ctx: CommandContext, gate: string, fingerprint: string): string {
  const args: string[] = [];
  const argv = ctx.argv;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    // Drop any previous --approve: this run supersedes it.
    if (token === '--approve') {
      i++;
      continue;
    }
    if (token.startsWith('--approve=')) continue;
    args.push(token);
  }
  args.push('--approve', `${gate}@${fingerprint}`);
  return [ctx.tool.name, ...args.map(shellQuote)].join(' ');
}

function parseApprovals(approvals: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of approvals) {
    const at = raw.lastIndexOf('@');
    if (at === -1) continue;
    map.set(raw.slice(0, at), raw.slice(at + 1));
  }
  return map;
}

async function promptYesNo(question: string): Promise<boolean> {
  // Reads stdin and writes the prompt to stderr, keeping stdout clean.
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * Stops before a consequential action and requires approval (spec 5.1, 5.8).
 *
 * The fingerprint is issued by the server, never computed locally, so an
 * approval cannot be minted by whoever happens to have seen the summary. It is
 * bound to (gate, subject, summary) and is consumed once, which is what makes a
 * stale or replayed approval detectable.
 */
export async function checkpoint(
  ctx: CommandContext,
  options: CheckpointOptions,
): Promise<CheckpointResult> {
  const { gate, title, summary, question } = options;
  const subject = options.subject ?? '';
  const approvals = parseApprovals(ctx.approvals);
  const supplied = approvals.get(gate);

  const client = ctx.checkpointClient;
  if (!client) {
    throw new InvokableError({
      code: 'error',
      message:
        `checkpoint("${gate}") needs an API to issue fingerprints, but ${ctx.tool.name} ` +
        'declared no `api.baseUrl`. Add one to defineTool().',
      retryable: false,
    });
  }

  // --- An approval was supplied: validate it against current state ----------
  if (supplied) {
    await client.post(
      '/checkpoints/verify',
      { gate, subject, fingerprint: supplied, summaryHash: summaryHash(summary) },
      { headers: { 'x-invokable-checkpoint': `${gate}@${supplied}` } },
    );
    // Attached so the eventual action request carries it; the server middleware
    // consumes it atomically with the action it authorises.
    ctx.attachCheckpoint(gate, supplied);
    return { approved: true, via: 'approve-flag', fingerprint: supplied };
  }

  // --- Issue a fresh fingerprint -------------------------------------------
  const issued = await client.post<IssueResponse>('/checkpoints', {
    gate,
    subject,
    summary,
    ...(options.spend !== undefined ? { spend: options.spend } : {}),
  });
  if (!issued?.fingerprint) {
    throw new InvokableError({
      code: 'error',
      message: 'The server did not return a checkpoint fingerprint.',
      retryable: false,
    });
  }
  const fingerprint = issued.fingerprint;

  const approveCommand =
    options.approveCommand !== undefined
      ? `${options.approveCommand} --approve ${gate}@${fingerprint}`
      : buildApproveCommand(ctx, gate, fingerprint);

  // --- --yes: auto-approve, but still on the server's record ---------------
  const overSpendCap =
    ctx.maxSpend !== undefined &&
    options.spend !== undefined &&
    options.spend.estimated > ctx.maxSpend;

  if (ctx.yes && !overSpendCap) {
    ctx.io.warn(
      `auto-approved ${gate}@${fingerprint} because --yes was passed. ` +
        'The server records this as an approval.',
    );
    ctx.attachCheckpoint(gate, fingerprint);
    return { approved: true, via: 'yes-flag', fingerprint };
  }

  if (ctx.yes && overSpendCap) {
    // --max-spend overrides --yes (spec 5.1). Fall through to the normal gate
    // rather than failing: the user capped spend, they did not forbid the action.
    ctx.io.warn(
      `--yes did not auto-approve ${gate}: estimated ${options.spend!.estimated} ` +
        `exceeds --max-spend ${ctx.maxSpend}.`,
    );
  }

  const display = renderCheckpointPanel({
    title,
    summary,
    question,
    explain: options.explain,
    spend: options.spend,
    choices: options.choices,
  });

  // --- Interactive human at a terminal -------------------------------------
  if (!ctx.json && isInteractive()) {
    ctx.io.note(display);
    const approved = await promptYesNo(question);
    if (!approved) {
      throw new InvokableError({
        code: 'declined',
        message: `Declined at "${gate}".`,
        ...(options.reject !== undefined ? { remediation: options.reject } : {}),
        retryable: false,
      });
    }
    ctx.attachCheckpoint(gate, fingerprint);
    return { approved: true, via: 'prompt', fingerprint };
  }

  // --- Non-interactive: hand the decision back to the agent's user ---------
  const envelope: CheckpointEnvelope = {
    status: 'checkpoint',
    schema: CHECKPOINT_SCHEMA,
    gate,
    fingerprint,
    display,
    question,
    ...(options.explain !== undefined ? { explain: options.explain } : {}),
    ...(options.spend !== undefined ? { spend: options.spend } : {}),
    ...(options.choices !== undefined ? { choices: options.choices } : {}),
    next: {
      approve: approveCommand,
      ...(options.reject !== undefined ? { reject: options.reject } : {}),
    },
  };
  throw new CheckpointPending(envelope);
}
