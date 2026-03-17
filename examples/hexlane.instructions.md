# hexlane instructions

These instructions configure your AI assistant (Cursor, GitHub Copilot, or any editor with custom rules support) to use hexlane when interacting with external systems.

Copy the content below into your instructions file:
- **Cursor**: `.cursor/rules/<name>.mdc` or `.cursorrules`
- **GitHub Copilot**: `.github/copilot-instructions.md` or a `.instructions.md` file

---

## Instructions

You have access to **hexlane**, a CLI tool that provides a unified interface to external systems — REST APIs, databases, and more. Use hexlane for all interactions with registered applications instead of writing raw curl commands, ad-hoc scripts, or direct SQL strings.

Profiles can be:
- `public` — no authentication needed; hexlane calls the API directly with no token
- `api_token` — token is fetched, cached, and renewed automatically
- `db_connection` — DB credentials are fetched, cached, and renewed automatically

### Discovering what's available

Before performing any task against an external system, always discover first:

```bash
hexlane app list                        # see all registered apps
hexlane app show <app-id>               # see environments and profiles for an app
hexlane op list --app <app-id>          # see available operations
hexlane op show <app-id>/<op-name>      # see full details: params, execution, examples
```

### Running operations

Prefer named operations over raw `api call` or `db query` whenever one exists for the task:

```bash
hexlane op run <app-id>/<op-name> \
  --env <env> \
  --profile <profile> \
  --param key=value
```

Default output format:
- **API operations**: pretty-printed JSON `{ "status": 200, "body": { ... } }` — headers hidden unless `--http-headers` is passed
- **DB operations**: table of rows

Use `--machine` to get TOON output (structured, consistent format well-suited for model consumption). Use `--json` for raw JSON.

Always use `--dry-run` first to confirm the rendered request before executing:

```bash
hexlane op run <app-id>/<op-name> --env <env> --profile <profile> --param key=value --dry-run
```

### Creating operations

If no operation exists for a task, create one with `op add` before running it. This makes the operation reusable for future sessions.

For API operations:
```bash
hexlane op add \
  --app <app-id> \
  --name <op-name> \
  --kind api \
  --method <GET|POST|PUT|PATCH|DELETE> \
  --path "<path with {{ param }} placeholders>" \
  --param "name:type:required:description" \
  --profile <profile> \
  --default-env <env> \
  --description "<what this operation does>"
```

For DB operations:
```bash
hexlane op add \
  --app <app-id> \
  --name <op-name> \
  --kind db \
  --sql "SELECT ... WHERE col = :paramName" \
  --param "paramName:type:required:description" \
  --profile <profile> \
  --default-env <env>
```

If the user provides an OpenAPI spec, use the paths, methods, and parameter definitions from it to create accurate operations.

### Raw API calls (when no operation is appropriate)

```bash
hexlane api call --app <app-id> --env <env> --profile <profile> \
  --method GET --path /some/path

# Include response headers
hexlane api call --app <app-id> --env <env> --profile <profile> \
  --method GET --path /some/path --http-headers

# TOON output for structured/AI consumption
hexlane api call --app <app-id> --env <env> --profile <profile> \
  --method GET --path /some/path --machine
```

### Raw DB queries (ad-hoc investigation)

```bash
hexlane db query --app <app-id> --env <env> --profile <profile> \
  --sql "SELECT * FROM t WHERE id = :id" \
  --param id=123
```

Always use named parameters (`:name` syntax) — never interpolate values directly into the SQL string.

### On authentication errors

```bash
hexlane credential revoke --app <app-id> --env <env> --profile <profile>
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
- Always check `op list` before reaching for `api call` or `db query`
- Always `op add` a new operation before running it if one doesn't exist — don't run ad-hoc calls for tasks that will recur
- Use `--machine` when you need structured TOON output; the default format is human-readable (pretty JSON for API, table for DB)
- Pass `--http-headers` only when response headers are needed for the task
