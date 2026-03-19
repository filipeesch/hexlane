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
hexlane integration list                                        # see all registered integrations
hexlane integration show <integration-id>                       # see targets and credential config
hexlane op list --filter <keyword>                              # search operations by name, description, or tag
hexlane op list --integration <integration-id>                  # browse by integration
hexlane op list --integration <integration-id> --filter <keyword>  # combine both
hexlane op show <target-id>/<op-name>                           # see full details: params, execution, examples
```

### Running operations

Prefer named operations over raw `http call` or `sql query` whenever one exists for the task:

```bash
hexlane op run <target-id>/<op-name> --param key=value
```

Default output format:
- **HTTP operations**: pretty-printed JSON `{ "status": 200, "body": { ... } }` — headers hidden unless `--http-headers` is passed
- **SQL operations**: table of rows

**Always pass `--machine`** when the output will be consumed by a model. This produces TOON — a structured, consistent format optimised for AI parsing. Use `--json` only when raw JSON is explicitly needed.

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

### `target.params` — static parameter defaults per target

Each target in an integration YAML can declare a `params` map. These values are automatically injected into the operation template at `op run` time, using the literal key name. User-supplied `--param` overrides a `target.params` value for the same key.

This is useful when the same operation is used across multiple targets but a template variable (like `datasource_uid`) differs by target:

```yaml
targets:
  - id: grafana-staging
    tool: http
    config:
      base_url: https://grafana.staging.example.com
    params:
      datasource_uid: ben9xq9lzod8gf
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

### Parameter format for `--param` in `op add`

`name:type:required_or_optional:description`

- `type`: `string` (default), `integer`, `number`, `boolean`
- third segment: `required` or `optional`
- description may contain colons

### Rules

- Never construct raw HTTP requests or connection strings yourself — always go through hexlane
- Never interpolate variable values into `--path` or `--sql` strings — always use `--param`
- Always use `op list --filter <keyword>` to search for relevant operations before reaching for `http call` or `sql query`
- Always `op add` a new operation before running it if one doesn't exist — don't run ad-hoc calls for tasks that will recur
- Always pass `--machine` for output you will read or parse — the default is human-readable, not model-optimised
- Pass `--http-headers` only when response headers are needed for the task
