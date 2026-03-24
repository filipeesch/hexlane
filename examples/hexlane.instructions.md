# hexlane instructions

These instructions configure your AI assistant (Cursor, GitHub Copilot, or any editor with custom rules support) to use hexlane when interacting with external systems.

Copy the content below into your instructions file:
- **Cursor**: `.cursor/rules/<name>.mdc` or `.cursorrules`
- **GitHub Copilot**: `.github/copilot-instructions.md` or a `.instructions.md` file

---

## Instructions

You have access to **hexlane**, a CLI tool that provides a unified interface to external systems — REST APIs, databases, and more. Use hexlane for all interactions with registered targets instead of writing raw curl commands, ad-hoc scripts, or direct SQL strings.

Targets can use:
- `credential.kind: public` — no authentication needed; hexlane calls the endpoint directly with no token
- `credential.kind: api_token` — token is fetched, cached, and renewed automatically
- `credential.kind: db_connection` — DB credentials are fetched, cached, and renewed automatically
- tool `fs` (no credential) — use `hexlane fs` commands; root directory is set in `config.root`

Targets and operations are defined together in an **integration** YAML file and registered with `hexlane integration add`.

### Discovering what's available

Before performing any task against an external system, always discover first:

```bash
hexlane integration list                                        # see all registered integrations
hexlane integration show <integration-id>                       # see targets and credential config
hexlane op list --filter <keyword>                              # search operations by name, description, tag, ref, or tool
hexlane op list --integration <integration-id>                  # browse by integration
hexlane op list --integration <integration-id> --filter <keyword>  # combine both
hexlane op show <integration-id>/<op-name>                           # raw YAML of the operation (pipeable to op edit)
hexlane op targets <integration-id>/<op-name>                        # list compatible targets; ✓ = integration.defaultTarget
```

### Running operations

Prefer named operations over raw `http call` or `sql query` whenever one exists for the task:

```bash
hexlane op run <integration-id>/<op-name> --param key=value
```

To run against a specific target (overrides `integration.defaultTarget`):

```bash
hexlane op run <integration-id>/<op-name> --target <target-id> --param key=value
```

Default output format:
- **HTTP operations**: pretty-printed JSON `{ "status": 200, "body": { ... } }` — headers hidden unless `--http-headers` is passed
- **SQL operations**: table of rows

**Always pass `--machine`** when the output will be consumed by a model. This produces TOON — a structured, consistent format optimised for AI parsing. Use `--json` only when raw JSON is explicitly needed.

Always use `--dry-run` first to confirm the rendered request before executing:

```bash
hexlane op run <integration-id>/<op-name> --param key=value --dry-run
```

### Creating and editing operations

If no operation exists for a task, create one with `op add` before running it. This makes the operation reusable for future sessions. Supply the full operation as YAML via `--raw` (inline string) or `--file` (path or `-` for stdin):

```bash
hexlane op add --integration <integration-id> --raw "
name: get-user
tool: http
description: Fetch a user profile
parameters:
  - name: username
    type: string
    required: true
execution:
  method: GET
  path: /users/{{ username }}
"

hexlane op add --integration <integration-id> --file ./get-user.yaml   # from file
cat get-user.yaml | hexlane op add --integration <integration-id> --file -  # from stdin
```

To update an existing operation in-place:

```bash
hexlane op edit <integration-id>/<op-name> --raw "..."
hexlane op edit <integration-id>/<op-name> --file ./updated.yaml
hexlane op show <integration-id>/<op-name> | hexlane op edit <integration-id>/<op-name> --file -  # round-trip
```

If the user provides an OpenAPI spec, use the paths, methods, and parameter definitions from it to create accurate operations.

### `target.params` — static parameter defaults per target

Each target in an integration YAML can declare a `params` map. These values are automatically injected into the operation template at `op run` time, using the literal key name. User-supplied `--param` overrides a `target.params` value for the same key.

This is useful when the same operation is used across multiple targets but a template variable (like `datasource_uid`) differs by target:

```yaml
targets:
  - id: grafana-staging
    params:
      datasource_uid: ben9xq9lzod8gf
    tools:
      - type: http
        config:
          base_url: https://grafana.staging.example.com
```

