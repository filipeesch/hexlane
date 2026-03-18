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

Targets and operations are defined together in an **integration** YAML file and registered with `hexlane integration add`.

### Discovering what's available

Before performing any task against an external system, always discover first:

```bash
hexlane integration list                          # see all registered integrations
hexlane integration show <integration-id>         # see targets and credential config
hexlane op list --integration <integration-id>    # see available operations
hexlane op show <target-id>/<op-name>             # see full details: params, execution, examples
```

### Running operations

Prefer named operations over raw `http call` or `sql query` whenever one exists for the task:

```bash
hexlane op run <target-id>/<op-name> --param key=value
```

Default output format:
- **HTTP operations**: pretty-printed JSON `{ "status": 200, "body": { ... } }` — headers hidden unless `--http-headers` is passed
- **SQL operations**: table of rows

Use `--machine` to get TOON output (structured, consistent format well-suited for model consumption). Use `--json` for raw JSON.

Always use `--dry-run` first to confirm the rendered request before executing:

```bash
hexlane op run <target-id>/<op-name> --param key=value --dry-run
```

### Creating operations

If no operation exists for a task, create one with `op add` before running it. This makes the operation reusable for future sessions.

For HTTP operations:
```bash
hexlane op add \
  --integration <integration-id> \
  --name <op-name> \
  --tool http \
  --method <GET|POST|PUT|PATCH|DELETE> \
  --path "<path with {{ param }} placeholders>" \
  --param "name:type:required:description" \
  --default-target <target-id> \
  --description "<what this operation does>"
```

For SQL operations:
```bash
hexlane op add \
  --integration <integration-id> \
  --name <op-name> \
  --tool sql \
  --sql "SELECT ... WHERE col = :paramName" \
  --param "paramName:type:required:description" \
  --default-target <target-id>
```

If the user provides an OpenAPI spec, use the paths, methods, and parameter definitions from it to create accurate operations.

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

### On authentication errors

```bash
hexlane credential revoke --target <target-id>
# then retry the original command
```

Add `--debug` to any command to trace the full credential acquisition and request cycle.

### Parameter format for `--param` in `op add`

`name:type:required_or_optional:description`

- `type`: `string` (default), `integer`, `number`, `boolean`
- third segment: `required` or `optional`
- description may contain colons

### Rules

- Never construct raw HTTP requests or connection strings yourself — always go through hexlane
- Never interpolate variable values into `--path` or `--sql` strings — always use `--param`
- Always check `op list --integration <id>` before reaching for `http call` or `sql query`
- Always `op add` a new operation before running it if one doesn't exist — don't run ad-hoc calls for tasks that will recur
- Use `--machine` when you need structured TOON output; the default format is human-readable (pretty JSON for HTTP, table for SQL)
- Pass `--http-headers` only when response headers are needed for the task
