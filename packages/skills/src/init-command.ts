import { InvokableError, buildManifest, command } from '@invokable/core';
import { installSkills } from './install.js';
import type { BundledSkill, SkillSection } from './render.js';
import { DEFAULT_TARGET_IDS } from './targets.js';

/** What a tool can add to the generated instructions. See the README. */
export interface InitCommandOptions {
  /** Overrides the generated `description` frontmatter of the tool's skill. */
  description?: string;
  /** Extra trigger phrases folded into the generated description. */
  triggers?: readonly string[];
  /** Defaults to `Bash, Read`. */
  allowedTools?: readonly string[];
  license?: string;
  /** Developer-written sections rendered into the tool's SKILL.md. */
  sections?: readonly SkillSection[];
  /** Skills shipped with the tool, installed as `<tool>-<name>` next to it. */
  skills?: readonly BundledSkill[];
}

/**
 * The `init` built-in from spec 5.3, provided here rather than in core so that
 * the runtime does not depend on the generator. A tool opts in:
 *
 *   commands: { init: initCommand(), … }
 *
 * and may add its own knowledge:
 *
 *   commands: { init: initCommand({ sections: [...], skills: [...] }), … }
 */
export function initCommand(options: InitCommandOptions = {}) {
  return command({
    description: 'Install agent instructions for this tool into the current project.',
    options: {
      dir: { type: 'string', description: 'Project root. Defaults to the working directory.' },
      targets: {
        type: 'string',
        description: `Comma-separated targets. Default: all (${DEFAULT_TARGET_IDS.join(', ')}).`,
      },
      check: { type: 'boolean', description: 'Report what is out of date without writing.' },
      force: { type: 'boolean', description: 'Overwrite hand-edited custom blocks.' },
    },
    exitCodes: { 30: 'Generated agent instructions are out of date (--check).' },
    // The per-file notes below are the human output; dumping the result object
    // underneath them would just repeat it at ten times the length.
    formatHuman: () => null,
    run: ({ opts, ctx }) => {
      const result = installSkills({
        manifest: buildManifest(ctx.tool),
        ...(options.description !== undefined ? { description: options.description } : {}),
        ...(options.triggers !== undefined ? { triggers: options.triggers } : {}),
        ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
        ...(options.license !== undefined ? { license: options.license } : {}),
        ...(options.sections !== undefined ? { sections: options.sections } : {}),
        ...(options.skills !== undefined ? { skills: options.skills } : {}),
        ...(opts.dir !== undefined ? { root: opts.dir } : {}),
        ...(opts.targets !== undefined
          ? { targets: opts.targets.split(',').map((s) => s.trim()).filter(Boolean) }
          : {}),
        check: opts.check,
        force: opts.force,
      });

      for (const issue of result.issues) {
        ctx.io.warn(`warning: ${issue.field}: ${issue.message}`);
      }

      const changed = result.files.filter((f) => f.action !== 'unchanged');
      const verb = (action: string): string =>
        opts.check ? (action === 'created' ? 'would create' : 'would update') : action;
      for (const file of changed) {
        ctx.io.note(`${verb(file.action)}: ${file.path}`);
      }
      if (!changed.length) ctx.io.note('Agent instructions are up to date.');

      if (opts.check && result.outOfDate) {
        // A tool-defined code so CI can fail on stale generated files without
        // conflating it with a real error.
        throw new InvokableError({
          code: 'skills_out_of_date',
          message: `${changed.length} generated file(s) are out of date.`,
          remediation: `${ctx.tool.name} init`,
          exitCode: 30,
          retryable: false,
        });
      }
      return result;
    },
  });
}
