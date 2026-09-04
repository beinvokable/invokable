import type { Envelope } from './envelope.js';
import { serializeEnvelope } from './envelope.js';

export interface Streams {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

/**
 * Owns the stdout/stderr split that the agent contract depends on:
 *
 *   stdout — exactly one JSON document, and nothing else, in `--json` mode.
 *   stderr — every log, warning, prompt and progress line, always.
 *
 * The split is enforced, not merely documented: while a command runs in `--json`
 * mode, `process.stdout.write` is diverted to stderr so that a stray
 * `console.log` — in the tool's own code or in any dependency — cannot corrupt
 * the document the agent is about to parse.
 */
export class Io {
  readonly json: boolean;
  private readonly streams: Streams;
  private emitted = false;
  /** The real stdout writer, captured before any diversion is installed. */
  private readonly rawStdoutWrite: (chunk: string) => void;

  constructor(opts: { json: boolean; streams?: Partial<Streams> }) {
    this.json = opts.json;
    this.streams = {
      stdout: opts.streams?.stdout ?? process.stdout,
      stderr: opts.streams?.stderr ?? process.stderr,
    };
    // Bind the writer NOW, before any diversion is installed by guardStdout().
    // Looking `.write` up lazily would resolve to the diverted function and
    // send the envelope to stderr.
    const out = this.streams.stdout;
    const boundWrite = out.write.bind(out) as (chunk: string) => boolean;
    this.rawStdoutWrite = (chunk: string) => {
      boundWrite(chunk);
    };
  }

  /** Human-facing progress. Never parsed by an agent; always stderr. */
  note(message: string): void {
    this.streams.stderr.write(message.endsWith('\n') ? message : message + '\n');
  }

  warn(message: string): void {
    this.note(message);
  }

  /**
   * Write the single stdout document. Calling twice is a programming error:
   * two JSON documents on stdout is exactly the corruption this class exists
   * to prevent.
   */
  emit(env: Envelope): void {
    if (this.emitted) {
      throw new Error(
        'Io.emit() called twice: a command must produce exactly one stdout envelope.',
      );
    }
    this.emitted = true;
    this.rawStdoutWrite(serializeEnvelope(env));
  }

  get hasEmitted(): boolean {
    return this.emitted;
  }

  /**
   * Run `fn` with stdout diverted to stderr. Restores the original writer even
   * if `fn` throws. No-op when not in `--json` mode, where interleaved human
   * output on stdout is harmless.
   */
  async guardStdout<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.json) return fn();

    // Patch the global writer even when streams are injected: a stray
    // `console.log` reaches `process.stdout` regardless of where the envelope
    // is destined, and it must be diverted to this Io's stderr either way.
    const original = process.stdout.write.bind(process.stdout);
    const stderr = this.streams.stderr;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (
      chunk: string | Uint8Array,
      encoding?: unknown,
      cb?: unknown,
    ): boolean => {
      stderr.write(chunk as never);
      const done = typeof encoding === 'function' ? encoding : cb;
      if (typeof done === 'function') (done as () => void)();
      return true;
    };

    try {
      return await fn();
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).write = original;
    }
  }
}
