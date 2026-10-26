import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  createReadToolDefinition,
  type ExtensionAPI,
  generateDiffString,
  renderDiff,
  withFileMutationQueue,
} from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import {
  applyOps,
  computeTag,
  formatChanges,
  formatHeader,
  formatRows,
  parseDoc,
  parsePatch,
  serialiseDoc,
} from './src/hashline.ts';

interface EditDetails {
  files: { path: string; diff: string }[];
}

interface Plan {
  path: string;
  absolute: string;
  raw: string;
  next: string | undefined;
  moveTo: { path: string; absolute: string } | undefined;
  text: string;
  diff: string;
}

const EDIT_DESCRIPTION = `Hashline patches for existing files; create new files with write. Each file section starts with [PATH#TAG], where TAG is the 4-hex tag from the latest read or edit response of that file. Line numbers are the original N:LINE numbers from that output, never shifted by earlier ops in the same section.

Ops:
- PUT N.=M: replaces lines N to M (inclusive) with the + body. PUT N: is short for PUT N.=N:.
- PUT <N: inserts before line N, PUT >N: inserts after line N, PUT >$: appends.
- CUT N.=M (or CUT N) deletes lines.
- REM deletes the file. MV DEST moves it after the section's other ops (quote paths with spaces).

Rules:
- Body rows start with +. A lone + writes a blank line. The rest of the row is written verbatim, including indentation. Write a literal leading + or - as ++ or +-.
- Never send - rows, bare context or unchanged lines. Body length does not have to match the range.
- Touch only changed lines. Split non-adjacent changes into separate ops. Use gap inserts for pure additions.
- Ranges must not overlap and inserts must not fall inside a range.
- After every edit the tag and line numbers change: use the header and rows from the edit response, or read again. If a tag is rejected, stop and read again.

Example:
[src/app.py#1A2B]
PUT 3.=4:
+def greet(name):
+    print(name)
PUT >$:
+greet("world")
[README.md#3C4D]
PUT <1:
+# Title`;

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
  const clean = rows.map((row, i) => {
    const line = row.endsWith('\r') ? row.slice(0, -1) : row;
    return start + i === 0 && line.startsWith('\uFEFF') ? line.slice(1) : line;
  });
  const numbered = formatRows(clean, start + 1);
  return `${formatHeader(path, computeTag(raw))}${numbered ? `\n${numbered}` : ''}${rest}`;
};

const describeFailure = (path: string, error: unknown): Error =>
  new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);

const plan = async (input: string, cwd: string): Promise<Plan[]> => {
  const sections = parsePatch(input);
  const claimed = new Set<string>();
  const plans: Plan[] = [];
  for (const section of sections) {
    const absolute = resolvePath(section.path, cwd);
    if (claimed.has(absolute)) {
      throw new Error(`${section.path}: appears in more than one section; merge them into one`);
    }
    claimed.add(absolute);

    let raw: string;
    try {
      raw = await readFile(absolute, 'utf8');
    } catch {
      throw new Error(`File not found: ${section.path}. Use the write tool to create new files.`);
    }
    if (computeTag(raw) !== section.tag) {
      throw new Error(
        `Edit rejected for ${section.path}: the file changed since it was read (#${section.tag} is not its current tag). Use the header from the last edit response for this file, or read it again, then retry.`,
      );
    }

    if (section.remove) {
      plans.push({
        path: section.path,
        absolute,
        raw,
        next: undefined,
        moveTo: undefined,
        text: `Deleted ${section.path}`,
        diff: generateDiffString(parseDoc(raw).lines.join('\n'), '').diff,
      });
      continue;
    }

    const doc = parseDoc(raw);
    let applied;
    try {
      applied = applyOps(doc.lines, section.ops, section.warnings);
    } catch (error) {
      throw describeFailure(section.path, error);
    }
    const next = serialiseDoc({ ...doc, lines: applied.lines });

    let moveTo: Plan['moveTo'];
    if (section.moveTo !== undefined) {
      const target = resolvePath(section.moveTo, cwd);
      if (claimed.has(target))
        throw new Error(`${section.path}: MV target ${section.moveTo} is also edited`);
      const exists = await access(target).then(
        () => true,
        () => false,
      );
      if (exists) throw new Error(`${section.path}: MV target ${section.moveTo} already exists`);
      claimed.add(target);
      moveTo = { path: section.moveTo, absolute: target };
    }

    const shownPath = moveTo?.path ?? section.path;
    const parts = [formatHeader(shownPath, computeTag(next))];
    if (moveTo) parts.push(`Moved to ${moveTo.path}`);
    const changes = formatChanges(applied.lines, applied.changed);
    if (changes) parts.push(changes);
    let text = parts.join('\n');
    if (section.warnings.length > 0) text += `\n\nWarnings:\n${section.warnings.join('\n')}`;

    plans.push({
      path: section.path,
      absolute,
      raw,
      next,
      moveTo,
      text,
      diff: generateDiffString(doc.lines.join('\n'), applied.lines.join('\n')).diff,
    });
  }
  return plans;
};

const commit = (item: Plan): Promise<void> =>
  withFileMutationQueue(item.absolute, async () => {
    const current = await readFile(item.absolute, 'utf8');
    if (current !== item.raw) {
      throw new Error(
        `Edit rejected for ${item.path}: the file changed during the edit. Read it again.`,
      );
    }
    if (item.next === undefined) {
      await rm(item.absolute);
      return;
    }
    if (item.moveTo) {
      await mkdir(dirname(item.moveTo.absolute), { recursive: true });
      await writeFile(item.moveTo.absolute, item.next, 'utf8');
      await rm(item.absolute);
      return;
    }
    await writeFile(item.absolute, item.next, 'utf8');
  });

const headerPaths = (input: unknown): string[] =>
  typeof input === 'string'
    ? [...input.matchAll(/^\s*\[(.+)#[0-9A-Fa-f]{0,4}\]?\s*$/gm)].map((m) => m[1]!)
    : [];

export default function hashlineEdit(pi: ExtensionAPI) {
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
      'Use edit line numbers from the latest read or edit response only; they change after every edit.',
    ],
    parameters: Type.Object({
      input: Type.String({
        description: 'Hashline patch: one or more [PATH#TAG] sections, each followed by ops',
      }),
    }),
    executionMode: 'sequential',
    async execute(_toolCallId, { input }, signal, _onUpdate, ctx) {
      const plans = await plan(input, ctx.cwd);
      for (const item of plans) {
        if (signal?.aborted) throw new Error('Operation aborted');
        await commit(item);
      }
      return {
        content: [{ type: 'text', text: plans.map((p) => p.text).join('\n\n') }],
        details: {
          files: plans.map((p) => ({ path: p.moveTo?.path ?? p.path, diff: p.diff })),
        } satisfies EditDetails,
      };
    },
    renderCall(args, theme) {
      const paths = headerPaths(args.input);
      const label = paths.length > 0 ? ` ${theme.fg('accent', paths.join(', '))}` : '';
      return new Text(`${theme.fg('toolTitle', theme.bold('edit'))}${label}`, 0, 0);
    },
    renderResult(result, _options, theme, context) {
      if (context.isError) {
        return new Text(theme.fg('error', textOf(result.content) ?? ''), 0, 0);
      }
      const files = (result.details as EditDetails | undefined)?.files ?? [];
      const body = files
        .map((file) =>
          files.length > 1
            ? `${theme.fg('accent', file.path)}\n${renderDiff(file.diff)}`
            : renderDiff(file.diff),
        )
        .join('\n\n');
      return new Text(body, 0, 0);
    },
  });
}
