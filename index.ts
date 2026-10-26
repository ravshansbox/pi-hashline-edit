import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
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

const EDIT_DESCRIPTION = `Hashline patch for one existing file; create new files with write. The patch starts with [PATH#TAG], where TAG is the 4-hex tag from the latest read of that file. Line numbers are the N:LINE numbers from that read, never shifted by earlier ops in the same patch.

Ops:
- PUT N.=M: replaces lines N to M (inclusive) with the + body; no body deletes them. PUT N: is short for PUT N.=N:.
- PUT <N: inserts before line N, PUT >N: inserts after line N, PUT >$: appends.

Rules:
- Body rows start with +. A lone + writes a blank line. The rest of the row is written verbatim, including indentation. Write a literal leading + or - as ++ or +-.
- Never send - rows, bare context or unchanged lines. Body length does not have to match the range.
- Touch only changed lines. Split non-adjacent changes into separate ops. Use gap inserts for pure additions.
- Ranges must not overlap and inserts must not fall inside a range.
- After every edit the tag and line numbers change: read again before the next edit. If a tag is rejected, stop and read again.

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

const displayPath = (absolute: string, cwd: string): string => {
  const rel = relative(cwd, absolute);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : absolute;
};

const textOf = (content: readonly { type: string; text?: string }[]): string | undefined => {
  if (content.length !== 1 || content[0]?.type !== 'text') return undefined;
  return content[0].text;
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
      const output = textOf(result.content);
      const details = result.details as
        | {
            truncation?: {
              truncated?: boolean;
              firstLineExceedsLimit?: boolean;
              outputLines?: number;
            };
          }
        | undefined;
      if (output === undefined || details?.truncation?.firstLineExceedsLimit) return result;
      const absolute = resolvePath(params.path, ctx.cwd);
      let raw: string;
      try {
        raw = await readFile(absolute, 'utf8');
      } catch {
        return result;
      }
      const truncated = details?.truncation?.truncated ? details.truncation.outputLines : undefined;
      const text = toHashline(
        output,
        raw,
        displayPath(absolute, ctx.cwd),
        params.offset,
        params.limit,
        truncated,
      );
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
    promptGuidelines: [
      'Read a file before editing it with edit, and copy its [PATH#TAG] header exactly.',
      'Use edit line numbers from the latest read only; read again after every edit.',
    ],
    parameters: Type.Object({
      input: Type.String({
        description: 'Hashline patch: a [PATH#TAG] header followed by ops',
      }),
    }),
    executionMode: 'sequential',
    async execute(_toolCallId, { input }, signal, _onUpdate, ctx) {
      const section = parsePatch(input);
      const absolute = resolvePath(section.path, ctx.cwd);
      let raw: string;
      try {
        raw = await readFile(absolute, 'utf8');
      } catch {
        throw new Error(`File not found: ${section.path}. Use the write tool to create new files.`);
      }
      if (computeTag(raw) !== section.tag) {
        throw new Error(
          `Edit rejected for ${section.path}: the file changed since it was read (#${section.tag} is not its current tag). Read it again, then retry.`,
        );
      }
      const doc = parseDoc(raw);
      const lines = applyOps(doc.lines, section.ops);
      const next = serialiseDoc({ ...doc, lines });
      if (signal?.aborted) throw new Error('Operation aborted');
      await withFileMutationQueue(absolute, () => writeFile(absolute, next, 'utf8'));
      return {
        content: [{ type: 'text', text: formatHeader(section.path, computeTag(next)) }],
        details: undefined,
      };
    },
  });
}
