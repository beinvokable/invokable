import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildManifest, command, defineTool, type ToolManifest } from '@invokable/core';
import { installSkills } from '../src/install.js';
import { renderSkill, renderSkillMd, buildDescription } from '../src/render.js';
import { extractCustomBlocks, restoreCustomBlocks, upsertSection } from '../src/markers.js';
import { validateDescription, validateSkillName, DESCRIPTION_MAX } from '../src/spec.js';
import { TARGETS } from '../src/targets.js';
import { initCommand } from '../src/init-command.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'invokable-skills-'));
  dirs.push(d);
  return d;
}

const tool = defineTool({
  name: 'demo-tool',
  version: '1.0.0',
  description: 'Deploy and inspect demo projects.',
  api: { baseUrl: 'https://api.example.com' },
  commands: {
    greet: command({
      description: 'Greet someone.',
      options: { name: { type: 'string', required: true, short: 'n', description: 'Who.' } },
      run: () => ({}),
    }),
    deploy: command({
      description: 'Deploy the project.',
      options: { env: { type: 'string', required: true, choices: ['staging', 'prod'] } },
      spends: true,
      exitCodes: { 42: 'The environment is locked.' },
      run: () => ({}),
    }),
  },
});
const manifest: ToolManifest = buildManifest(tool);

describe('Agent Skills spec compliance', () => {
  it('emits only the six spec-portable frontmatter fields', () => {
    // Any other field is a hard error on claude.ai upload and the Skills API,
    // so a generator aiming for one portable file must not emit them.
    const { content } = renderSkillMd({ manifest, license: 'MIT' });
    const frontmatter = content.split('---')[1]!;
    const keys = frontmatter
      .split('\n')
      .filter((l) => /^[a-zA-Z][\w-]*:/.test(l))
      .map((l) => l.split(':')[0]!);

    const allowed = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];
    for (const key of keys) expect(allowed).toContain(key);
  });

  it('starts the file with the frontmatter delimiter', () => {
    // Claude Code reads frontmatter only when `---` is the very first line.
    const { content } = renderSkillMd({ manifest });
    expect(content.startsWith('---\n')).toBe(true);
  });

  it('produces a valid name and description', () => {
    const { issues } = renderSkillMd({ manifest });
    expect(issues).toEqual([]);
  });

  it('rejects names the Skills API would reject', () => {
    expect(validateSkillName('Demo_Tool')).not.toEqual([]);
    expect(validateSkillName('claude-helper')).not.toEqual([]);
    expect(validateSkillName('a'.repeat(65))).not.toEqual([]);
    expect(validateSkillName('demo-tool-2')).toEqual([]);
  });

  it('rejects descriptions that break the API validator', () => {
    expect(validateDescription('')).not.toEqual([]);
    expect(validateDescription('a'.repeat(DESCRIPTION_MAX + 1))).not.toEqual([]);
    expect(validateDescription('Use <tool> for things')).not.toEqual([]);
    expect(validateDescription('A normal description.')).toEqual([]);
  });

  it('truncates an over-long generated description rather than emitting it', () => {
    const wide = buildDescription({
      manifest: { ...manifest, description: 'x'.repeat(DESCRIPTION_MAX + 500) },
    });
    expect(wide.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(validateDescription(wide)).toEqual([]);
  });
});

