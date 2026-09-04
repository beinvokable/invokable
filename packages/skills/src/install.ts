import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { ToolManifest } from '@invokable/core';
import { extractCustomBlocks, restoreCustomBlocks, upsertSection } from './markers.js';
import { buildDescription, renderSkill, type RenderOptions } from './render.js';
import {
  DEFAULT_TARGET_IDS,
  renderClaudeMdPointer,
  renderMdc,
  renderSection,
  targetById,
  type Target,
} from './targets.js';
import type { ValidationIssue } from './spec.js';

export type FileAction = 'created' | 'updated' | 'unchanged';

export interface InstalledFile {
  path: string;
  action: FileAction;
  /** Custom blocks carried across from the previous version. */
  preservedBlocks?: number;
}

export interface InstallResult {
  tool: string;
  files: InstalledFile[];
  targets: string[];
  issues: ValidationIssue[];
  /** True when `check` was set and something is out of date. */
  outOfDate: boolean;
}

export interface InstallOptions extends RenderOptions {
  /** Project root. Defaults to the current working directory. */
  root?: string;
  /** Target ids; defaults to all of them. */
  targets?: readonly string[];
  /** Report what would change without writing. */
  check?: boolean;
  /** Overwrite hand-edited custom blocks instead of preserving them. */
  force?: boolean;
}

function writeIfChanged(
  absolute: string,
  content: string,
  opts: { check: boolean; root: string },
): InstalledFile {
  const path = relative(opts.root, absolute) || absolute;
  const exists = existsSync(absolute);
  const current = exists ? readFileSync(absolute, 'utf8') : null;

  if (current === content) return { path, action: 'unchanged' };

  if (!opts.check) {
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
  return { path, action: exists ? 'updated' : 'created' };
}

/**
 * Generates the skill and installs it into every requested target.
 *
 * The same SKILL.md bytes go to every `skill` target: that is what the Agent
 * Skills standard buys, and duplicating rather than symlinking keeps it working
 * on Windows and inside archives that do not preserve links.
 */
export function installSkills(options: InstallOptions): InstallResult {
  const root = options.root ?? process.cwd();
  const check = options.check ?? false;
  const ids = options.targets ?? DEFAULT_TARGET_IDS;

  const targets: Target[] = [];
  for (const id of ids) {
    const target = targetById(id);
    if (!target) {
      throw new Error(
        `Unknown skills target "${id}". Known targets: ${DEFAULT_TARGET_IDS.join(', ')}.`,
      );
    }
    targets.push(target);
  }

  const rendered = renderSkill(options);
  const manifest: ToolManifest = options.manifest;
  const description = buildDescription(options);
  const files: InstalledFile[] = [];

  // The canonical skill location, referenced by every section target so an
  // agent reading AGENTS.md knows where the detail lives.
  const canonical =
    targets.find((t) => t.kind === 'skill')?.path(manifest.name) ??
    `.claude/skills/${manifest.name}`;

  for (const target of targets) {
    if (target.kind === 'skill') {
      const dir = join(root, target.path(manifest.name));
      for (const file of rendered.files) {
        const absolute = join(dir, file.path);

        let content = file.content;
        let preserved = 0;
        if (!options.force && existsSync(absolute)) {
          const blocks = extractCustomBlocks(readFileSync(absolute, 'utf8'));
          if (blocks.length) {
            content = restoreCustomBlocks(content, blocks);
            preserved = blocks.length;
          }
        }

        const result = writeIfChanged(absolute, content, { check, root });
        files.push(preserved ? { ...result, preservedBlocks: preserved } : result);
      }
      continue;
    }

    const absolute = join(root, target.path(manifest.name));

    if (target.kind === 'mdc') {
      files.push(
        writeIfChanged(absolute, renderMdc(manifest, description, canonical), { check, root }),
      );
      continue;
    }

    // kind === 'section': touch only our marked region of someone else's file.
    const existing = existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';

    // Claude Code does not read AGENTS.md, so CLAUDE.md has to carry the
    // content somehow. When AGENTS.md is also a target it already has it, and
    // an import is enough — repeating the section would load the same text
    // twice into every Claude Code session.
    const writesAgentsMd = ids.includes('agents-md');
    const section =
      target.id === 'claude-md' && writesAgentsMd
        ? renderClaudeMdPointer()
        : renderSection(manifest, canonical);

    const next = upsertSection(existing, manifest.name, section);

    files.push(writeIfChanged(absolute, next, { check, root }));
  }

  return {
    tool: manifest.name,
    files,
    targets: targets.map((t) => t.id),
    issues: rendered.issues,
    outOfDate: files.some((f) => f.action !== 'unchanged'),
  };
}
