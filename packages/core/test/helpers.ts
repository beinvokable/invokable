import { Writable } from 'node:stream';
import { runTool, type RunResult } from '../src/run.js';
import type { DefinedTool } from '../src/schema.js';

export class Capture extends Writable {
  chunks: string[] = [];
  override _write(chunk: unknown, _enc: unknown, cb: () => void): void {
    this.chunks.push(String(chunk));
    cb();
  }
  get text(): string {
    return this.chunks.join('');
  }
}

export interface Invocation extends RunResult {
  stdout: string;
  stderr: string;
  /** Parses stdout as the single JSON document. Throws if it is not exactly one. */
  json(): unknown;
}

export async function invoke(tool: DefinedTool, argv: string[]): Promise<Invocation> {
  const stdout = new Capture();
  const stderr = new Capture();
  const result = await runTool(tool, { argv, streams: { stdout, stderr } });
  return {
    ...result,
    stdout: stdout.text,
    stderr: stderr.text,
    json() {
      const trimmed = stdout.text.trim();
      if (trimmed === '') throw new Error('stdout was empty; expected one JSON document');
      const lines = trimmed.split('\n').filter(Boolean);
      if (lines.length !== 1) {
        throw new Error(`stdout had ${lines.length} lines; expected exactly one JSON document`);
      }
      return JSON.parse(lines[0]!);
    },
  };
}
