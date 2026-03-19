# File System Commands (`hexlane fs`)

`hexlane fs` exposes a suite of file system operations — read, search, write, replace, move, delete, and rollback — against a registered target whose root directory is configured in `hexlane.yaml`.

It is designed for AI coding agents and scripts that need structured, safe access to a code tree. Every write operation automatically snapshots the previous content to `~/.hexlane/tools/fs/snapshots/` and returns an `operationId` you can pass to `hexlane fs rollback restore` to undo the change.

---

## Integration YAML

```yaml
integrations:
  - name: my-project
    targets:
      - id: my-project-src
        tool: fs
        config:
          root: ~/projects/my-project
          readonly: false          # optional — set to true to block writes
```

`root` is required. It may be an absolute or `~`-prefixed path. `readonly` defaults to `false`.

---

## Commands

### `hexlane fs list`

List files under the target root.

```
hexlane fs list <target-id> [--glob <pattern>] [--depth <n>] [--json]
```

| Flag               | Description                                                 |
| ------------------ | ----------------------------------------------------------- |
| `--glob <pattern>` | Glob pattern to filter (default: `**/*`)                    |
| `--depth <n>`      | Limit traversal depth. `1` = top-level only                 |
| `--json`           | Output raw JSON array of `{ path, size, modified }` entries |

---

### `hexlane fs read`

Read a file within the target root. Pass `--glob` to read multiple files at once.

```
hexlane fs read <target-id> --file <path> [--lines <start-end>] [--json]
hexlane fs read <target-id> --glob <pattern> [--depth <n>] [--json]
```

| Flag               | Description                                                                     |
| ------------------ | ------------------------------------------------------------------------------- |
| `--file <path>`    | Single file path relative to target root                                        |
| `--lines <range>`  | Return only this line range, e.g. `10-50`. 1-based inclusive. Single-file only. |
| `--glob <pattern>` | Read all matching text files at once. Returns `{ files, skipped }`.             |
| `--depth <n>`      | Limit glob traversal depth. Used with `--glob`.                                 |
| `--json`           | Output raw JSON                                                                  |

`--file` and `--glob` are mutually exclusive. Binary files are skipped (reported in `skipped` array) when using `--glob`.

---

### `hexlane fs stat`

Show metadata for a file within the target root.

```
hexlane fs stat <target-id> --file <path> [--json]
```

Returns `{ path, sizeBytes, sizeHuman, mimeType, modifiedAt, isSymlink }`.

---

### `hexlane fs search`

Search file contents using a regex.

```
hexlane fs search <target-id> --pattern <regex> [--glob <pattern>] [--context <n>] [--json]
```

| Flag                | Description                                       |
| ------------------- | ------------------------------------------------- |
| `--pattern <regex>` | Regex to search for (**required**)                |
| `--glob <pattern>`  | Glob filter (default: `**/*`)                     |
| `--context <n>`     | Lines of context around each match (default: `3`) |
| `--json`            | Output raw JSON array of matches                  |

Binary files are skipped silently.

---

### `hexlane fs write`

Create, overwrite, or patch a file within the target root. Snapshots the original content before any write.

```
hexlane fs write <target-id> --file <path> --content <str> [options]
```

| Flag                    | Description                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `--file <path>`         | File path relative to target root (**required**)                                                                                      |
| `--content <string>`    | Content to write                                                                                                                      |
| `--content-file <path>` | Read content from a file on the local machine                                                                                         |
| `--lines <start-end>`   | Patch mode: replace only those lines, keep everything else                                                                            |
| `--expect <string>`     | Guard for patch mode: apply only if the first line of the range contains this string. Safe to use when line numbers may have shifted. |
| `--dry-run`             | Preview the operation without writing anything                                                                                        |

**Modes:**
- **Create** — file does not exist; no snapshot taken.
- **Overwrite** — file exists; snapshot before replacing content.
- **Patch** — `--lines` is set; snapshot before replacing only those lines.

**`--expect` guard:**

When `--expect` is specified with `--lines`, the patch is applied only if the first line in the specified range contains the expected string. The command always returns a structured result so the caller can verify what happened:

