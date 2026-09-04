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

| Option | Effect |
|---|---|
| `--dir <path>` | Project root. Defaults to the working directory. |
| `--targets <ids>` | Comma-separated subset. Default: all. |
| `--check` | Report what is stale; write nothing; exit 30 if any. |
| `--force` | Overwrite hand-edited custom blocks. |

Target ids: `claude-code`, `codex`, `cursor`, `gemini`, `agents-skills`,
`agents-md`, `claude-md`, `copilot`, `cursor-rules`.
