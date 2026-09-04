import { EXIT, EXIT_DESCRIPTION, type ExitName, type ToolManifest } from '@invokable/core';
import { emptyCustomBlock } from './markers.js';
import { DESCRIPTION_MAX, validateDescription, validateSkillName, type ValidationIssue } from './spec.js';

export interface RenderOptions {
  manifest: ToolManifest;
  /** Overrides the generated `description` frontmatter. */
  description?: string;
  license?: string;
  /** Extra trigger phrases folded into the description. */
  triggers?: readonly string[];
  /** Defaults to `Bash, Read`. */
  allowedTools?: readonly string[];
}

export interface RenderedFile {
  /** Path relative to the skill directory. */
  path: string;
  content: string;
}

export interface RenderedSkill {
  name: string;
  files: RenderedFile[];
  issues: ValidationIssue[];
}

function yamlString(value: string): string {
  // Quote whenever YAML would otherwise misread the value.
  if (/^[\w][\w .,'()/-]*$/.test(value) && !/:\s/.test(value)) return value;
  return JSON.stringify(value);
}

function table(headers: string[], rows: string[][]): string {
  const lines = [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`];
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}

function commandSignature(tool: string, cmd: ToolManifest['commands'][number]): string {
  const parts = [tool, cmd.name];
  for (const p of cmd.positionals) parts.push(`<${p}>`);
  for (const opt of cmd.options) {
    if (!opt.required) continue;
    parts.push(opt.type === 'boolean' ? `--${opt.name}` : `--${opt.name} <${opt.type}>`);
  }
  return parts.join(' ');
}

/**
 * Builds the `description`, which is the single most important line: it is what
 * every agent reads to decide whether to load the skill at all. Leads with the
 * capability, then the trigger phrases, then the auth precondition.
 */
export function buildDescription(opts: RenderOptions): string {
  if (opts.description) return opts.description;

  const { manifest } = opts;
  const verbs = manifest.commands
    .filter((c) => !['login', 'logout', 'whoami', 'doctor'].includes(c.name))
    .map((c) => c.name)
    .slice(0, 8);

  const base =
    manifest.description ??
    `Run ${manifest.name} commands from the CLI.`;

  const triggerText = opts.triggers?.length
    ? opts.triggers.join(', ')
    : verbs.join(', ');

  const parts = [
    base.replace(/\s+$/, ''),
    triggerText ? `Use when the user asks to: ${triggerText}.` : '',
    `Always pass --json and read the exit code. Requires \`${manifest.name} login\` first.`,
  ].filter(Boolean);

  const joined = parts.join(' ');
  return joined.length > DESCRIPTION_MAX ? joined.slice(0, DESCRIPTION_MAX - 1) + '…' : joined;
}

function renderFrontmatter(opts: RenderOptions, description: string): string {
  const { manifest } = opts;
  const allowed = (opts.allowedTools ?? ['Bash', 'Read']).join(', ');

  const lines = [
    '---',
    `name: ${manifest.name}`,
    `description: ${yamlString(description)}`,
    `allowed-tools: ${allowed}`,
  ];
  if (opts.license) lines.push(`license: ${yamlString(opts.license)}`);
  lines.push(
    'metadata:',
    `  tool-version: ${yamlString(manifest.version)}`,
    '  generated-by: "@invokable/skills"',
  );
  lines.push('---');
  return lines.join('\n');
}

function renderCommandsSection(manifest: ToolManifest): string {
  const rows = manifest.commands.map((c) => [
    `\`${commandSignature(manifest.name, c)}\``,
    c.description.replace(/\|/g, '\\|') + (c.spends ? ' **(spends money)**' : ''),
  ]);
  return table(['Command', 'What it does'], rows);
}

function renderExitCodesSection(manifest: ToolManifest): string {
  const rows = manifest.exitCodes.map((e) => [
    String(e.code),
    `\`${e.name}\``,
    e.description.replace(/\|/g, '\\|'),
  ]);
  return table(['Exit', 'Name', 'What to do'], rows);
}

/** The main SKILL.md, using only the six spec-portable frontmatter fields. */
export function renderSkillMd(opts: RenderOptions): { content: string; issues: ValidationIssue[] } {
  const { manifest } = opts;
  const description = buildDescription(opts);
  const issues = [...validateSkillName(manifest.name), ...validateDescription(description)];

  const spending = manifest.commands.filter((c) => c.spends);

  const body = `
# ${manifest.name}

${manifest.description ?? `The \`${manifest.name}\` command-line tool.`}

Every command returns **one JSON document on stdout** when given \`--json\`, and a
**semantic exit code**. Read both. Progress and warnings go to stderr and are not
part of the result.

## Check auth before the first command

\`\`\`bash
${manifest.name} doctor --json
\`\`\`

Read \`.data.auth.ok\`:

- \`true\` — proceed.
- \`false\` — tell the user to run \`${manifest.name} login\` themselves. **Do not run it
  for them**: it opens a browser and waits for a human to approve a code. Running it
  will hang.

If \`.data.api.reachable\` is \`false\`, the network or the service is down. Say so;
do not retry in a loop.

## Reading a result

\`\`\`bash
${manifest.name} <command> --json
\`\`\`

| stdout \`status\` | Meaning | What to do |
|---|---|---|
| \`ok\` | Succeeded | Use \`.data\`. |
| \`error\` | Failed | Read \`.message\`. If \`.remediation\` is present it is the exact next command. Honour \`.retryable\`: when \`false\`, do not retry. |
| \`checkpoint\` | Waiting for approval | Show \`.display\` to the user verbatim and stop. See below. |

## Commands

${renderCommandsSection(manifest)}

## Exit codes

${renderExitCodesSection(manifest)}

${
  spending.length
    ? `## Approval gates

${spending.map((c) => `\`${manifest.name} ${c.name}\``).join(', ')} can spend the user's money.
${
  spending.length === 1 ? 'It stops' : 'They stop'
} before doing so and ${spending.length === 1 ? 'exits' : 'exit'} **10** with \`"status": "checkpoint"\`.

When that happens:

1. Print \`.display\` to the user **exactly as given**. It is a pre-rendered panel
   showing the plan and the cost. Do not summarise, shorten or paraphrase it —
   the user is deciding whether to pay, and they must see the real numbers.
2. Ask whether to proceed.
3. Only if they agree, run \`.next.approve\` verbatim. It is a complete command.
4. If they decline, run \`.next.reject\` when present, and otherwise stop.

Exit **12** (\`checkpoint_stale\`) means the approval no longer matches reality —
it was already used, it expired, or the plan changed. Re-run the original command
without \`--approve\` to get a fresh plan, and ask the user again.

See \`references/checkpoints.md\`.
`
    : ''
}
## Never

- **Never pass \`--yes\`.** It approves spending without asking the user. The gate
  exists because the cost is theirs, not yours.
- **Never pass \`--token\` on the command line.** It is visible to every process on
  the machine via \`ps\`. Authentication comes from \`${manifest.name} login\`.
- **Never retry on exit 7** (\`rate_limited\`). Retrying makes it worse. Report it.
- **Never retry on exit 4** (\`insufficient_spend\`) or **20** (\`declined\`). Neither
  will succeed on a second attempt, and 20 means the user said no.
- **Never parse stderr** for results. It carries progress text whose wording changes.
- **Never invent a command.** Run \`${manifest.name} --help --json\` for the exact
  schema of every command and option.

${emptyCustomBlock('Add project-specific guidance here. It survives regeneration.')}

## Reference

- \`references/commands.md\` — every option of every command
- \`references/errors.md\` — every exit code and the correct response
${spending.length ? '- `references/checkpoints.md` — the approval flow in detail\n' : ''}`.trimStart();

  return { content: `${renderFrontmatter(opts, description)}\n\n${body}`, issues };
}

