import { createHash } from 'node:crypto';

export interface Op {
  text: string;
  from: number;
  to: number;
  check: number[];
  body: string[];
}

export interface Section {
  path: string;
  tag: string;
  ops: Op[];
}

export interface Doc {
  eol: string;
  lines: string[];
  finalNewline: boolean;
}

const HEADER = /^\[(.+)#([0-9A-Fa-f]{4})\]$/;
const PUT = /^PUT (?:(\d+)(?:\.=(\d+))?|<(\d+)|>(\d+|\$)):$/;

export const computeTag = (raw: string): string =>
  createHash('sha256').update(raw).digest('hex').slice(0, 4).toUpperCase();

export const formatHeader = (path: string, tag: string): string => `[${path}#${tag}]`;

export const formatRows = (lines: readonly string[], start: number): string =>
  lines.map((line, i) => `${start + i}:${line}`).join('\n');

export const parseDoc = (raw: string): Doc => {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lf = raw.replaceAll('\r\n', '\n');
  const finalNewline = lf === '' || lf.endsWith('\n');
  const lines = lf === '' ? [] : (finalNewline ? lf.slice(0, -1) : lf).split('\n');
  return { eol, lines, finalNewline };
};

export const serialiseDoc = (doc: Doc): string =>
  doc.lines.join(doc.eol) + (doc.finalNewline && doc.lines.length > 0 ? doc.eol : '');

export const parsePatch = (input: string): Section => {
  let section: Section | undefined;
  let body: string[] | undefined;

  input
    .replaceAll('\r\n', '\n')
    .split('\n')
    .forEach((text) => {
      if (body && text.startsWith('+')) {
        body.push(text.slice(1));
        return;
      }
      const trimmed = text.trim();
      if (trimmed === '') return;

      const header = HEADER.exec(trimmed);
      if (header) {
        if (section) throw new Error('edit one file per call');
        section = { path: header[1]!, tag: header[2]!.toUpperCase(), ops: [] };
        return;
      }
      const put = PUT.exec(trimmed);
      if (put) {
        if (!section) throw new Error(`"${trimmed}" must follow a [PATH#TAG] header`);
        const [, start, end = start, before, after] = put;
        const n = Number(start ?? before ?? after);
        if (start && n > Number(end)) {
          throw new Error(
            `Invalid range: start ${start}, end ${end}. The value after .= is a line number, not a count`,
          );
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

export const applyOps = (lines: readonly string[], ops: readonly Op[]): string[] => {
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
