import { createHash } from 'node:crypto';

export type Op =
  | { kind: 'range'; start: number; end: number; body: string[] }
  | { kind: 'insert'; before: boolean; anchor: number | '$'; body: string[] };

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
const BAD_HEADER = /^\[.+\]$/;
const PUT_RANGE = /^PUT (\d+)(?:\.=(\d+))?:$/;
const PUT_GAP = /^PUT ([<>])(\d+|\$):$/;

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
  const addOp = (text: string, op: Op) => {
    if (!section) throw new Error(`"${text}" must follow a [PATH#TAG] header`);
    section.ops.push(op);
    body = op.body;
  };

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
      if (BAD_HEADER.test(trimmed)) {
        throw new Error(
          `header "${trimmed}" needs the 4-hex tag from the latest read, as [PATH#TAG]`,
        );
      }

      const range = PUT_RANGE.exec(trimmed);
      if (range) {
        const start = Number(range[1]);
        addOp(trimmed, {
          kind: 'range',
          start,
          end: range[2] ? Number(range[2]) : start,
          body: [],
        });
        return;
      }
      const gap = PUT_GAP.exec(trimmed);
      if (gap) {
        if (gap[1] === '<' && gap[2] === '$') throw new Error('use PUT >$: to append');
        addOp(trimmed, {
          kind: 'insert',
          before: gap[1] === '<',
          anchor: gap[2] === '$' ? '$' : Number(gap[2]),
          body: [],
        });
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
  const count = lines.length;
  const checkLine = (line: number) => {
    if (line < 1 || line > count) {
      throw new Error(`Line ${line} does not exist (file has ${count} lines)`);
    }
  };

  const ranges = ops.filter((op) => op.kind === 'range').sort((a, b) => a.start - b.start);
  ranges.forEach((r, i) => {
    if (r.start > r.end) {
      throw new Error(
        `Invalid range: start ${r.start}, end ${r.end}. The value after .= is a line number, not a count`,
      );
    }
    checkLine(r.start);
    checkLine(r.end);
    const previous = ranges[i - 1];
    if (previous && r.start <= previous.end) {
      throw new Error(
        `range ${r.start}.=${r.end} overlaps range ${previous.start}.=${previous.end}; use one op per range`,
      );
    }
  });

  const gaps = new Map<number, string[]>();
  for (const op of ops) {
    if (op.kind === 'range') continue;
    if (op.body.length === 0) throw new Error('insert has no + rows');
    let gap: number;
    if (op.anchor === '$') gap = count;
    else if (op.before && op.anchor === 1 && count === 0) gap = 0;
    else {
      checkLine(op.anchor);
      gap = op.before ? op.anchor - 1 : op.anchor;
    }
    const host = ranges.find((r) => r.start <= gap && gap < r.end);
    if (host) {
      throw new Error(
        `insert falls inside the range ${host.start}.=${host.end}; put the new lines in that range's body`,
      );
    }
    gaps.set(gap, [...(gaps.get(gap) ?? []), ...op.body]);
  }

  const out: string[] = [...(gaps.get(0) ?? [])];
  const byStart = new Map(ranges.map((r) => [r.start, r]));
  for (let line = 1; line <= count;) {
    const r = byStart.get(line);
    if (r) {
      out.push(...r.body, ...(gaps.get(r.end) ?? []));
      line = r.end + 1;
      continue;
    }
    out.push(lines[line - 1]!, ...(gaps.get(line) ?? []));
    line++;
  }
  return out;
};
