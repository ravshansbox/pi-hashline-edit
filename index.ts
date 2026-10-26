import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createEditToolDefinition,
  createReadToolDefinition,
  type ExtensionAPI,
  generateDiffString,
  withFileMutationQueue,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

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

type Op = { text: string; from: number; to: number; check: number[]; body: string[] };

const HEADER = /^\[(.+)#([0-9A-F]{4})\]$/;
const PUT = /^PUT (?:(\d+)(?:\.=(\d+))?|<(\d+)|>(\d+|\$)):$/;

const computeTag = (raw: string): string =>
  createHash('sha256').update(raw).digest('hex').slice(0, 4).toUpperCase();

const header = (path: string, tag: string): string => `[${path}#${tag}]`;

const parsePatch = (input: string) => {
  let section: { path: string; tag: string; ops: Op[] } | undefined;
  let body: string[] | undefined;

  input.split(/\r?\n/).forEach((text) => {
    if (body && text.startsWith('+')) {
      body.push(text.slice(1));
      return;
    }
    const trimmed = text.trim();
    if (trimmed === '') return;

    const header = HEADER.exec(trimmed);
    if (header) {
      if (section) throw new Error('edit one file per call');
      section = { path: header[1]!, tag: header[2]!, ops: [] };
      return;
    }
    const put = PUT.exec(trimmed);
    if (put) {
      if (!section) throw new Error(`"${trimmed}" must follow a [PATH#TAG] header`);
      const [, start, end = start, before, after] = put;
      const n = Number(start ?? before ?? after);
      if (start && n > Number(end)) {
        throw new Error(`Invalid range: start ${start}, end ${end}`);
      }
      const [from, to, check] = start
        ? [n - 1, Number(end), [n, Number(end)]]
        : before
          ? [n - 1, n - 1, n === 1 ? [] : [n]]
          : after === '$'
            ? [Infinity, Infinity, []]
            : [n, n, [n]];
      body = [];
      section.ops.push({ text: trimmed, from, to, check, body });
      return;
    }
    if (body) {
      throw new Error(
        `body rows must start with +; got "${text}". Write a literal leading + or - as ++ or +-`,
      );
    }
    throw new Error(`unknown operation "${trimmed}"`);
  });

  if (!section) throw new Error('No [PATH#TAG] header found');
  if (section.ops.length === 0) throw new Error('No operations found');
  return section;
};

const applyOps = (lines: readonly string[], ops: readonly Op[]): string[] => {
  const sorted = [...ops].sort((a, b) => a.from - b.from || a.to - b.to);
  const out: string[] = [];
  let pos = 0;
  sorted.forEach((op, i) => {
    for (const line of op.check) {
      if (line < 1 || line > lines.length) {
        throw new Error(`Line ${line} does not exist (file has ${lines.length} lines)`);
      }
    }
    const insert = op.from === op.to;
    if (insert && op.body.length === 0) throw new Error('insert has no + rows');
    const previous = sorted[i - 1];
    if (previous && op.from < previous.to) {
      throw new Error(
        insert
          ? `${op.text} falls inside ${previous.text}; put the new lines in that range's body`
          : `${op.text} overlaps ${previous.text}; use one op per range`,
      );
    }
    out.push(...lines.slice(pos, op.from), ...op.body);
    pos = op.to;
  });
  return [...out, ...lines.slice(pos)];
};

const toHashline = (
  output: string,
  raw: string,
  path: string,
  offset: number | undefined,
  limit: number | undefined,
  truncatedLines: number | undefined,
): string => {
  const all = raw.split('\n');
  const start = offset ? Math.max(0, offset - 1) : 0;
  const count = truncatedLines ?? Math.min(limit ?? all.length - start, all.length - start);
  const shown = all.slice(start, start + count);
  const rest = output.slice(shown.join('\n').length);
  const rows = start + count === all.length && raw.endsWith('\n') ? shown.slice(0, -1) : shown;
  const clean = rows.map((row) => (row.endsWith('\r') ? row.slice(0, -1) : row));
  const numbered = clean.map((row, i) => `${start + 1 + i}:${row}`).join('\n');
  return `${header(path, computeTag(raw))}${numbered ? `\n${numbered}` : ''}${rest}`;
};

const headerPath = (args: { input?: unknown } | undefined) => ({
  path: typeof args?.input === 'string' ? /^\s*\[(.+)#/.exec(args.input)?.[1] : undefined,
});

export default function (pi: ExtensionAPI) {
  const builtinRead = createReadToolDefinition(process.cwd());
  const builtinEdit = createEditToolDefinition(process.cwd());

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
      const absolute = resolve(ctx.cwd, params.path);
      let raw: string;
      try {
        raw = await readFile(absolute, 'utf8');
      } catch {
        return result;
      }
      const truncated = truncation?.truncated ? truncation.outputLines : undefined;
      const text = toHashline(first.text, raw, params.path, params.offset, params.limit, truncated);
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
    renderShell: 'self',
    renderCall: (args, theme, context) =>
      builtinEdit.renderCall!(headerPath(args) as never, theme, {
        ...context,
        args: headerPath(context.args),
      } as never),
    renderResult: (result, options, theme, context) =>
      builtinEdit.renderResult!(result as never, options, theme, {
        ...context,
        args: headerPath(context.args),
      } as never),
    async execute(_toolCallId, { input }, _signal, _onUpdate, ctx) {
      const section = parsePatch(input);
      const absolute = resolve(ctx.cwd, section.path);
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
        const eol = raw.includes('\r\n') ? '\r\n' : '\n';
        const lines = raw.split(/\r?\n/);
        const finalNewline = lines.at(-1) === '';
        if (finalNewline) lines.pop();
        const out = applyOps(lines, section.ops);
        const text = out.join(eol) + (finalNewline && out.length > 0 ? eol : '');
        await writeFile(absolute, text, 'utf8');
        return { raw, text };
      });
      const { diff, firstChangedLine } = generateDiffString(
        next.raw.replaceAll('\r\n', '\n'),
        next.text.replaceAll('\r\n', '\n'),
      );
      return {
        content: [{ type: 'text', text: header(section.path, computeTag(next.text)) }],
        details: { diff, firstChangedLine },
      };
    },
  });
}