describe('generated content', () => {
  it('tells the agent not to run login itself', () => {
    const { content } = renderSkillMd({ manifest });
    expect(content).toContain('Do not run it');
    expect(content).toContain('demo-tool login');
  });

  it('carries the Never rules the spec calls for', () => {
    const { content } = renderSkillMd({ manifest });
    expect(content).toContain('Never pass `--yes`');
    expect(content).toContain('Never pass `--token`');
    expect(content).toContain('Never retry on exit 7');
  });

  it('documents the third status value', () => {
    const { content } = renderSkillMd({ manifest });
    expect(content).toContain('`checkpoint`');
    expect(content).toContain('status": "checkpoint"');
  });

  it('lists built-in commands alongside the tool’s own', () => {
    const { content } = renderSkillMd({ manifest });
    for (const name of ['login', 'logout', 'whoami', 'doctor', 'greet', 'deploy']) {
      expect(content).toContain(`demo-tool ${name}`);
    }
  });

  it('marks spending commands and includes the checkpoint reference', () => {
    const skill = renderSkill({ manifest });
    expect(skill.files.map((f) => f.path)).toContain('references/checkpoints.md');
    const main = skill.files.find((f) => f.path === 'SKILL.md')!.content;
    expect(main).toContain('**(spends money)**');
  });

  it('omits the checkpoint reference for a tool with no gates', () => {
    const plain = buildManifest(
      defineTool({
        name: 'plain-tool',
        version: '1.0.0',
        commands: { ping: command({ description: 'Ping.', run: () => ({}) }) },
      }),
    );
    const skill = renderSkill({ manifest: plain });
    expect(skill.files.map((f) => f.path)).not.toContain('references/checkpoints.md');
  });

  it('surfaces tool-defined exit codes in the errors reference', () => {
    const errors = renderSkill({ manifest }).files.find(
      (f) => f.path === 'references/errors.md',
    )!.content;
    expect(errors).toContain('42');
    expect(errors).toContain('The environment is locked.');
  });

  it('documents every option, including choices and shorthands', () => {
    const commands = renderSkill({ manifest }).files.find(
      (f) => f.path === 'references/commands.md',
    )!.content;
    expect(commands).toContain('`--name`');
    expect(commands).toContain('`-n`');
    expect(commands).toContain('`staging`, `prod`');
  });
});

