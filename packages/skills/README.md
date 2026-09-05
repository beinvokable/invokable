# @invokable/skills

Turns an [invokable](https://github.com/beinvokable/invokable) tool schema into
agent instructions, and installs them wherever the user's agent will look.

```js
import { initCommand } from '@invokable/skills';

export default defineTool({
  name: 'demo-tool',
  commands: { init: initCommand(), /* … */ },
});
```

```console
$ demo-tool init
created: .claude/skills/demo-tool/SKILL.md
created: .codex/skills/demo-tool/SKILL.md
…
```

## What it writes

**One portable `SKILL.md`**, byte-identical, into every skills directory:
`.claude/skills/`, `.codex/skills/`, `.cursor/skills/`, `.gemini/skills/` and
`.agents/skills/`. Plus `references/commands.md`, `references/errors.md`, and
`references/checkpoints.md` for tools with approval gates.

**A short section** in the flat instruction files other agents read: `AGENTS.md`
(Codex, Copilot, Cursor, Gemini, Jules, Aider, Zed, Windsurf, Devin, …),
`.github/copilot-instructions.md`, and `.cursor/rules/<tool>.mdc` for Cursor
versions predating skills. Only the region between
`<!-- invokable:begin <tool> -->` and `<!-- invokable:end <tool> -->` is touched.

`CLAUDE.md` gets `@AGENTS.md` rather than a copy of the section: Claude Code
reads `CLAUDE.md` and not `AGENTS.md`, and duplicating would load the same text
twice into every session.

## Spec compliance

Only the six frontmatter fields of the [Agent Skills spec](https://agentskills.io)
are emitted — `name`, `description`, `license`, `compatibility`, `metadata`,
`allowed-tools`. Claude Code accepts more, but a skill carrying a non-spec field
fails to upload to claude.ai or the Skills API with a hard error, so emitting one
would trade portability for nothing.

`name` and `description` are validated against the API's constraints
(`^[a-z0-9-]{1,64}$`, no reserved words; ≤ 1024 characters, no XML tags) and
reported as `issues` rather than written out broken.

## Two kinds of knowledge, one `init`

The generated `SKILL.md` teaches an agent how to **operate** the tool: check
auth, read the envelope, which commands spend, what never to do. It is derived
from the schema and cannot drift. What it cannot know is what the tool is
**for**: the order of a multi-step workflow, the questions to ask the user
before a paid call, the things the product forbids. That knowledge is yours to
write, and `initCommand` takes it in two forms.

### Sections: extend the tool's own skill

Short, always-relevant guidance that belongs in the main skill. Setup steps,
what to prefer, house rules.

```js
init: initCommand({
  sections: [
    {
      heading: 'First-time setup',
      placement: 'after-auth',          // right after the "check auth" chapter
      body: `
1. \`demo-tool login\` — ask the **user** to run this; it opens a browser.
2. \`demo-tool connect\` — registers the MCP server with this project.
3. \`demo-tool verify --json\` — confirms the whole chain works.`,
    },
    {
      heading: 'Using it afterwards',   // default placement: after the commands table
      body: 'Prefer the MCP tools for normal work. Call `get_balance` before anything expensive.',
    },
  ],
}),
```

| `placement` | Lands |
|---|---|
| `after-auth` | after "Check auth before the first command" |
| `after-commands` (default) | after the commands table |
| `before-never` | after the approval-gates chapter, before the Never rules |
| `end` | after Never, before the custom block |

Sections are part of the generated output: `--check` sees a changed section as
stale, and `init` writes it into every skills directory. Nothing to stamp
afterwards.

### Bundled skills: ship more than one

A workflow with its own trigger. An agent loads it when the user's request
matches its description, and not otherwise, so the balance question does not
carry the content-planning playbook.

```js
init: initCommand({
  skills: [
    {
      name: 'plan',                     // installed as demo-tool-plan
      description:
        'Builds a content plan from a saved voice profile, over the demo-tool MCP tools. ' +
        'Use when the user asks for a content plan, a posting schedule, or what to publish.',
      body: `
## Steps

1. Call \`build_plan\` (free). It returns the goals the user can pick from.
2. Show every goal and ask which they want. Never pick for them.
3. Tell the user \`create_plan\` costs 200 credits. Only if they agree, call it.
4. Show the finished plan in full and ask whether to save it.
5. Only on yes, call \`save_plan\`.`,
      references: [{ path: 'goals.md', content: goalsCatalogue }],
    },
  ],
}),
```

```console
$ demo-tool init
created: .claude/skills/demo-tool/SKILL.md
created: .claude/skills/demo-tool-plan/SKILL.md
created: .claude/skills/demo-tool-plan/references/goals.md
…
```

What you get for each bundled skill:

- A `SKILL.md` with spec-portable frontmatter (`name`, `description`,
  `allowed-tools`, `license`, `metadata` carrying the tool name and version),
  your body, a custom block that survives regeneration, and a pointer back to
  the tool's skill for the operating rules.
- The same five install locations, the same `--check`, the same `--force`.
- A line in the tool's skill under **Related skills**, and a line in the
  `AGENTS.md` / Copilot / Cursor-rules section, so an agent that has only read
  the shared file knows the workflow exists.

`name` is validated as `<tool>-<name>` against the spec pattern;
`description` against the 1024-character limit. Problems are reported as
`issues`, not written out broken.

### Which one, and what stays in the MCP tool description

| Put it in | When |
|---|---|
| the MCP tool `description` | one call's contract: what it does, what it costs, what to say to the user before calling it |
| a **section** | short guidance that applies whenever the tool is used: setup order, what to prefer, house rules |
| a **bundled skill** | a multi-step workflow with its own trigger phrases, or anything longer than a screen |
| the **custom block** | per-project notes written by the *user* of the tool, not by you |

The MCP tool description is read only after the model has decided to call
the tool; a skill is read before. Anything that must shape *whether* and *in
what order* tools are called belongs in a skill.

## Keeping edits

Anything inside `<!-- invokable:custom -->` … `<!-- /invokable:custom -->` is
carried across regeneration. Blocks that no longer have a placeholder are
appended rather than dropped — losing someone's edits silently is worse than an
odd layout. `--force` overwrites them.

## In CI

```yaml
- run: npx demo-tool init --check
```

Exits **30** when a schema change was not regenerated. A distinct code, so it
does not look like a crash.

## Options

`initCommand(options)` accepts `description`, `triggers`, `allowedTools`,
`license`, `sections` and `skills` (above). The command itself takes:

| Option | Effect |
|---|---|
| `--dir <path>` | Project root. Defaults to the working directory. |
| `--targets <ids>` | Comma-separated subset. Default: all. |
| `--check` | Report what is stale; write nothing; exit 30 if any. |
| `--force` | Overwrite hand-edited custom blocks. |

Target ids: `claude-code`, `codex`, `cursor`, `gemini`, `agents-skills`,
`agents-md`, `claude-md`, `copilot`, `cursor-rules`.
