# Operations

Operations are named, typed, discoverable actions defined inside an **integration** — a single YAML file that groups targets and operations for one external system. They wrap HTTP calls or SQL queries with declared parameters, path/query/body templating, and optional target selection. Every operation created by an AI agent or a human persists and becomes a reusable building block for future sessions.

A **target** is a named instance that exposes one or more tools (`http`, `sql`, `fs`) within an integration. You run operations through a target, identified by the integration they belong to:

```
hexlane op run <integration-id>/<op-name>
```

Prefer `op run` over raw `http call` / `sql query` whenever an operation exists for the task.

---

## Discovering operations

```bash
hexlane op list                                  # all operations across all integrations
hexlane op list --integration <integration-id>   # filter by integration
hexlane op list --filter <text>                  # case-insensitive search (ref, tool, name, description, tags)

hexlane op show <integration-id>/<op-name>            # raw YAML of the operation (pipeable)
hexlane op targets <integration-id>/<op-name>         # list targets compatible with this operation
hexlane op validate <integration-id>/<op-name>        # schema + cross-reference validation
```

`op show` prints the raw YAML of the operation — useful for inspection and piping to `op edit`. `op targets` lists all targets in the integration whose `tools` array contains a matching tool type, and marks the default target with `✓`.

Always check `op targets` when you're unsure which target to use or when `op run` fails with a "no default target" error.

---

## Running operations

```bash
hexlane op run <integration-id>/<op-name> \
  --param key=value    # repeatable
```

The integration scopes which system to call and where to find credentials. The operation runs against `integration.defaultTarget` when `--target` is not given. If neither is set, `op run` exits with an error listing the compatible targets — run `hexlane op targets <integration-id>/<op-name>` to see them. Use `--target` to pick a specific target:

```bash
hexlane op run <integration-id>/<op-name> --target <target-id>
```

```bash
# Dry-run — renders all templates and prints the plan, no execution
hexlane op run github/list-issues \
  --param owner=torvalds --param repo=linux \
  --param state=open --dry-run

# Live run — default output: pretty-printed { status, body } for http ops, table for sql ops
hexlane op run github/get-user --param username=torvalds

# Run against a specific target (overrides integration.defaultTarget)
hexlane op run github/get-user --target github-enterprise --param username=torvalds

# Include response headers (http ops only)
hexlane op run github/get-user --param username=torvalds --http-headers

# Raw JSON output (e.g. to pipe to jq)
hexlane op run github/get-repo \
  --param owner=torvalds --param repo=linux --json

# TOON output for AI/structured consumption
hexlane op run github/get-user --param username=torvalds --machine

# SQL op with row limit
hexlane op run my-app/find-orders \
  --param status=failed --limit 100

# Debug credential acquisition and request details
hexlane op run my-app/get-account --param id=123 --debug
```

**Options:**

| Flag                | Description                                                           |
| ------------------- | --------------------------------------------------------------------- |
| `--param key=value` | Parameter value — repeatable                                          |
| `--target <id>`     | Run against a specific target (overrides `integration.defaultTarget`) |
| `--dry-run`         | Render templates and print plan, no execution                         |
| `--limit <n>`       | Max rows for SQL operations (default: 500)                            |
| `--http-headers`    | Include response headers in output (http ops only)                    |
| `--machine`         | Output TOON (structured format for AI/scripting consumption)          |
| `--json`            | Output raw JSON                                                       |
| `--debug`           | Log credential state, SQL, and HTTP details to stderr                 |

---

## Defining operations with `op add`

Operations are stored in the integration YAML. `op add` appends one without editing the file manually. You can also ask an AI model to do this in natural language:

> *"Create an operation in hexlane that fetches a user profile from the GitHub API."*
> *"Add an SQL operation to my-app that queries the transactions table for all failed rows in the last 7 days."*

If your API has an OpenAPI (Swagger) spec, share it with the model — it contains all the paths, methods, and parameters needed to define operations with perfect accuracy.

For integration operations (`--integration`), the full operation is supplied as raw YAML via `--raw` or `--file`. This gives precise control over every field and supports complex operations that don't fit individual flags:

```bash
# Inline YAML
hexlane op add --integration github --raw "
name: get-user
tool: http
description: Fetch a GitHub user profile
parameters:
  - name: username
    type: string
    required: true
execution:
  method: GET
  path: /users/{{ username }}
"

# From a file
hexlane op add --integration github --file ./get-user.yaml

# From stdin
cat get-user.yaml | hexlane op add --integration github --file -
```

---

## Editing operations with `op edit`

Replace an existing operation in-place. Supply the full updated YAML via `--raw` or `--file`:

```bash
# Inline edit
hexlane op edit github/get-user --raw "
name: get-user
tool: http
description: Updated description
parameters:
  - name: username
    type: string
    required: true
execution:
  method: GET
  path: /users/{{ username }}
"

# From a file
hexlane op edit github/get-user --file ./get-user-updated.yaml

# Round-trip via op show → edit
hexlane op show github/get-user | hexlane op edit github/get-user --file -
```

The operation name in the YAML must match the `<op-name>` argument. The file is updated atomically — other operations are preserved.

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
- Check `op show <integration-id>/<op-name>` to read param names, types, and defaults before running
- Run with `--dry-run` first to confirm the rendered request
- Use `--machine` when you need structured TOON output; the default is human-readable (pretty JSON for HTTP, table for SQL)

- Use `op add` to define new operations before running them — they persist for future sessions
- See [`examples/hexlane.instructions.md`](../examples/hexlane.instructions.md) for a ready-to-paste Cursor/Copilot rules file
