/**
 * Best-effort detection of which coding agent is driving the CLI, reported via
 * the `X-Invokable-Agent` header (spec 5.2).
 *
 * This is telemetry, never authorisation: the values come from environment
 * variables any process can set, so nothing may depend on them being truthful.
 */
export type AgentId = 'claude-code' | 'codex' | 'cursor' | 'gemini-cli' | 'unknown';

interface Probe {
  id: AgentId;
  /** Matches if any listed variable is set, or any regex matches a var name. */
  vars?: readonly string[];
  patterns?: readonly RegExp[];
}

const PROBES: readonly Probe[] = [
  { id: 'claude-code', vars: ['CLAUDECODE', 'CLAUDE_CODE'], patterns: [/^CLAUDE_CODE_/] },
  { id: 'codex', patterns: [/^CODEX_/] },
  { id: 'cursor', vars: ['CURSOR_TRACE_ID'], patterns: [/^CURSOR_/] },
  { id: 'gemini-cli', vars: ['GEMINI_CLI'], patterns: [/^GEMINI_CLI_/] },
];

export function detectAgent(env: NodeJS.ProcessEnv = process.env): AgentId {
  const names = Object.keys(env);
  for (const probe of PROBES) {
    if (probe.vars?.some((v) => env[v])) return probe.id;
    if (probe.patterns?.some((re) => names.some((n) => re.test(n)))) return probe.id;
  }
  return 'unknown';
}

/** True when the process looks non-interactive, so prompting would hang. */
export function isInteractive(stream: { isTTY?: boolean } = process.stdin): boolean {
  return Boolean(stream.isTTY);
}
