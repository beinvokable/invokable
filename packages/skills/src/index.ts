export {
  renderSkill,
  renderSkillMd,
  renderBundledSkill,
  bundledSkillName,
  renderCommandsReference,
  renderErrorsReference,
  renderCheckpointsReference,
  buildDescription,
} from './render.js';
export type {
  RenderOptions,
  RenderedSkill,
  RenderedFile,
  SkillSection,
  SectionPlacement,
  BundledSkill,
} from './render.js';

export { installSkills } from './install.js';
export type { InstallOptions, InstallResult, InstalledFile, FileAction } from './install.js';

export { TARGETS, DEFAULT_TARGET_IDS, targetById, renderSection, renderMdc } from './targets.js';
export type { Target, TargetKind, RelatedSkill } from './targets.js';

export {
  extractCustomBlocks,
  restoreCustomBlocks,
  upsertSection,
  beginMarker,
  endMarker,
} from './markers.js';

export {
  SPEC_FIELDS,
  NAME_PATTERN,
  DESCRIPTION_MAX,
  validateSkillName,
  validateDescription,
} from './spec.js';
export type { SpecField, ValidationIssue } from './spec.js';

export { initCommand } from './init-command.js';
export type { InitCommandOptions } from './init-command.js';
