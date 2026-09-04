/**
 * Constraints from the Agent Skills specification (agentskills.io), as enforced
 * by the Claude Skills API and by `package_skill.py` in anthropics/skills.
 *
 * Only six frontmatter fields are portable. Claude Code accepts many more, but
 * a skill carrying any of them fails to upload to claude.ai or the Skills API
 * with a hard error rather than being ignored — so a generator that wants one
 * file to work everywhere must emit only these.
 */
export const SPEC_FIELDS = [
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
] as const;

export type SpecField = (typeof SPEC_FIELDS)[number];

export const NAME_PATTERN = /^[a-z0-9-]{1,64}$/;
export const NAME_MAX = 64;
export const DESCRIPTION_MAX = 1024;
export const COMPATIBILITY_MAX = 500;

/** Reserved by the spec; a skill named with these is rejected on upload. */
const RESERVED_WORDS = ['anthropic', 'claude'];

export interface ValidationIssue {
  field: string;
  message: string;
}

export function validateSkillName(name: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!NAME_PATTERN.test(name)) {
    issues.push({
      field: 'name',
      message:
        `"${name}" is not a valid skill name. Use 1-${NAME_MAX} characters of ` +
        'lowercase letters, digits and hyphens only.',
    });
  }
  for (const word of RESERVED_WORDS) {
    if (name.toLowerCase().includes(word)) {
      issues.push({
        field: 'name',
        message: `Skill names may not contain the reserved word "${word}".`,
      });
    }
  }
  return issues;
}

export function validateDescription(description: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!description.trim()) {
    issues.push({ field: 'description', message: 'description must not be empty.' });
  }
  if (description.length > DESCRIPTION_MAX) {
    issues.push({
      field: 'description',
      message: `description is ${description.length} characters; the limit is ${DESCRIPTION_MAX}.`,
    });
  }
  // XML tags are rejected by the Skills API validator.
  if (/<[a-zA-Z/][^>]*>/.test(description)) {
    issues.push({
      field: 'description',
      message: 'description must not contain XML/HTML tags.',
    });
  }
  return issues;
}
