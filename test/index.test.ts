import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import extension from '../index.ts';

type Result = { content: { type: string; text?: string }[]; details?: any };
type Tool = { name: string; execute: (...args: unknown[]) => Promise<Result> };

const setup = (files: Record<string, string>) => {
  const cwd = mkdtempSync(join(tmpdir(), 'hashline-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(cwd, name), text);
  const tools = new Map<string, Tool>();
  extension({ registerTool: (tool: Tool) => tools.set(tool.name, tool) } as never);
  const ctx = { cwd };
  const call = async (name: string, params: unknown) => {
    const result = await tools.get(name)!.execute('id', params, undefined, undefined, ctx);
    return result.content.map((c) => c.text ?? '').join('\n');
  };
  const read = (path: string, extra: object = {}) => call('read', { path, ...extra });
  const edit = (input: string) => call('edit', { input });
  const file = (name: string) => readFileSync(join(cwd, name), 'utf8');
  const exists = (name: string) => existsSync(join(cwd, name));
  const tagOf = async (path: string) => /#([0-9A-F]{4})\]/.exec(await read(path))![1]!;
  return { read, edit, file, exists, tagOf };
};

test('read shows a header with a tag and numbered lines', async () => {
  const { read } = setup({ 'a.txt': 'one\ntwo\n' });
  assert.match(await read('a.txt'), /^\[a\.txt#[0-9A-F]{4}\]\n1:one\n2:two$/);
});

test('read numbers lines from the offset and keeps the continuation notice', async () => {
  const { read } = setup({ 'a.txt': 'one\ntwo\nthree\nfour\n' });
  const text = await read('a.txt', { offset: 2, limit: 2 });
  assert.match(
    text,
    /^\[a\.txt#[0-9A-F]{4}\]\n2:two\n3:three\n\n\[\d+ more lines in file\. Use offset=4 to continue\.\]$/,
  );
});

test('the tag changes when the file changes', async () => {
  const { tagOf, edit } = setup({ 'a.txt': 'one\n' });
  const before = await tagOf('a.txt');
  await edit(`[a.txt#${before}]\nPUT 1.=1:\n+uno`);
  assert.notEqual(await tagOf('a.txt'), before);
});

test('PUT replaces a range and inserts before, after and at the end', async () => {
  const { tagOf, edit, file } = setup({ 'a.txt': 'one\ntwo\nthree\nfour\nfive\n' });
  const tag = await tagOf('a.txt');
  await edit(`[a.txt#${tag}]\nPUT 2.=3:\n+TWO\n+THREE\n+extra\nPUT >5:\n+six\nPUT <1:\n+zero`);
  assert.equal(file('a.txt'), 'zero\none\nTWO\nTHREE\nextra\nfour\nfive\nsix\n');
});

test('line numbers always refer to the file as read', async () => {
  const { tagOf, edit, file } = setup({ 'a.txt': '1\n2\n3\n4\n' });
  const tag = await tagOf('a.txt');
  await edit(`[a.txt#${tag}]\nPUT 1:\n+a\n+b\n+c\nPUT 4:\n+d`);
  assert.equal(file('a.txt'), 'a\nb\nc\n2\n3\nd\n');
});

test('inserts at the same gap keep their order', async () => {
  const { tagOf, edit, file } = setup({ 'a.txt': '1\n2\n3\n4\n' });
  const tag = await tagOf('a.txt');
  await edit(`[a.txt#${tag}]\nPUT >3:\n+a\nPUT 4.=4:\n+b\nPUT <4:\n+c\nPUT >$:\n+end`);
  assert.equal(file('a.txt'), '1\n2\n3\na\nc\nb\nend\n');
});

test('CUT deletes lines', async () => {
  const { tagOf, edit, file } = setup({ 'a.txt': '1\n2\n3\n4\n' });
  const tag = await tagOf('a.txt');
  await edit(`[a.txt#${tag}]\nCUT 2.=3\nCUT 4`);
  assert.equal(file('a.txt'), '1\n');
});

test('a lone + writes a blank line and ++ writes a literal +', async () => {
  const { tagOf, edit, file } = setup({ 'a.txt': '1\n' });
  const tag = await tagOf('a.txt');
  await edit(`[a.txt#${tag}]\nPUT 1:\n+  indented\n+\n++ plus\n+- minus`);
  assert.equal(file('a.txt'), '  indented\n\n+ plus\n- minus\n');
});

test('the response carries the new header and the changed lines', async () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
  const { tagOf, edit } = setup({ 'a.txt': `${lines}\n` });
  const tag = await tagOf('a.txt');
  const text = await edit(`[a.txt#${tag}]\nPUT 20:\n+TWENTY`);
  const newTag = await tagOf('a.txt');
  assert.equal(
    text,
    `[a.txt#${newTag}]\n18:line 18\n19:line 19\n20:TWENTY\n21:line 21\n22:line 22`,
  );
});

test('a stale tag is rejected and the file is left alone', async () => {
  const { tagOf, edit, file } = setup({ 'a.txt': 'one\n' });
  const tag = await tagOf('a.txt');
  await edit(`[a.txt#${tag}]\nPUT 1:\n+uno`);
  await assert.rejects(edit(`[a.txt#${tag}]\nPUT 1:\n+eins`), /changed since it was read/);
  assert.equal(file('a.txt'), 'uno\n');
});

test('an error in one section leaves every file alone', async () => {
  const { tagOf, edit, file } = setup({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  const a = await tagOf('a.txt');
  const b = await tagOf('b.txt');
  await assert.rejects(
    edit(`[a.txt#${a}]\nPUT 1:\n+A\n[b.txt#${b}]\nPUT 9:\n+B`),
    /Line 9 does not exist/,
  );
  assert.equal(file('a.txt'), 'a\n');
});

test('one call edits several files', async () => {
  const { tagOf, edit, file } = setup({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  const a = await tagOf('a.txt');
  const b = await tagOf('b.txt');
  await edit(`*** Begin Patch\n[a.txt#${a}]\nPUT 1:\n+A\n[b.txt#${b}]\nPUT 1:\n+B\n*** End Patch`);
  assert.equal(file('a.txt') + file('b.txt'), 'A\nB\n');
});

test('overlapping ranges are rejected', async () => {
  const { tagOf, edit } = setup({ 'a.txt': '1\n2\n3\n4\n5\n' });
  const tag = await tagOf('a.txt');
  await assert.rejects(edit(`[a.txt#${tag}]\nPUT 2.=4:\n+a\nPUT 3.=5:\n+b`), /overlap/);
});

test('an insert inside a replaced range is rejected', async () => {
  const { tagOf, edit } = setup({ 'a.txt': '1\n2\n3\n' });
  const tag = await tagOf('a.txt');
  await assert.rejects(edit(`[a.txt#${tag}]\nPUT 1.=3:\n+a\nPUT >2:\n+b`), /inside/);
});

test('a backwards range is rejected', async () => {
  const { tagOf, edit } = setup({ 'a.txt': '1\n2\n' });
  const tag = await tagOf('a.txt');
  await assert.rejects(edit(`[a.txt#${tag}]\nPUT 2.=1:\n+x`), /start 2, end 1/);
});

test('rows that are neither + nor - are rejected', async () => {
  const { tagOf, edit } = setup({ 'a.txt': '1\n' });
  const tag = await tagOf('a.txt');
  await assert.rejects(edit(`[a.txt#${tag}]\nPUT 1:\n+ok\nfoo`), /must start with \+/);
});

test('- rows are ignored with a warning', async () => {
  const { tagOf, edit, file } = setup({ 'a.txt': 'old\n' });
  const tag = await tagOf('a.txt');
  const text = await edit(`[a.txt#${tag}]\nPUT 1:\n-old\n+new`);
  assert.equal(file('a.txt'), 'new\n');
  assert.match(text, /Ignored 1 `-` row/);
});

test('block ops and registers are not supported', async () => {
  const { tagOf, edit } = setup({ 'a.txt': '1\n' });
  const tag = await tagOf('a.txt');
  await assert.rejects(edit(`[a.txt#${tag}]\nPUT 1*:\n+x`), /not supported/);
  await assert.rejects(edit(`[a.txt#${tag}]\nCUT 1 @fn`), /not supported/);
});

test('a missing file points at the write tool', async () => {
  const { edit } = setup({});
  await assert.rejects(edit('[new.txt#0000]\nPUT >$:\n+hi'), /write tool/);
});

test('CRLF line endings, a BOM and a missing final newline are kept', async () => {
  const { tagOf, edit, file } = setup({ 'a.txt': '\uFEFFa\r\nb\r\nc' });
  const tag = await tagOf('a.txt');
  await edit(`[a.txt#${tag}]\nPUT 2:\n+B\nPUT >$:\n+d`);
  assert.equal(file('a.txt'), '\uFEFFa\r\nB\r\nc\r\nd');
});