describe('installation across targets', () => {
  it('writes one identical SKILL.md to every skills directory', () => {
    const root = tempRoot();
    installSkills({ manifest, root });

    const paths = ['.claude', '.codex', '.cursor', '.gemini', '.agents'].map((d) =>
      join(root, d, 'skills', 'demo-tool', 'SKILL.md'),
    );
    const contents = paths.map((p) => readFileSync(p, 'utf8'));
    // Byte-identical is the whole promise of the standard.
    expect(new Set(contents).size).toBe(1);
  });

  it('covers the agents people actually use', () => {
    const ids = TARGETS.map((t) => t.id);
    for (const expected of ['claude-code', 'codex', 'cursor', 'gemini', 'agents-md', 'copilot']) {
      expect(ids).toContain(expected);
    }
  });

  it('appends to an existing AGENTS.md without touching the rest', () => {
    const root = tempRoot();
    const agents = join(root, 'AGENTS.md');
    writeFileSync(agents, '# My project\n\nRun `make test` before committing.\n');

    installSkills({ manifest, root });

    const content = readFileSync(agents, 'utf8');
    expect(content).toContain('# My project');
    expect(content).toContain('Run `make test` before committing.');
    expect(content).toContain('## demo-tool');
  });

  it('replaces only its own section when regenerating', () => {
    const root = tempRoot();
    const agents = join(root, 'AGENTS.md');
    writeFileSync(agents, '# Mine\n\nKeep me.\n');

    installSkills({ manifest, root, targets: ['agents-md'] });
    installSkills({ manifest, root, targets: ['agents-md'] });

    const content = readFileSync(agents, 'utf8');
    expect(content).toContain('Keep me.');
    // Exactly one section, not two.
    expect(content.match(/## demo-tool/g)).toHaveLength(1);
  });

  it('makes CLAUDE.md import AGENTS.md rather than duplicating it', () => {
    const root = tempRoot();
    installSkills({ manifest, root });

    const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('@AGENTS.md');
    // Duplicating the section would load the same text twice every session.
    expect(claudeMd).not.toContain('Always pass `--json`');
  });

  it('writes the full section into CLAUDE.md when AGENTS.md is not a target', () => {
    const root = tempRoot();
    installSkills({ manifest, root, targets: ['claude-md'] });

    const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('Always pass `--json`');
    expect(claudeMd).not.toContain('@AGENTS.md');
  });

  it('writes an agent-requested Cursor rule', () => {
    const root = tempRoot();
    installSkills({ manifest, root, targets: ['cursor-rules'] });

    const mdc = readFileSync(join(root, '.cursor/rules/demo-tool.mdc'), 'utf8');
    expect(mdc).toContain('alwaysApply: false');
    expect(mdc).toContain('description:');
  });

  it('reports unchanged on a second run', () => {
    const root = tempRoot();
    installSkills({ manifest, root });
    const second = installSkills({ manifest, root });

    expect(second.files.every((f) => f.action === 'unchanged')).toBe(true);
    expect(second.outOfDate).toBe(false);
  });

  it('--check reports staleness without writing', () => {
    const root = tempRoot();
    const result = installSkills({ manifest, root, check: true });

    expect(result.outOfDate).toBe(true);
    expect(() => readFileSync(join(root, 'AGENTS.md'), 'utf8')).toThrow();
  });

  it('rejects an unknown target by name', () => {
    expect(() => installSkills({ manifest, root: tempRoot(), targets: ['nope'] })).toThrow(
      /Unknown skills target "nope"/,
    );
  });
});

describe('hand-edited content survives regeneration', () => {
  it('preserves a custom block', () => {
    const root = tempRoot();
    installSkills({ manifest, root, targets: ['claude-code'] });

    const skillPath = join(root, '.claude/skills/demo-tool/SKILL.md');
    const edited = readFileSync(skillPath, 'utf8').replace(
      '<!-- Add project-specific guidance here. It survives regeneration. -->',
      'Our staging cluster is in eu-west-1.',
    );
    writeFileSync(skillPath, edited);

    installSkills({ manifest, root, targets: ['claude-code'] });

    expect(readFileSync(skillPath, 'utf8')).toContain('Our staging cluster is in eu-west-1.');
  });

  it('drops custom blocks only when --force is given', () => {
    const root = tempRoot();
    installSkills({ manifest, root, targets: ['claude-code'] });

    const skillPath = join(root, '.claude/skills/demo-tool/SKILL.md');
    writeFileSync(
      skillPath,
      readFileSync(skillPath, 'utf8').replace(
        '<!-- Add project-specific guidance here. It survives regeneration. -->',
        'KEEP ME',
      ),
    );

    installSkills({ manifest, root, targets: ['claude-code'], force: true });
    expect(readFileSync(skillPath, 'utf8')).not.toContain('KEEP ME');
  });

  it('appends extra blocks rather than silently dropping them', () => {
    const generated = 'a\n<!-- invokable:custom -->\n<!-- hint -->\n<!-- /invokable:custom -->\nb';
    const restored = restoreCustomBlocks(generated, ['first', 'second']);
    expect(restored).toContain('first');
    expect(restored).toContain('second');
  });

  it('round-trips blocks through extract and restore', () => {
    const doc = 'x\n<!-- invokable:custom -->\nmine\n<!-- /invokable:custom -->\ny';
    expect(extractCustomBlocks(doc)).toEqual(['mine']);
  });
});

describe('upsertSection', () => {
  it('creates the file content when empty', () => {
    expect(upsertSection('', 'demo', 'hello')).toContain('hello');
  });

  it('is idempotent', () => {
    const once = upsertSection('# Doc\n', 'demo', 'hello');
    expect(upsertSection(once, 'demo', 'hello')).toBe(once);
  });

  it('updates in place, keeping surrounding content', () => {
    const first = upsertSection('# Doc\n\ntail text\n', 'demo', 'v1');
    const second = upsertSection(first, 'demo', 'v2');
    expect(second).toContain('# Doc');
    expect(second).toContain('tail text');
    expect(second).toContain('v2');
    expect(second).not.toContain('v1');
  });
});

describe('the init command', () => {
  it('owns its human output instead of dumping the result object', () => {
    // The per-file notes are the human output; printing the result underneath
    // repeats the same information at ten times the length.
    expect(initCommand().formatHuman?.({ anything: true })).toBeNull();
  });

  it('declares a distinct exit code for stale files', () => {
    expect(initCommand().exitCodes).toMatchObject({ 30: expect.any(String) });
  });
});

describe('developer-written sections', () => {
  const sections = [
    { heading: 'First-time setup', body: 'Run `demo-tool connect` after login.', placement: 'after-auth' as const },
    { heading: 'Using it afterwards', body: 'Prefer the MCP tools for normal work.' },
    { heading: 'Read this last', body: 'Never guess a project slug.', placement: 'before-never' as const },
    { heading: 'Appendix', body: 'Extra notes.', placement: 'end' as const },
  ];

  it('renders each section at its placement, in generated order', () => {
    const { content } = renderSkillMd({ manifest, sections });
    const at = (needle: string) => content.indexOf(needle);
    expect(at('## Check auth before the first command')).toBeLessThan(at('## First-time setup'));
    expect(at('## First-time setup')).toBeLessThan(at('## Reading a result'));
    expect(at('## Commands')).toBeLessThan(at('## Using it afterwards'));
    expect(at('## Using it afterwards')).toBeLessThan(at('## Exit codes'));
    expect(at('## Approval gates')).toBeLessThan(at('## Read this last'));
    expect(at('## Read this last')).toBeLessThan(at('## Never'));
    expect(at('## Never')).toBeLessThan(at('## Appendix'));
    expect(at('## Appendix')).toBeLessThan(at('<!-- invokable:custom -->'));
    expect(content).toContain('Run `demo-tool connect` after login.');
  });

  it('changes nothing when no sections are given', () => {
    expect(renderSkillMd({ manifest }).content).toBe(renderSkillMd({ manifest, sections: [] }).content);
  });

  it('reaches every skills directory through installSkills', () => {
    const root = tempRoot();
    installSkills({ manifest, root, sections: [sections[0]!] });
    for (const t of TARGETS.filter((t) => t.kind === 'skill')) {
      const file = readFileSync(join(root, t.path('demo-tool'), 'SKILL.md'), 'utf8');
      expect(file).toContain('## First-time setup');
    }
  });

  it('is what --check compares against, so a changed section is stale', () => {
    const root = tempRoot();
    installSkills({ manifest, root, sections: [sections[0]!] });
    const same = installSkills({ manifest, root, sections: [sections[0]!], check: true });
    expect(same.outOfDate).toBe(false);
    const edited = installSkills({
      manifest,
      root,
      sections: [{ ...sections[0]!, body: 'Changed.' }],
      check: true,
    });
    expect(edited.outOfDate).toBe(true);
  });
});

describe('bundled skills', () => {
  const plan = {
    name: 'plan',
    description:
      'Builds a 90-day content plan from a saved voice profile. Use when the user asks for a content plan, ' +
      'a posting plan, or what to publish.',
    body: '## Steps\n\n1. Call `build_plan`.\n2. Ask the user which goals.\n3. Call `create_plan`.',
    references: [{ path: 'goals.md', content: '# Goals\n\n- thought_leadership' }],
  };

  it('installs as <tool>-<name> next to the generated skill, in every skills directory', () => {
    const root = tempRoot();
    const result = installSkills({ manifest, root, skills: [plan] });
    for (const t of TARGETS.filter((t) => t.kind === 'skill')) {
      const dir = join(root, t.path('demo-tool-plan'));
      const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
      expect(skill.startsWith('---\nname: demo-tool-plan\n')).toBe(true);
      expect(skill).toMatch(/^description: "?Builds a 90-day content plan/m);
      expect(skill).toContain('allowed-tools: Bash, Read');
      expect(skill).toContain('  tool: demo-tool');
      expect(skill).toContain('# demo-tool-plan');
      expect(skill).toContain('1. Call `build_plan`.');
      expect(skill).toContain('../demo-tool/SKILL.md');
      expect(readFileSync(join(dir, 'references', 'goals.md'), 'utf8')).toContain('thought_leadership');
    }
    expect(result.files.filter((f) => f.path.includes('demo-tool-plan/SKILL.md'))).toHaveLength(5);
  });

  it('emits only spec-portable frontmatter fields', () => {
    const root = tempRoot();
    installSkills({ manifest, root, skills: [plan], targets: ['claude-code'] });
    const content = readFileSync(join(root, '.claude/skills/demo-tool-plan/SKILL.md'), 'utf8');
    const keys = content
      .split('---')[1]!
      .split('\n')
      .filter((l) => /^[a-z-]+:/.test(l))
      .map((l) => l.split(':')[0]!);
    for (const key of keys) expect(['name', 'description', 'allowed-tools', 'license', 'metadata']).toContain(key);
  });

  it('is listed from the generated skill and from AGENTS.md', () => {
    const root = tempRoot();
    installSkills({ manifest, root, skills: [plan] });
    const main = readFileSync(join(root, '.claude/skills/demo-tool/SKILL.md'), 'utf8');
    expect(main).toContain('## Related skills');
    expect(main).toContain('`../demo-tool-plan/SKILL.md` — Builds a 90-day content plan from a saved voice profile.');
    const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('.claude/skills/demo-tool-plan/SKILL.md');
    expect(agents).toContain('Builds a 90-day content plan');
    const mdc = readFileSync(join(root, '.cursor/rules/demo-tool.mdc'), 'utf8');
    expect(mdc).toContain('demo-tool-plan');
  });

  it('validates the combined name and the description', () => {
    const bad = installSkills({
      manifest,
      root: tempRoot(),
      targets: ['claude-code'],
      skills: [{ name: 'Bad Name', description: 'x'.repeat(DESCRIPTION_MAX + 1), body: 'b' }],
    });
    expect(bad.issues.map((i) => i.field)).toEqual(
      expect.arrayContaining(['skills.Bad Name.name', 'skills.Bad Name.description']),
    );
  });

  it('preserves a custom block in a bundled skill across regeneration', () => {
    const root = tempRoot();
    installSkills({ manifest, root, skills: [plan], targets: ['claude-code'] });
    const path = join(root, '.claude/skills/demo-tool-plan/SKILL.md');
    const edited = readFileSync(path, 'utf8').replace(
      /<!-- invokable:custom -->[\s\S]*?<!-- \/invokable:custom -->/,
      '<!-- invokable:custom -->\nOur team never posts on Fridays.\n<!-- /invokable:custom -->',
    );
    writeFileSync(path, edited);
    const again = installSkills({ manifest, root, skills: [plan], targets: ['claude-code'] });
    expect(readFileSync(path, 'utf8')).toContain('Our team never posts on Fridays.');
    expect(again.files.find((f) => f.path.endsWith('demo-tool-plan/SKILL.md'))?.preservedBlocks).toBe(1);
  });

  it('--check catches a stale bundled skill', () => {
    const root = tempRoot();
    installSkills({ manifest, root, skills: [plan], targets: ['claude-code'] });
    expect(installSkills({ manifest, root, skills: [plan], targets: ['claude-code'], check: true }).outOfDate).toBe(false);
    expect(
      installSkills({ manifest, root, skills: [{ ...plan, body: 'new body' }], targets: ['claude-code'], check: true })
        .outOfDate,
    ).toBe(true);
  });

  it('flows through initCommand options', () => {
    const cmd = initCommand({ skills: [plan], sections: [{ heading: 'Setup', body: 'Do this.' }] });
    expect(cmd.description).toContain('Install agent instructions');
  });
});
