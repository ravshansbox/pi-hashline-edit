# pi-hashline-edit

Hashline `read` and `edit` tools for pi, modelled on [oh-my-pi](https://github.com/can1357/oh-my-pi)'s hashline edit mode.

## Install

```bash
pi install npm:@ravshansbox/pi-hashline-edit
```

Add `-l` to install it in project settings.

## Usage

The extension replaces the built-in `read` and `edit` tools.

`read` works as before, but text output starts with a `[PATH#TAG]` header and each line has an `N:` prefix. `TAG` is a 4-hex hash of the whole file:

```text
[src/app.py#1A2B]
1:def greet():
2:    print("hi")
```

`edit` takes one `input` string with one section per file:

```text
[src/app.py#1A2B]
PUT 2:
+    print("hello")
PUT >$:
+greet()
```

Ops:

- `PUT N.=M:` replaces lines N to M with the `+` body. `PUT N:` replaces one line.
- `PUT <N:` inserts before line N, `PUT >N:` after it, `PUT >$:` at the end.
- `CUT N.=M` or `CUT N` deletes lines.
- `REM` deletes the file. `MV DEST` moves it after the section's other ops.

Line numbers always refer to the file as it was read. `edit` rejects a section when its tag no longer matches the file, so the model has to read again instead of editing stale lines. The response gives the new header and the changed lines with two lines of context, so the model can chain edits without reading again.

All sections are checked before any file is written. Line endings, a byte order mark and a missing final newline are kept.

## Differences from oh-my-pi

- No syntax-block ops (`PUT N*:`, `CUT N*`).
- No registers (`CUT … @name`, `PUT … @name`).
- No recovery from stale tags using earlier snapshots.
- No check that edited lines were shown by `read`.
- Tags use a different hash, so they do not match oh-my-pi's.

## Development

```bash
npm install
npm run check
```
