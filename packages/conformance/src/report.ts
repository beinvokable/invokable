import type { CheckResult, CheckStatus } from './checks.js';

export interface Report {
  command: string;
  passed: number;
  failed: number;
  warnings: number;
  skipped: number;
  ok: boolean;
  checks: CheckResult[];
}

export function summarise(command: string, checks: CheckResult[]): Report {
  const count = (s: CheckStatus): number => checks.filter((c) => c.status === s).length;
  const failed = count('fail');
  return {
    command,
    passed: count('pass'),
    failed,
    warnings: count('warn'),
    skipped: count('skip'),
    ok: failed === 0,
    checks,
  };
}

const GLYPH: Record<CheckStatus, string> = {
  pass: '✓',
  fail: '✗',
  warn: '!',
  skip: '–',
};

export function renderReport(report: Report): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`invokable conformance — ${report.command}`);
  lines.push('');

  for (const check of report.checks) {
    lines.push(`  ${GLYPH[check.status]} ${check.title}`);
    if (check.detail && check.status !== 'pass') {
      for (const line of wrap(check.detail, 70)) lines.push(`      ${line}`);
    } else if (check.detail) {
      lines.push(`      ${check.detail}`);
    }
    // The rationale is shown only on failure: it is the part that tells someone
    // why the contract cares, which is what they need when deciding to fix it.
    if (check.status === 'fail' || check.status === 'warn') {
      for (const line of wrap(`Why: ${check.rationale}`, 70)) lines.push(`      ${line}`);
      if (check.invocations.length) {
        lines.push(`      Reproduce: ${check.invocations[0]!}`);
      }
      lines.push('');
    }
  }

  lines.push('');
  const parts = [`${report.passed} passed`];
  if (report.failed) parts.push(`${report.failed} failed`);
  if (report.warnings) parts.push(`${report.warnings} warning${report.warnings === 1 ? '' : 's'}`);
  if (report.skipped) parts.push(`${report.skipped} skipped`);
  lines.push(`  ${parts.join(', ')}`);
  lines.push('');
  return lines.join('\n');
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line === '') line = word;
    else if ((line + ' ' + word).length <= width) line += ' ' + word;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out;
}
