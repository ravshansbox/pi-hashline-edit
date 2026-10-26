import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  createReadToolDefinition,
  type ExtensionAPI,
  withFileMutationQueue,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  applyOps,
  computeTag,
  formatHeader,
  formatRows,
  parseDoc,
  parsePatch,
  serialiseDoc,
} from './src/hashline.ts';

const EDIT_DESCRIPTION = `Hashline patch for one existing file; create new files with write. Start with the [PATH#TAG] header from the latest read. Line numbers are from that read and are not shifted by earlier ops.

- PUT N.=M: replaces lines N to M with the + body; no body deletes them. PUT N: means PUT N.=N:.
- PUT <N: inserts before line N, PUT >N: after it, PUT >$: at the end.
- Each body row is + followed by the line verbatim; a lone + is a blank line. No - rows or context.
- Change only the lines you need. Ranges must not overlap and inserts must not fall inside a range.
- Read again after every edit or rejected tag.

Example:
[src/app.py#1A2B]
PUT 3.=4:
+def greet(name):
+    print(name)
PUT >$:
+greet("world")`;

const resolvePath = (path: string, cwd: string): string => {
  const clean = path.startsWith('@') ? path.slice(1) : path;
  if (clean === '~') return homedir();
  if (clean.startsWith('~/')) return resolve(homedir(), clean.slice(2));
  return resolve(cwd, clean);
};

const toHashline = (
  output: string,
  raw: string,
  path: string,
  offset: number | undefined,
  limit: number | undefined,
  truncatedLines: number | undefined,
): string | undefined => {
  const all = raw.split('\n');
  const start = offset ? Math.max(0, offset - 1) : 0;
  const count = truncatedLines ?? Math.min(limit ?? all.length - start, all.length - start);
  const shown = all.slice(start, start + count);
  const body = shown.join('\n');
  if (!output.startsWith(body)) return undefined;
  const rest = output.slice(body.length);
  const rows = start + count === all.length && raw.endsWith('\n') ? shown.slice(0, -1) : shown;
  const clean = rows.map((row) => (row.endsWith('\r') ? row.slice(0, -1) : row));
  const numbered = formatRows(clean, start + 1);
  return `${formatHeader(path, computeTag(raw))}${numbered ? `\n${numbered}` : ''}${rest}`;
};

export default function (pi: ExtensionAPI) {
  const builtinRead = createReadToolDefinition(process.cwd());

  pi.registerTool({
    ...builtinRead,
    description: `${builtinRead.description} Text output starts with a [PATH#TAG] header and prefixes each line with N:. The prefixes are not part of the file. Pass the header and line numbers to edit.`,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = await builtinRead.execute(toolCallId, params, signal, onUpdate, ctx);
      const [first, ...others] = result.content;
      const truncation = result.details?.truncation;
      if (first?.type !== 'text' || others.length > 0 || truncation?.firstLineExceedsLimit) {
        return result;
      }
      const absolute = resolvePath(params.path, ctx.cwd);
      let raw: string;
      try {
        raw = await readFile(absolute, 'utf8');
      } catch {
        return result;
      }
      const truncated = truncation?.truncated ? truncation.outputLines : undefined;
      const text = toHashline(first.text, raw, params.path, params.offset, params.limit, truncated);
      if (text === undefined) return result;
      return { ...result, content: [{ type: 'text', text }], structuredContent: text };
    },
  });

  pi.registerTool({
    name: 'edit',
    label: 'edit',
    description: EDIT_DESCRIPTION,
    promptSnippet:
      'Edit files with hashline patches anchored on [PATH#TAG] headers and N: line numbers from read',
    parameters: Type.Object({
      input: Type.String({
        description: 'Hashline patch: a [PATH#TAG] header followed by ops',
      }),
    }),
    executionMode: 'sequential',
    async execute(_toolCallId, { input }, signal, _onUpdate, ctx) {
      const section = parsePatch(input);
      const absolute = resolvePath(section.path, ctx.cwd);
      const next = await withFileMutationQueue(absolute, async () => {
        let raw: string;
        try {
          raw = await readFile(absolute, 'utf8');
        } catch {
          throw new Error(
            `File not found: ${section.path}. Use the write tool to create new files.`,
          );
        }
        if (computeTag(raw) !== section.tag) {
          throw new Error(
            `Edit rejected for ${section.path}: the file changed since it was read (#${section.tag} is not its current tag). Read it again, then retry.`,
          );
        }
        const doc = parseDoc(raw);
        const lines = applyOps(doc.lines, section.ops);
        const text = serialiseDoc({ ...doc, lines });
        if (signal?.aborted) throw new Error('Operation aborted');
        await writeFile(absolute, text, 'utf8');
        return text;
      });
      return {
        content: [{ type: 'text', text: formatHeader(section.path, computeTag(next)) }],
        details: undefined,
      };
    },
  });
}
