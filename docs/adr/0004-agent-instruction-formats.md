# ADR 0004 — One portable SKILL.md, installed everywhere

**Status:** accepted · **Date:** 2026-09-04

## Context

Spec §9 lists as blocking: *"the SKILL.md format differs between Claude Code and
Codex — what is locked and what is compatible?"*

When the spec was written that was true, and it framed §5.6 as a set of
per-vendor adapters generating different files. Checking the current
documentation before building the generator changed the answer.

## What we found

**The format converged.** The Agent Skills specification, published at
agentskills.io, is now implemented by roughly 40 products, including Claude Code,
OpenAI Codex, GitHub Copilot, VS Code, Cursor 2.4+, Gemini CLI, Goose and
OpenCode. The same `SKILL.md` loads unchanged across them. `AGENTS.md` is a
separate, older convention read by 30+ agents and is now stewarded by the
Agentic AI Foundation at the Linux Foundation.

**What is locked** — the six frontmatter fields the spec allows:

| Field | Constraint |
|---|---|
| `name` | `^[a-z0-9-]{1,64}$`; may not contain `claude` or `anthropic` |
| `description` | non-empty, ≤ 1024 characters, no XML/HTML tags |
| `license` | free string |
| `compatibility` | ≤ 500 characters |
| `metadata` | free-form YAML map |
| `allowed-tools` | space/comma string or YAML list |

Claude Code accepts many more fields (`paths`, `context`, `model`, `hooks`, …).
**We emit none of them.** A skill carrying any non-spec field fails to upload to
claude.ai or the Skills API with a hard error rather than being ignored, so the
extra fields would trade portability for features the generated skill does not
need. Frontmatter must also open on the file's first line, or Claude Code treats
the whole file as body content.

**What still differs** is only *where each tool looks*:

| Tool | Location |
|---|---|
| Claude Code | `.claude/skills/<name>/` |
| Codex | `.codex/skills/<name>/` |
| Cursor | `.cursor/skills/<name>/` (also reads `.claude/` and `.codex/`) |
| Gemini CLI | `.gemini/skills/<name>/` |
| Cross-agent | `.agents/skills/<name>/` |

## Decision

**Generate one spec-compliant skill and install identical bytes into every
location.** The `skills.test.ts` suite asserts they are byte-identical; if that
ever fails, the standard has stopped delivering what it promises.

For agents that read a flat instruction file rather than skills, write a short
**section** delimited by `<!-- invokable:begin <tool> -->` markers into
`AGENTS.md`, `.github/copilot-instructions.md` and `.cursor/rules/<tool>.mdc`.
These files load on every request for every tool that reads them, so the section
is deliberately brief and routes to the skill for detail.

`CLAUDE.md` is the one special case: Claude Code reads `CLAUDE.md` and **not**
`AGENTS.md`. When both are targets, `CLAUDE.md` gets only `@AGENTS.md` — the
import Anthropic's own documentation recommends. Writing the section into both
would load the same text twice into every Claude Code session.

Copying rather than symlinking is deliberate: symlinks need Administrator rights
or Developer Mode on Windows, and do not survive archives that flatten them.

## Consequences

- §9's blocking question is closed: there is a locked format, and it is the
  Agent Skills spec.
- Adding a tool is one entry in `TARGETS`, not a new renderer.
- `init --check` exits **30** when generated files are stale, so CI can fail on a
  schema change that was not regenerated without conflating it with a real error.
- We are exposed to the spec changing. The validation in `spec.ts` encodes the
  current constraints in one place, and the generated frontmatter is small enough
  that tracking a revision is cheap.

## Uncertainty worth recording

`.agents/skills/` is reported as an emerging cross-agent convention rather than a
documented location in any vendor's own documentation. It is included because an
unread directory costs nothing, but it should not be assumed load-bearing. The
other four paths, and every frontmatter constraint above, come from vendor
documentation.