```json
{ "matched": true, "expected": "func Init(", "found": "func Init(" }
```

If the guard does not match, no file is written, and `matched: false` is returned with the actual content found on that line. Use this to prevent patching stale line numbers.

**Returned `operationId`** — pass this to `hexlane fs rollback restore` to undo the write.

---

### `hexlane fs replace`

Find-and-replace within the target root. Defaults to regex across all files. Use `--file` + `--literal` + `--once` for safe single-site edits. Snapshots all affected files under a single `operationId`.

```
hexlane fs replace <target-id> --pattern <string> --replacement <str> [options]
```

| Flag                        | Description                                                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--pattern <string>`        | Pattern to find — regex by default (**required**)                                                                                                     |
| `--pattern-file <path>`     | Read pattern from a file (useful for multi-line patterns)                                                                                             |
| `--replacement <str>`       | Replacement string; supports `$1`, `$2` capture groups for regex mode                                                                                |
| `--replacement-file <path>` | Read replacement from a file (useful for multi-line replacements)                                                                                     |
| `--file <path>`             | Target a single file. Mutually exclusive with `--glob`.                                                                                               |
| `--glob <pattern>`          | Glob filter (default: `**/*`). Mutually exclusive with `--file`.                                                                                      |
| `--literal`                 | Treat `--pattern` as an exact string, not a regex                                                                                                     |
| `--once`                    | Require exactly one match total — errors if 0 or more than 1 occurrence is found. Intended for targeted single-site edits where ambiguity is a bug.   |
| `--dry-run`                 | Show matches and diffs without changing any files                                                                                                     |

**Safe single-site edit pattern** (canonical use for AI agents):

```bash
hexlane fs replace my-project-src \
  --file src/server.ts \
  --literal \
  --once \
  --pattern 'if (!config.root) {' \
  --replacement 'if (!config.root || !isAbsolute(config.root)) {'
```

With `--literal --once`: if the old text does not appear in the file, or appears more than once, the command errors rather than silently patching the wrong location. Position-independent — no stale line numbers.

Binary files are skipped automatically.

---

### `hexlane fs move`

Move or rename a file within the target root. Snapshots the original content before moving.

```
hexlane fs move <target-id> --from <path> --to <path> [--dry-run]
```

Both paths are relative to the target root. The destination directory is created if it does not exist.

---

### `hexlane fs delete`

Delete a file within the target root. Snapshots the content before deletion.

```
hexlane fs delete <target-id> --file <path> [--dry-run]
```

---

## Rollback

Every write operation (`write`, `replace`, `move`, `delete`) returns an `operationId`. Pass it to `rollback restore` to undo the change.

### `hexlane fs rollback restore`

```
hexlane fs rollback restore <target-id> --operation-id <id>
```

Restores all files captured by the snapshot. The snapshot is deleted after a successful restore.

### `hexlane fs rollback list`

```
hexlane fs rollback list [target-id]
```

List all available snapshots, optionally filtered by target.

### `hexlane fs rollback prune`

```
hexlane fs rollback prune [--older-than <duration>]
```

Delete snapshots older than the specified duration (default: `7d`). Also removes any corrupt snapshot files.

---

## Output formats

All commands support `--json` (raw JSON) and `--machine` (TOON — structured output optimised for scripting/AI pipelines). When neither flag is set, output is printed in a readable table or text format.

---

## Safety guarantees

| Concern                          | Behaviour                                                       |
| -------------------------------- | --------------------------------------------------------------- |
| Path traversal (`../`)           | Hard error — paths are always resolved against the target root  |
| Binary files (write/move/delete) | Hard error — detected by scanning the first 8 KB for null bytes |
| Binary files (read/search)       | Error on read; silently skipped on search                       |
| Read-only target                 | Write commands fail immediately when `config.readonly: true`    |
| Snapshot storage                 | `~/.hexlane/tools/fs/snapshots/` — one JSON file per operation  |
| Snapshot TTL                     | 7 days by default; run `rollback prune` to clean up earlier     |
