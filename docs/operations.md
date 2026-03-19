# Operations

Operations are named, typed, discoverable actions defined inside an **integration** — a single YAML file that groups targets and operations for one external system. They wrap HTTP calls or SQL queries with declared parameters, path/query/body templating, and a default target. Every operation created by an AI agent or a human persists and becomes a reusable building block for future sessions.

A **target** is a named, configured instance of a tool (`http` or `sql`) within an integration. You run operations through a target:

```
hexlane op run <target-id>/<op-name>
```

Prefer `op run` over raw `http call` / `sql query` whenever an operation exists for the task.

---

## Discovering operations

```bash
hexlane op list                                  # all operations across all integrations
hexlane op list --integration <integration-id>   # filter by integration
hexlane op list --filter <text>                  # case-insensitive search (name, description, tags)

hexlane op show <target-id>/<op-name>            # full metadata: params, execution, examples
hexlane op validate <target-id>/<op-name>        # schema + cross-reference validation
```

`op show` prints the operation's tool type, default target, all declared parameters (name, type, required, description), the execution template, and any examples. Always run it before `op run` on an unfamiliar operation.

---

## Running operations

```bash
hexlane op run <target-id>/<op-name> \
  --param key=value    # repeatable
```

The target is the namespace — it specifies both the system to call and where to find the credentials. `--param` values are substituted into path/query/body/SQL templates.

```bash
# Dry-run — renders all templates and prints the plan, no execution
hexlane op run github/list-issues \
  --param owner=torvalds --param repo=linux \
  --param state=open --dry-run

# Live run — default output: pretty-printed { status, body } for http ops, table for sql ops
hexlane op run github/get-user --param username=torvalds

# Include response headers (http ops only)
hexlane op run github/get-user --param username=torvalds --http-headers

# Raw JSON output (e.g. to pipe to jq)
hexlane op run github/get-repo \
  --param owner=torvalds --param repo=linux --json

# TOON output for AI/structured consumption
hexlane op run github/get-user --param username=torvalds --machine

# SQL op with row limit
hexlane op run my-app-db-prod/find-orders \
  --param status=failed --limit 100

# Debug credential acquisition and request details
hexlane op run my-app-api-prod/get-account --param id=123 --debug
```

**Options:**

| Flag                | Description                                                  |
| ------------------- | ------------------------------------------------------------ |
| `--param key=value` | Parameter value — repeatable                                 |
| `--target <id>`     | Run against a different target in the same integration       |
| `--dry-run`         | Render templates and print plan, no execution                |
| `--limit <n>`       | Max rows for SQL operations (default: 500)                   |
| `--http-headers`    | Include response headers in output (http ops only)           |
| `--machine`         | Output TOON (structured format for AI/scripting consumption) |
| `--json`            | Output raw JSON                                              |
| `--debug`           | Log credential state, SQL, and HTTP details to stderr        |

---

## Defining operations with `op add`

Operations are stored in the integration YAML. `op add` appends one without editing the file manually. You can also ask an AI model to do this in natural language:

> *"Create an operation in hexlane that fetches a user profile from the GitHub API."*
> *"Add an SQL operation to my-app that queries the transactions table for all failed rows in the last 7 days."*

If your API has an OpenAPI (Swagger) spec, share it with the model — it contains all the paths, methods, and parameters needed to define operations with perfect accuracy.

### HTTP operation

```bash
hexlane op add \
  --integration <integration-id> \
  --name <name> \
  --tool http \
  --method GET|POST|PUT|PATCH|DELETE \
  --path "/resource/{{ paramName }}" \
  --param "name:type:required_or_optional:description" \
  --default-target <target-id> \
  --description "What this operation does"
```

Path supports `{{ varName }}` template placeholders. Any parameter that appears in the path must be declared with `--param`.

**With a `query:` block** — query parameters are set in the YAML directly (see [integration-config.md](integration-config.md#http-operation)). When using `op add`, put optional query params as regular parameters; the query block can be added manually or via the YAML file later.

**With a request body:**

```bash
hexlane op add \
  --integration my-app \
  --name create-order \
  --tool http \
  --method POST \
  --path "/orders" \
  --body '{"type": "{{ orderType }}", "customerId": "{{ customerId }}"}' \
  --param "orderType:string:required:Order type" \
  --param "customerId:string:required:Customer ID" \
  --default-target my-app-api-prod
```

### SQL operation

```bash
hexlane op add \
  --integration my-app \
  --name find-order \
  --tool sql \
  --sql "SELECT id, created_at FROM orders WHERE status = :status" \
  --param "status:string:required:Order status" \
  --default-target my-app-db-prod
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
hexlane op delete <integration-id>/<op-name>
```

This removes the operation from the integration YAML. The change takes effect immediately — no re-registration needed.

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

- Always run `hexlane op list --integration <id>` before reaching for `http call` or `sql query`
- Check `op show <target-id>/<op-name>` to read param names, types, and defaults before running
- Run with `--dry-run` first to confirm the rendered request
- Use `--machine` when you need structured TOON output; the default is human-readable (pretty JSON for HTTP, table for SQL)

- Use `op add` to define new operations before running them — they persist for future sessions
- See [`examples/hexlane.instructions.md`](../examples/hexlane.instructions.md) for a ready-to-paste Cursor/Copilot rules file