export function renderCommandsReference(manifest: ToolManifest): string {
  const sections = manifest.commands.map((cmd) => {
    const lines = [`## \`${manifest.name} ${cmd.name}\``, '', cmd.description, ''];
    if (cmd.spends) {
      lines.push('**Spends money.** Stops at an approval gate and exits 10.', '');
    }
    lines.push('```bash', commandSignature(manifest.name, cmd) + ' --json', '```', '');

    if (cmd.positionals.length) {
      lines.push(
        table(
          ['Positional', 'Required'],
          cmd.positionals.map((p) => [`\`<${p}>\``, 'yes']),
        ),
        '',
      );
    }

    if (cmd.options.length) {
      lines.push(
        table(
          ['Option', 'Type', 'Required', 'Values', 'Description'],
          cmd.options.map((o) => [
            `\`--${o.name}\`` + (o.short ? ` / \`-${o.short}\`` : ''),
            o.type,
            o.required ? 'yes' : 'no',
            o.choices ? o.choices.map((c) => `\`${c}\``).join(', ') : o.default !== undefined ? `default \`${String(o.default)}\`` : '—',
            (o.description ?? '').replace(/\|/g, '\\|'),
          ]),
        ),
        '',
      );
    } else if (!cmd.positionals.length) {
      lines.push('Takes no options.', '');
    }
    return lines.join('\n');
  });

  return `# ${manifest.name} — command reference

Generated from the tool schema; do not edit by hand.

${sections.join('\n')}`;
}

