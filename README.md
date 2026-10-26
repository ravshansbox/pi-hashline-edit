# pi-hashline-edit

Hashline edit extension for pi.

## Install

```bash
pi install npm:@ravshansbox/pi-hashline-edit
```

Add `-l` to install it in project settings.

## Usage

It replaces the built-in `read` and `edit` tools with hashline versions, modelled on [oh-my-pi](https://github.com/can1357/oh-my-pi)'s hashline edit mode.

`read` works as before, but text output starts with a `[PATH#TAG]` header and each line has an `N:` prefix. `TAG` is a 4-hex hash of the whole file:

```text
[src/app.py#1A2B]
1:def greet():
2:    print("hi")
```

`edit` takes one `input` string that edits one file:

```text
[src/app.py#1A2B]
PUT 2:
+    print("hello")
PUT >$:
+greet()
```

Ops:

- `PUT N.=M:` replaces lines N to M with the `+` body; no body deletes them. `PUT N:` replaces one line.
- `PUT <N:` inserts before line N, `PUT >N:` after it, `PUT >$:` at the end.

Line numbers always refer to the file as it was read. `edit` rejects the patch when its tag no longer matches the file, so the model has to read again instead of editing stale lines. The response gives only the new header, so the model reads again before the next edit.

All ops are checked before the file is written. Line endings and a missing final newline are kept.

`edit` is shown like the built-in `edit` tool: the path from the header, then a diff once the edit is done. Unlike the built-in tool, it shows no diff preview before the edit runs.

### Differences from oh-my-pi

- No `CUT`; use `PUT` with no body.
- No byte order mark handling: it shows as part of line 1.
- No syntax-block ops (`PUT N*:`).
- No registers (`PUT … @name`).
- No file ops (`REM`, `MV`).
- One file per call.
- No recovery from stale tags using earlier snapshots.
- No check that edited lines were shown by `read`.
- Tags use a different hash, so they do not match oh-my-pi's.

## Development

```bash
npm install
npm run check
```
