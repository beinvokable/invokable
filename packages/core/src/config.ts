import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Everything `login` persists. Unknown keys are preserved on write. */
export interface StoredConfig {
  token?: string;
  /** Non-secret prefix, safe to display in `doctor` / `whoami`. */
  tokenPrefix?: string;
  orgId?: string;
  subject?: string;
  /** Origin of the web app that issued the token, for building approval links. */
  webOrigin?: string;
  [key: string]: unknown;
}

/**
 * A partial update. Distinct from StoredConfig because `exactOptionalPropertyTypes`
 * makes `token?: string` reject an explicit `undefined` — which is exactly how a
 * caller asks for a key to be deleted.
 */
export type ConfigPatch = {
  [K in keyof StoredConfig]?: StoredConfig[K] | undefined;
};

export type TokenSource = 'flag' | 'env' | 'config' | 'none';

export interface ResolvedToken {
  token: string | undefined;
  source: TokenSource;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return resolve(p);
}

/** `demo-tool` -> `DEMO_TOOL_TOKEN`. */
export function tokenEnvVar(toolName: string): string {
  return toolName.toUpperCase().replace(/-/g, '_') + '_TOKEN';
}

/**
 * Reads and writes `<configDir>/config.json`.
 *
 * The file holds a long-lived credential, so two properties matter beyond
 * "it round-trips": the directory is 0700 and the file 0600 (spec 5.4), and
 * writes are atomic — a crash mid-write must not leave a truncated file that
 * loses a token the user cannot recover without logging in again.
 */
export class ConfigStore {
  readonly dir: string;
  readonly path: string;

  constructor(configDir: string) {
    this.dir = expandHome(configDir);
    this.path = join(this.dir, 'config.json');
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  read(): StoredConfig {
    if (!this.exists()) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
      return parsed as StoredConfig;
    } catch {
      // A corrupt config must not brick the CLI: `login` can always rewrite it.
      return {};
    }
  }

  /** Merges into the existing config; `undefined` values delete their key. */
  write(patch: ConfigPatch): StoredConfig {
    // Built as a patch first: the spread legitimately carries `undefined`
    // values, which are then deleted rather than persisted as JSON nulls.
    const draft: ConfigPatch = { ...this.read(), ...patch };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete draft[k];
    }
    const merged = draft as StoredConfig;

    mkdirSync(this.dir, { recursive: true, mode: DIR_MODE });
    try {
      chmodSync(this.dir, DIR_MODE);
    } catch {
      // Best-effort: some filesystems (Windows, mounted volumes) reject chmod.
    }

    // Write to a sibling temp file, then rename — rename is atomic within a
    // filesystem, so a reader never observes a partial document.
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', { mode: FILE_MODE });
    try {
      chmodSync(tmp, FILE_MODE);
      renameSync(tmp, this.path);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        /* the temp file is already gone */
      }
      throw e;
    }
    return merged;
  }

  clear(): void {
    if (this.exists()) unlinkSync(this.path);
  }

  /** True when the config file is readable by group or other. */
  isWorldReadable(): boolean {
    if (!this.exists()) return false;
    try {
      return (statSync(this.path).mode & 0o077) !== 0;
    } catch {
      return false;
    }
  }

  get parentDir(): string {
    return dirname(this.path);
  }
}

/**
 * Token precedence (spec 5.4): `--token` > environment > config file.
 *
 * The flag wins because it is the explicit override, but it is the least safe —
 * `runTool` warns about `ps` visibility whenever it is used.
 */
export function resolveToken(input: {
  toolName: string;
  flagToken?: string | undefined;
  env?: NodeJS.ProcessEnv;
  config?: StoredConfig;
}): ResolvedToken {
  if (input.flagToken) return { token: input.flagToken, source: 'flag' };

  const env = input.env ?? process.env;
  const fromEnv = env[tokenEnvVar(input.toolName)];
  if (fromEnv) return { token: fromEnv, source: 'env' };

  const fromConfig = input.config?.token;
  if (fromConfig) return { token: fromConfig, source: 'config' };

  return { token: undefined, source: 'none' };
}