export function renderErrorsReference(manifest: ToolManifest): string {
  const custom = manifest.commands.flatMap((c) =>
    Object.entries(c.exitCodes ?? {}).map(([code, desc]) => [c.name, code, desc] as const),
  );

  return `# ${manifest.name} — errors and exit codes

Every failure is one JSON document on stdout plus an exit code:

\`\`\`json
{"status":"error","code":"not_found","message":"…","remediation":"…","retryable":false}
\`\`\`

- \`remediation\`, when present, is the **exact command to run next**. Prefer it over
  guessing.
- \`retryable: false\` means a retry cannot succeed. Do not loop.

## Reserved exit codes

${table(
  ['Exit', 'Name', 'Retry?', 'What to do'],
  manifest.exitCodes.map((e) => [
    String(e.code),
    `\`${e.name}\``,
    ['timeout', 'network'].includes(e.name) ? 'once' : 'no',
    e.description.replace(/\|/g, '\\|'),
  ]),
)}

${
  custom.length
    ? `## Tool-specific exit codes

${table(['Command', 'Exit', 'Meaning'], custom.map(([cmd, code, desc]) => [`\`${cmd}\``, code, String(desc)]))}
`
    : ''
}
## Codes that mean "stop", not "try again"

- **${EXIT.rate_limited} (\`rate_limited\`)** — ${EXIT_DESCRIPTION['rate_limited' as ExitName]}
- **${EXIT.insufficient_spend} (\`insufficient_spend\`)** — the user is out of balance. Only they can fix it.
- **${EXIT.declined} (\`declined\`)** — the user said no. Do not ask again in the same turn.
- **${EXIT.auth} (\`auth\`)** — run the \`remediation\`, which is \`${manifest.name} login\`, by telling the **user** to run it.
`;
}

export function renderCheckpointsReference(manifest: ToolManifest): string {
  const spending = manifest.commands.filter((c) => c.spends);
  const example = spending[0]?.name ?? 'deploy';

  return `# ${manifest.name} — approval gates

Commands that spend money stop first and ask. This is not an error.

## What you receive

\`\`\`json
{
  "status": "checkpoint",
  "schema": "invokable.checkpoint/v1",
  "gate": "deploy_review",
  "fingerprint": "GCI3HOREK4LY34J7",
  "display": "┌───────────…┐\\n│ …the panel… │\\n└───────────┘",
  "question": "Deploy this plan to production?",
  "explain": "Approving starts the deploy and bills 1 credit per minute.",
  "spend": { "estimated": 12, "balance": 100 },
  "next": {
    "approve": "${manifest.name} ${example} --env prod --json --approve deploy_review@GCI3HOREK4LY34J7",
    "reject": "${manifest.name} ${example} --env prod --dry-run"
  }
}
\`\`\`

Exit code: **10**.

## What to do

1. **Print \`display\` verbatim.** It is already formatted for a human and contains
   the real cost. Paraphrasing it is how a user ends up agreeing to a number they
   never saw.
2. **Ask the user.** Quote \`question\`, and \`explain\` if present.
3. **On yes:** run \`next.approve\` exactly as given. It is the original command with
   the approval appended, so it needs no editing.
4. **On no:** run \`next.reject\` if present; otherwise stop and say nothing was done.

## Why you cannot skip this

The fingerprint is issued by the server, not computed locally. It is bound to the
gate, the target, and the exact plan you were shown; it expires; and it is consumed
once, by the action it authorises.

So an approval cannot be reused, and one issued against a plan that has since
changed is rejected with exit **12** (\`checkpoint_stale\`). On 12: re-run the
original command **without** \`--approve\`, show the user the new plan, and ask again.

## \`--yes\`

\`--yes\` skips the question. **Do not pass it.** The server still records an
approval, so the audit trail will show that the spend was approved without a human
being asked — which is exactly the thing the user will object to afterwards.

If the user explicitly instructs you to run without prompting, prefer
\`--max-spend <n>\`, which refuses to auto-approve anything above the cap.
`;
}

/** Renders the complete portable skill bundle. */
export function renderSkill(opts: RenderOptions): RenderedSkill {
  const { content, issues } = renderSkillMd(opts);
  const files: RenderedFile[] = [
    { path: 'SKILL.md', content },
    { path: 'references/commands.md', content: renderCommandsReference(opts.manifest) },
    { path: 'references/errors.md', content: renderErrorsReference(opts.manifest) },
  ];
  if (opts.manifest.commands.some((c) => c.spends)) {
    files.push({
      path: 'references/checkpoints.md',
      content: renderCheckpointsReference(opts.manifest),
    });
  }
  return { name: opts.manifest.name, files, issues };
}
