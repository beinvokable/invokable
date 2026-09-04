import { createInterface } from 'node:readline/promises';

export interface Prompter {
  text: (question: string, fallback: string) => Promise<string>;
  confirm: (question: string, fallback: boolean) => Promise<boolean>;
  choice: <T extends string>(question: string, options: readonly T[], fallback: T) => Promise<T>;
  close: () => void;
}

/** Answers every prompt with its default; used by `--yes` and by tests. */
export function nonInteractivePrompter(): Prompter {
  return {
    text: async (_q, fallback) => fallback,
    confirm: async (_q, fallback) => fallback,
    choice: async (_q, _o, fallback) => fallback,
    close: () => {},
  };
}

/**
 * Prompts on stderr and reads stdin, so that scaffolding can be piped without
 * the questions contaminating whatever the caller is capturing.
 */
export function terminalPrompter(): Prompter {
  const rl = createInterface({ input: process.stdin, output: process.stderr });

  return {
    async text(question, fallback) {
      const answer = (await rl.question(`${question} (${fallback}) `)).trim();
      return answer || fallback;
    },
    async confirm(question, fallback) {
      const hint = fallback ? 'Y/n' : 'y/N';
      const answer = (await rl.question(`${question} [${hint}] `)).trim();
      if (!answer) return fallback;
      return /^y(es)?$/i.test(answer);
    },
    async choice(question, options, fallback) {
      const list = options.map((o, i) => `  ${i + 1}) ${o}${o === fallback ? '  (default)' : ''}`);
      const answer = (
        await rl.question(`${question}\n${list.join('\n')}\n> `)
      ).trim();
      if (!answer) return fallback;

      const byIndex = Number(answer);
      if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= options.length) {
        return options[byIndex - 1]!;
      }
      const byName = options.find((o) => o.toLowerCase() === answer.toLowerCase());
      return byName ?? fallback;
    },
    close: () => rl.close(),
  };
}
