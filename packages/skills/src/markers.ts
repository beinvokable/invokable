/**
 * Generated files are regenerated whenever the tool schema changes, so anything
 * a developer writes by hand has to survive that. Two marker pairs make it:
 *
 *   <!-- invokable:custom --> … <!-- /invokable:custom -->
 *     Inside a generated file. Content is carried across regeneration.
 *
 *   <!-- invokable:begin <tool> --> … <!-- invokable:end <tool> -->
 *     Around our section of a shared file such as AGENTS.md, so we can update
 *     just that region and never touch the rest of someone's file.
 */

const CUSTOM_OPEN = '<!-- invokable:custom -->';
const CUSTOM_CLOSE = '<!-- /invokable:custom -->';

export function beginMarker(tool: string): string {
  return `<!-- invokable:begin ${tool} -->`;
}
export function endMarker(tool: string): string {
  return `<!-- invokable:end ${tool} -->`;
}

/** Extracts custom blocks in document order. */
export function extractCustomBlocks(content: string): string[] {
  const blocks: string[] = [];
  let index = 0;
  for (;;) {
    const open = content.indexOf(CUSTOM_OPEN, index);
    if (open === -1) break;
    const close = content.indexOf(CUSTOM_CLOSE, open);
    if (close === -1) break;
    blocks.push(content.slice(open + CUSTOM_OPEN.length, close).trim());
    index = close + CUSTOM_CLOSE.length;
  }
  return blocks;
}

/**
 * Re-inserts previously extracted blocks into freshly generated content,
 * matching them to placeholders in order. Extra blocks are appended rather than
 * dropped: losing a developer's edits silently is worse than an odd layout.
 */
export function restoreCustomBlocks(generated: string, blocks: string[]): string {
  if (blocks.length === 0) return generated;

  let result = generated;
  let used = 0;
  for (;;) {
    const open = result.indexOf(CUSTOM_OPEN, used === 0 ? 0 : result.indexOf(CUSTOM_CLOSE) + 1);
    if (open === -1 || used >= blocks.length) break;
    const close = result.indexOf(CUSTOM_CLOSE, open);
    if (close === -1) break;
    const body = blocks[used] ?? '';
    const replacement = `${CUSTOM_OPEN}\n${body ? body + '\n' : ''}${CUSTOM_CLOSE}`;
    result = result.slice(0, open) + replacement + result.slice(close + CUSTOM_CLOSE.length);
    used += 1;
  }

  if (used < blocks.length) {
    const leftover = blocks.slice(used).filter(Boolean);
    if (leftover.length) {
      result +=
        `\n\n${CUSTOM_OPEN}\n` +
        leftover.join('\n\n') +
        `\n${CUSTOM_CLOSE}\n`;
    }
  }
  return result;
}

export function emptyCustomBlock(hint: string): string {
  return `${CUSTOM_OPEN}\n<!-- ${hint} -->\n${CUSTOM_CLOSE}`;
}

/**
 * Replaces our marked region of a shared file, or appends it when absent.
 * Content outside the markers is returned untouched.
 */
export function upsertSection(existing: string, tool: string, section: string): string {
  const begin = beginMarker(tool);
  const end = endMarker(tool);
  const block = `${begin}\n${section.trim()}\n${end}`;

  const start = existing.indexOf(begin);
  const stop = existing.indexOf(end);

  if (start !== -1 && stop !== -1 && stop > start) {
    return existing.slice(0, start) + block + existing.slice(stop + end.length);
  }
  const base = existing.trimEnd();
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}
