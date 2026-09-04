import type { ToolManifest } from '@invokable/core';

/**
 * Where each agent looks for instructions.
 *
 * Two kinds of target, because the ecosystem has two conventions:
 *
 * - `skill`: the Agent Skills standard (agentskills.io). One portable SKILL.md
 *   directory, identical bytes for every one of these tools — that is the point
 *   of the standard, and why this generator emits only the six spec-portable
 *   frontmatter fields rather than the wider set Claude Code alone accepts.
 * - `section`: a shared instruction file (AGENTS.md and friends) that many other
 *   tools read. We own only a marked region of it and never touch the rest.
 */
export type TargetKind = 'skill' | 'section' | 'mdc';

export interface Target {
  id: string;
  label: string;
  kind: TargetKind;
  /** Directory (kind `skill`) or file (kind `section`/`mdc`), relative to root. */
  path: (toolName: string) => string;
  /** Why this target exists, shown by `--check`. */
  note: string;
}

export const TARGETS: readonly Target[] = [
  // ---- Agent Skills standard ----------------------------------------------
  {
    id: 'claude-code',
    label: 'Claude Code',
    kind: 'skill',
    path: (t) => `.claude/skills/${t}`,
    note: 'Claude Code loads project skills from .claude/skills/.',
  },
  {
    id: 'codex',
    label: 'OpenAI Codex',
    kind: 'skill',
    path: (t) => `.codex/skills/${t}`,
    note: 'Codex loads skills from .codex/skills/.',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    kind: 'skill',
    path: (t) => `.cursor/skills/${t}`,
    note: 'Cursor 2.4+ loads .cursor/skills/, and also reads .claude/skills/ and .codex/skills/.',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    kind: 'skill',
    path: (t) => `.gemini/skills/${t}`,
    note: 'Gemini CLI loads skills from .gemini/skills/.',
  },
  {
    id: 'agents-skills',
    label: 'Cross-agent (.agents)',
    kind: 'skill',
    path: (t) => `.agents/skills/${t}`,
    note: 'Emerging vendor-neutral location; harmless where unsupported.',
  },

  // ---- Shared instruction files -------------------------------------------
  {
    id: 'agents-md',
    label: 'AGENTS.md',
    kind: 'section',
    path: () => 'AGENTS.md',
    note: 'Read by 30+ agents (Codex, Copilot, Cursor, Gemini, Jules, Aider, Zed, Windsurf, Devin).',
  },
  {
    id: 'claude-md',
    label: 'CLAUDE.md',
    kind: 'section',
    path: () => 'CLAUDE.md',
    note: 'Claude Code reads CLAUDE.md, not AGENTS.md.',
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    kind: 'section',
    path: () => '.github/copilot-instructions.md',
    note: 'Repository-wide Copilot instructions.',
  },
  {
    id: 'cursor-rules',
    label: 'Cursor rules (legacy)',
    kind: 'mdc',
    path: (t) => `.cursor/rules/${t}.mdc`,
    note: 'For Cursor versions predating skills support.',
  },
];

export const DEFAULT_TARGET_IDS = TARGETS.map((t) => t.id);

export function targetById(id: string): Target | undefined {
  return TARGETS.find((t) => t.id === id);
}

/** Just the `@AGENTS.md` import, for when AGENTS.md carries the content. */
export function renderClaudeMdPointer(): string {
  return '@AGENTS.md';
}

/**
 * The section written into a shared instruction file. Deliberately short: these
 * files load into context on every request for every tool that reads them, so
 * the detail lives in the skill and this only says enough to route the agent
 * there and prevent the two expensive mistakes.
 */
export function renderSection(manifest: ToolManifest, skillPath: string): string {
  const spending = manifest.commands.filter((c) => c.spends);

  return `## ${manifest.name}

${manifest.description ?? `The \`${manifest.name}\` CLI.`}

- Full instructions: \`${skillPath}/SKILL.md\`
- Always pass \`--json\`: one JSON document on stdout, semantic exit code. Never parse stderr.
- Check \`${manifest.name} doctor --json\` first. If \`.data.auth.ok\` is false, ask the
  **user** to run \`${manifest.name} login\` — it needs a browser and will hang if you run it.
- \`status: "error"\` carries \`remediation\` (the exact next command) and \`retryable\`.
  Never retry exit 7 (rate limited), 4 (insufficient balance) or 20 (declined).
${
  spending.length
    ? `- ${spending.map((c) => `\`${manifest.name} ${c.name}\``).join(', ')} ${
        spending.length === 1 ? 'spends' : 'spend'
      } money. ${spending.length === 1 ? 'It exits' : 'They exit'} **10**
  with \`status: "checkpoint"\`. Print \`.display\` verbatim, ask the user, and only then
  run \`.next.approve\`. Never pass \`--yes\`.`
    : ''
}`;
}

/**
 * Cursor's legacy rule format. `alwaysApply: false` with a description makes it
 * agent-requested: Cursor pulls it in when the description matches the task,
 * rather than taxing every request.
 */
export function renderMdc(manifest: ToolManifest, description: string, skillPath: string): string {
  return `---
description: ${JSON.stringify(description)}
alwaysApply: false
---

${renderSection(manifest, skillPath)}
`;
}
