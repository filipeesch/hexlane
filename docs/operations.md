# Operations

Operations are named, typed, discoverable actions stored in app configs. They wrap API calls or DB queries with declared parameters, path/query/body templating, and optional defaults for environment and profile. Every operation created by an AI agent or a human persists and becomes a reusable building block for future sessions.

Prefer `op run` over raw `api call` / `db query` whenever an operation exists for the task.

---

## Discovering operations

```bash
hexlane op list                        # all operations across all apps
hexlane op list --app <app-id>         # filter by app
hexlane op list --filter <text>        # search name, description, and tags

hexlane op show <app/op>               # full metadata: params, execution, examples
hexlane op validate <app/op>           # schema + cross-reference validation
```

`op show` prints the operation's kind, default env/profile, all declared parameters (name, type, required, description), the execution template, and any examples. Always run it before `op run` on an unfamiliar operation.

---

## Running operations

```bash
hexlane op run <app/op> \
  --env <env> \
  --profile <profile> \
  --param key=value    # repeatable
```

`--env` and `--profile` are optional if the operation declares `defaultEnv` and `profile`. Always use `--dry-run` first on operations you haven't run before — it renders all templates without touching any network or database.

```bash
# Dry-run — renders path, query, body templates and prints the plan, no execution
hexlane op run github/list-issues \
  --param owner=torvalds --param repo=linux \
  --param state=open --dry-run

# Live run — default output: pretty-printed JSON { status, body } for API ops, table for DB ops
hexlane op run github/get-user --param username=torvalds

# Include response headers
hexlane op run github/get-user --param username=torvalds --http-headers

# Raw JSON output (e.g. to pipe to jq)
hexlane op run github/get-repo \
  --param owner=torvalds --param repo=linux --json

# TOON output for AI/structured consumption
hexlane op run github/get-user --param username=torvalds --machine

# DB operation with row limit
hexlane op run my-app/find-orders \
  --env production --profile readonly \
  --param status=failed --limit 100

# Debug credential acquisition and request details
hexlane op run my-app/get-account --param id=123 --debug
```

**Options:**

| Flag                | Description                                                  |
| ------------------- | ------------------------------------------------------------ |
| `--env <name>`      | Override environment (required if no `defaultEnv`)           |
| `--profile <name>`  | Override profile (required if no default `profile`)          |
| `--param key=value` | Parameter value — repeatable                                 |
| `--dry-run`         | Render templates and print plan, no execution                |
| `--limit <n>`       | Max rows for DB operations (default: 500)                    |
| `--http-headers`    | Include response headers in output (API ops only)            |
| `--machine`         | Output TOON (structured format for AI/scripting consumption) |
| `--json`            | Output raw JSON                                              |
| `--debug`           | Log credential state, SQL, and HTTP details to stderr        |

---

## Defining operations with `op add`

Operations are stored in the registered app YAML. `op add` appends one without editing the file manually. You can also ask an AI model to do this in natural language:

> *"Create an operation in hexlane that fetches a user profile from the GitHub API."*
> *"Add a DB operation to my-app that queries the transactions table for all failed rows in the last 7 days."*

If your API has an OpenAPI (Swagger) spec, share it with the model — it contains all the paths, methods, and parameters needed to define operations with perfect accuracy.

### API operation

```bash
hexlane op add \
  --app <app-id> \
  --name <name> \
  --kind api \
  --method GET|POST|PUT|PATCH|DELETE \
  --path "/resource/{{ paramName }}" \
  --param "name:type:required_or_optional:description" \
  --profile <profile> \
  --default-env <env> \
  --description "What this operation does"
```

Path supports `{{ varName }}` template placeholders. Any parameter that appears in the path must be declared with `--param`.

**With a `query:` block** — query parameters are set in the YAML directly (see [app-config.md](app-config.md#api-operation)). When using `op add`, put optional query params as regular parameters; the query block can be added manually or via the YAML file later.

**With a request body:**

```bash
hexlane op add \
  --app my-app \
  --name create-order \
  --kind api \
  --method POST \
  --path "/orders" \
  --body '{"type": "{{ orderType }}", "customerId": "{{ customerId }}"}' \
  --param "orderType:string:required:Order type" \
  --param "customerId:string:required:Customer ID" \
  --profile support-user \
  --default-env production
```

### DB operation

```bash
hexlane op add \
  --app my-app \
  --name find-order \
  --kind db \
  --sql "SELECT id, created_at FROM orders WHERE status = :status" \
  --param "status:string:required:Order status" \
  --profile readonly \
  --default-env production
```

SQL uses `:name` placeholders — injection-safe, bound via parameterized queries. PostgreSQL `::type` cast syntax (e.g. `id::text`) does not conflict with `:name` params.

### `--param` format

```
name:type:required_or_optional:description
```

| Segment     | Values                                             |
| ----------- | -------------------------------------------------- |
| `name`      | Alphanumeric + underscore, e.g. `orderId`          |
| `type`      | `string` (default), `integer`, `number`, `boolean` |
| third       | `required` (default) or `optional`                 |
| description | Free text, may contain colons                      |

Examples:
```
orderId:integer:required:Order primary key
state:string:optional:Filter by state (open, closed, all)
dryRun:boolean:optional:Preview only
```

---

## Removing operations

```bash
hexlane op delete <app/op>
```

This removes the operation from the app's YAML config file. The change takes effect immediately — no re-registration needed.

---

## Template syntax

All `{{ varName }}` placeholders in `path`, `body`, and `headers` are resolved from the declared `parameters`. The template renderer throws at runtime if a placeholder references an undeclared parameter name — catch this early with `--dry-run` or `op validate`.

```yaml
# path template
path: /repos/{{ owner }}/{{ repo }}/issues

# body template
body: '{"customerId": "{{ customerId }}", "type": "{{ orderType }}"}'

# header template
headers:
  X-Trace-Id: "{{ traceId }}"
```

Query parameters use `{{ varName }}` too, and empty/missing optional values are automatically omitted from the request URL:

```yaml
query:
  state: "{{ state }}"       # omitted if state is empty
  per_page: "{{ perPage }}"  # omitted if perPage is empty
```

---

## Tips for AI models

- Always run `hexlane op list --app <id>` before reaching for `api call` or `db query`
- Check `op show <app/op>` to read param names, types, and defaults before running
- Run with `--dry-run` first to confirm the rendered request
- Use `op add` to define new operations before running them — they persist for future sessions
- See [`examples/hexlane.instructions.md`](../examples/hexlane.instructions.md) for a ready-to-paste Cursor/Copilot rules file