For the injected key to be accepted, declare it as `optional` in the operation's `parameters` list. The dry-run output will include a `target_params` field showing what was injected.

### Ad-hoc HTTP calls (when no operation is appropriate)

```bash
hexlane http call <target-id> /some/path

# Include response headers
hexlane http call <target-id> /some/path --http-headers

# POST with a body
hexlane http call <target-id> /some/path -m POST -b '{"key": "value"}'

# TOON output for structured/AI consumption
hexlane http call <target-id> /some/path --machine
```

### Ad-hoc SQL queries (ad-hoc investigation)

```bash
hexlane sql query <target-id> \
  --sql "SELECT * FROM t WHERE id = :id" \
  --param id=123
```

Always use named parameters (`:name` syntax) — never interpolate values directly into the SQL string.

### File system operations (`fs` targets)

For targets with `tools: [{type: fs, ...}]`, use `hexlane fs` commands.

```bash
# Read a single file
hexlane fs read <target-id> --file src/main.ts
hexlane fs read <target-id> --file src/main.ts --lines 10-50
# Read multiple files at once (returns { files, skipped })
hexlane fs read <target-id> --glob "src/**/*.ts"

hexlane fs list <target-id> --glob "**/*.ts" --depth 2
hexlane fs search <target-id> --pattern "TODO" --glob "**/*.ts" --context 3

# Write (create or overwrite)
hexlane fs write <target-id> --file src/new.ts --content "export const x = 1;"
# Patch a line range — use --expect to guard against stale line numbers
hexlane fs write <target-id> --file src/main.ts \
  --lines 45-52 --content "  return newValue;" \
  --expect "return oldValue;"

# Safe single-site edit — preferred for targeted changes (no stale line numbers)
# --literal = exact string match, --once = error if 0 or >1 occurrences
hexlane fs replace <target-id> \
  --file src/main.ts --literal --once \
  --pattern 'return oldValue;' --replacement 'return newValue;'

# Multi-line edits via files
hexlane fs replace <target-id> \
  --file src/main.ts --literal --once \
  --pattern-file /tmp/old.txt --replacement-file /tmp/new.txt

# Bulk regex replace across files
hexlane fs replace <target-id> --pattern "OldName" --replacement "NewName" --glob "**/*.ts"

# Move / delete
hexlane fs move <target-id> --from src/old.ts --to src/new.ts
hexlane fs delete <target-id> --file src/unused.ts

# Rollback any write operation
hexlane fs rollback restore <target-id> --operation-id <id>
hexlane fs rollback list <target-id>
```

Every write command snapshots the original content and returns an `operationId`. Use `rollback restore` to undo. Always `--dry-run` first when unsure of scope.

### On authentication errors

```bash
hexlane credential revoke --target <target-id>
# then retry the original command
```

Add `--debug` to any command to trace the full credential acquisition and request cycle.

For targets with `acquire_strategy: static`, load the credential manually with `credential set`:

```bash
# API token
hexlane credential set --target <target-id> --token <value>
# or pipe from stdin
echo "$MY_TOKEN" | hexlane credential set --target <target-id>

# DB connection string
hexlane credential set --target <target-id> --connection-string postgresql://user:pass@host:5432/dbname
```

### Rules

- Never construct raw HTTP requests or connection strings yourself — always go through hexlane
- Never interpolate variable values into `--path` or `--sql` strings — always use `--param`
- Always use `op list --filter <keyword>` to search for relevant operations before reaching for `http call` or `sql query`
- Always `op add` a new operation before running it if one doesn't exist — don't run ad-hoc calls for tasks that will recur
- Use `op targets <integration-id>/<op>` when unsure which target to use or when `op run` fails with a "no default target" error
- Always pass `--machine` for output you will read or parse — the default is human-readable, not model-optimised
- Pass `--http-headers` only when response headers are needed for the task
- For `fs` writes: always use `--dry-run` first to verify scope; use `--expect` with `--lines` to guard stale line numbers; use `rollback restore` to undo any write
- For targeted single-file edits prefer `fs replace --literal --once` over `fs write --lines` — it is position-independent and errors on ambiguity
