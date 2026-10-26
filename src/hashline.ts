import { createHash } from 'node:crypto';

export type Op =
  | { kind: 'range'; start: number; end: number; body: string[]; cut: boolean; row: number }
  | { kind: 'insert'; before: boolean; anchor: number | '$'; body: string[]; row: number };

export interface Section {
  path: string;
  tag: string;
  ops: Op[];
  remove: boolean;
  moveTo: string | undefined;
  warnings: string[];
}

export interface Doc {
  bom: string;
  eol: string;
  lines: string[];
  finalNewline: boolean;
}

export interface Applied {
  lines: string[];
  changed: number[];
}

const BOM = '\uFEFF';
const HEADER = /^\[(.+)#([0-9A-Fa-f]{4})\]$/;
const BAD_HEADER = /^\[.+\]$/;
const PUT_RANGE = /^PUT (\d+)(?:\.=(\d+))?:$/;
const PUT_GAP = /^PUT ([<>])(\d+|\$):$/;
const CUT = /^CUT (\d+)(?:\.=(\d+))?$/;
const MV = /^MV (.+)$/;
const PATCH_MARKER = /^\*\*\* (Begin|End) Patch$/;
const UNSUPPORTED = /^(PUT|CUT) .*[*@]/;

export const computeTag = (raw: string): string =>
  createHash('sha256').update(raw).digest('hex').slice(0, 4).toUpperCase();

export const formatHeader = (path: string, tag: string): string => `[${path}#${tag}]`;

export const formatRows = (lines: readonly string[], start: number): string =>
  lines.map((line, i) => `${start + i}:${line}`).join('\n');

export const parseDoc = (raw: string): Doc => {
  const bom = raw.startsWith(BOM) ? BOM : '';
  const text = raw.slice(bom.length);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lf = text.replaceAll('\r\n', '\n');
  const finalNewline = lf === '' || lf.endsWith('\n');
  const lines = lf === '' ? [] : (finalNewline ? lf.slice(0, -1) : lf).split('\n');
  return { bom, eol, lines, finalNewline };
};

export const serialiseDoc = (doc: Doc): string =>
  doc.bom + doc.lines.join(doc.eol) + (doc.finalNewline && doc.lines.length > 0 ? doc.eol : '');

const unquote = (value: string): string => {
  const trimmed = value.trim();
  const quoted = /^(["'])(.*)\1$/.exec(trimmed);
  return quoted ? quoted[2]! : trimmed;
};

export const parsePatch = (input: string): Section[] => {
  const sections: Section[] = [];
  let section: Section | undefined;
  let body: string[] | undefined;
  let ignored = 0;

  const flushIgnored = () => {
    if (section && ignored > 0) {
      section.warnings.push(
        `Ignored ${ignored} \`-\` row(s); ranges already remove the old lines, so only \`+\` rows are written.`,
      );
    }
    ignored = 0;
  };
  const current = (row: number, text: string): Section => {
    if (!section) throw new Error(`line ${row}: "${text}" must follow a [PATH#TAG] header`);
    return section;
  };
  const addOp = (row: number, text: string, op: Op) => {
    const target = current(row, text);
    if (target.remove || target.moveTo !== undefined) {
      throw new Error(`line ${row}: no operations may follow REM or MV in a section`);
    }
    target.ops.push(op);
    body = op.body;
  };

  input
    .replaceAll('\r\n', '\n')
    .split('\n')
    .forEach((text, index) => {
      const row = index + 1;
      if (body && text.startsWith('+')) {
        body.push(text.slice(1));
        return;
      }
      if (body && text.startsWith('-')) {
        ignored++;
        return;
      }
      const trimmed = text.trim();
      if (trimmed === '' || PATCH_MARKER.test(trimmed)) return;

      const header = HEADER.exec(trimmed);
      if (header) {
        flushIgnored();
        section = {
          path: header[1]!,
          tag: header[2]!.toUpperCase(),
          ops: [],
          remove: false,
          moveTo: undefined,
          warnings: [],
        };
        sections.push(section);
        body = undefined;
        return;
      }
      if (BAD_HEADER.test(trimmed)) {
        throw new Error(
          `line ${row}: header "${trimmed}" needs the 4-hex tag from the latest read, as [PATH#TAG]`,
        );
      }

      const range = PUT_RANGE.exec(trimmed);
      if (range) {
        const start = Number(range[1]);
        addOp(row, trimmed, {
          kind: 'range',
          start,
          end: range[2] ? Number(range[2]) : start,
          body: [],
          cut: false,
          row,
        });
        return;
      }
      const gap = PUT_GAP.exec(trimmed);
      if (gap) {
        if (gap[1] === '<' && gap[2] === '$') throw new Error(`line ${row}: use PUT >$: to append`);
        addOp(row, trimmed, {
          kind: 'insert',
          before: gap[1] === '<',
          anchor: gap[2] === '$' ? '$' : Number(gap[2]),
          body: [],
          row,
        });
        return;
      }
      const cut = CUT.exec(trimmed);
      if (cut) {
        const start = Number(cut[1]);
        addOp(row, trimmed, {
          kind: 'range',
          start,
          end: cut[2] ? Number(cut[2]) : start,
          body: [],
          cut: true,
          row,
        });
        body = undefined;
        return;
      }
      if (trimmed === 'REM') {
        const target = current(row, trimmed);
        if (target.ops.length > 0 || target.moveTo !== undefined) {
          throw new Error(`line ${row}: REM must be the only operation in its section`);
        }
        target.remove = true;
        body = undefined;
        return;
      }
      const mv = MV.exec(trimmed);
      if (mv) {
        const target = current(row, trimmed);
        if (target.remove || target.moveTo !== undefined) {
          throw new Error(`line ${row}: a section may have only one REM or MV`);
        }
        target.moveTo = unquote(mv[1]!);
        body = undefined;
        return;
      }
      if (UNSUPPORTED.test(trimmed)) {
        throw new Error(
          `line ${row}: "${trimmed}" is not supported; block ops (N*) and registers (@name) are not available, use line ranges`,
        );
      }
      if (body) {
        throw new Error(
          `line ${row}: body rows must start with +; got "${text}". Write a literal leading + or - as ++ or +-`,
        );
      }
      throw new Error(`line ${row}: unknown operation "${trimmed}"`);
    });
  flushIgnored();

  if (sections.length === 0) throw new Error('No [PATH#TAG] section found');
  for (const s of sections) {
    if (s.ops.length === 0 && !s.remove && s.moveTo === undefined) {
      throw new Error(`${s.path}: section has no operations`);
    }
  }
  return sections;
};

export const applyOps = (
  lines: readonly string[],
  ops: readonly Op[],
  warnings: string[],
): Applied => {
  const count = lines.length;
  const checkLine = (op: Op, line: number) => {
    if (line < 1 || line > count) {
      throw new Error(`line ${op.row}: Line ${line} does not exist (file has ${count} lines)`);
    }
  };

  const ranges = ops.filter((op) => op.kind === 'range').sort((a, b) => a.start - b.start);
  ranges.forEach((r, i) => {
    if (r.start > r.end) {
      throw new Error(
        `line ${r.row}: Invalid range: start ${r.start}, end ${r.end}. The value after .= is a line number, not a count`,
      );
    }
    checkLine(r, r.start);
    checkLine(r, r.end);
    const previous = ranges[i - 1];
    if (previous && r.start <= previous.end) {
      throw new Error(
        `line ${r.row}: range ${r.start}.=${r.end} overlaps range ${previous.start}.=${previous.end} on line ${previous.row}; use one op per range`,
      );
    }
    if (!r.cut && r.body.length === 0) {
      warnings.push(`Treated empty PUT ${r.start}.=${r.end}: as a deletion; use CUT to delete.`);
    }
  });

  const gaps = new Map<number, string[]>();
  for (const op of ops) {
    if (op.kind === 'range') continue;
    if (op.body.length === 0) throw new Error(`line ${op.row}: insert has no + rows`);
    let gap: number;
    if (op.anchor === '$') gap = count;
    else if (op.before && op.anchor === 1 && count === 0) gap = 0;
    else {
      checkLine(op, op.anchor);
      gap = op.before ? op.anchor - 1 : op.anchor;
    }
    const host = ranges.find((r) => r.start <= gap && gap < r.end);
    if (host) {
      throw new Error(
        `line ${op.row}: insert falls inside the range ${host.start}.=${host.end} on line ${host.row}; put the new lines in that range's body`,
      );
    }
    gaps.set(gap, [...(gaps.get(gap) ?? []), ...op.body]);
  }

  const out: string[] = [];
  const changed: number[] = [];
  const emit = (rows: readonly string[]) => {
    for (const row of rows) {
      changed.push(out.length);
      out.push(row);
    }
  };
  const byStart = new Map(ranges.map((r) => [r.start, r]));
  emit(gaps.get(0) ?? []);
  for (let line = 1; line <= count;) {
    const r = byStart.get(line);
    if (r) {
      if (r.body.length === 0) changed.push(out.length);
      emit(r.body);
      emit(gaps.get(r.end) ?? []);
      line = r.end + 1;
      continue;
    }
    out.push(lines[line - 1]!);
    emit(gaps.get(line) ?? []);
    line++;
  }
  return { lines: out, changed };
};

export const formatChanges = (lines: readonly string[], changed: readonly number[]): string => {
  const shown = new Set<number>();
  for (const index of changed) {
    for (let k = index - 2; k <= index + 2; k++) {
      if (k >= 0 && k < lines.length) shown.add(k);
    }
  }
  return [...shown]
    .sort((a, b) => a - b)
    .map((k) => `${k + 1}:${lines[k]}`)
    .join('\n');
};
