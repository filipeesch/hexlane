# Raw API & DB Commands

These commands let you make one-off API calls and run ad-hoc SQL queries without defining a named operation. They share the same credential resolution, vault, and audit pipeline as `op run`.

Use raw commands for exploration and debugging. Use [`op run`](operations.md) for repeatable, documented workflows.

---

## `hexlane api call`

Make a single HTTP request against a registered app's environment.

```
hexlane api call <app-id> <path> [options]
```

### Options

| Flag | Description |
|---|---|
| `-e, --env <env>` | Environment (default: first defined) |
| `-p, --profile <profile>` | Profile override (default: first defined) |
| `-m, --method <method>` | HTTP method (default: `GET`) |
| `-H, --header <header>` | Add request header — repeatable: `-H "X-Foo: bar"` |
| `-b, --body <body>` | Request body string |
| `--json` | Output raw JSON instead of TOON |

### Response envelope

Every `api call` response is wrapped in a structured envelope regardless of output format:

```json
{
  "status": 200,
  "headers": {
    "content-type": "application/json",
    "x-ratelimit-remaining": "59"
  },
  "body": { ... }   // parsed JSON if response Content-Type is JSON, raw string otherwise
}
```

The envelope is always written to stdout. Errors (non-2xx or network failures) also use this shape, with `status` set to the HTTP code.

### Examples

```bash
# GET /users/torvalds against github app in the public environment
hexlane api call github /users/torvalds

# POST with a body
hexlane api call my-app /orders \
  -m POST \
  -H "Content-Type: application/json" \
  -b '{"item": "widget", "qty": 2}'

# Use a specific env and profile
hexlane api call my-app /reports -e staging -p read-only

# Raw JSON output (e.g. to pipe to jq)
hexlane api call github /repos/torvalds/linux --json | jq '.body.stargazers_count'
```

### Public vs authenticated profiles

- **Public profiles** (`kind: public`) — hexlane calls the URL directly with no token. Fast and requires no vault setup.
- **Authenticated profiles** — hexlane resolves or acquires a credential from the vault, injects it per the profile's `auth` config, then makes the request.

---

## `hexlane db query`

Run raw SQL against a registered app's environment.

```
hexlane db query <app-id> [options]
```

SQL is provided via `--sql` or `--sql-file`. Named parameters are bound with `:name` syntax. Results are formatted as a table by default.

### Options

| Flag | Description |
|---|---|
| `-e, --env <env>` | Environment (default: first defined) |
| `-p, --profile <profile>` | Profile override (default: first defined) |
| `-s, --sql <sql>` | SQL statement |
| `-f, --sql-file <path>` | Path to a `.sql` file |
| `--param <name=value>` | Bind a named parameter — repeatable |
| `--limit <n>` | Append `LIMIT n` to the query |
| `--dry-run` | Print the resolved SQL and parameters without executing |
| `--json` | Output raw JSON instead of TOON |

### Named parameters

Use `:name` placeholders to bind values safely without string interpolation:

```bash
hexlane db query my-app \
  --sql "SELECT id, email FROM users WHERE status = :status AND created_at > :since" \
  --param status=active \
  --param since=2024-01-01
```

Parameters are bound at the driver level — they are never interpolated into the SQL string, preventing SQL injection.

### PostgreSQL `::type` casts

PostgreSQL uses `::` for type casting (`value::text`, `ts::timestamp`). hexlane's parameter parser treats `::` as a type cast delimiter, not a parameter prefix — they coexist safely:

```sql
SELECT id::text, created_at::date FROM orders WHERE status = :status
```

`:status` is a bound parameter; `::text` and `::date` are PostgreSQL type casts.

### `--dry-run`

Prints the resolved SQL and bound parameters to stdout without connecting to the database. Useful for auditing a query before execution:

```bash
hexlane db query my-app \
  --sql "SELECT id FROM orders WHERE status = :status AND tenant = :tenant" \
  --param status=failed --param tenant=acme \
  --dry-run
```

Output:
```
[DRY RUN] SQL:
  SELECT id FROM orders WHERE status = :status AND tenant = :tenant

Parameters:
  status    failed
  tenant    acme
```

### `--limit`

Automatically appends `LIMIT n` to the query. Useful when exploring tables without modifying the SQL:

```bash
hexlane db query my-app --sql "SELECT * FROM events ORDER BY created_at DESC" --limit 20
```

### Reading from a file

```bash
hexlane db query my-app --sql-file ./queries/find-orders.sql --param status=pending
```

### Examples

```bash
# Count rows
hexlane db query my-app --sql "SELECT COUNT(*) FROM users"

# Filter with parameters
hexlane db query my-app \
  --sql "SELECT id, email FROM users WHERE role = :role" \
  --param role=admin \
  --limit 10

# Dry-run a complex query
hexlane db query my-app --sql-file ./queries/audit.sql --dry-run

# JSON output for scripting
hexlane db query my-app --sql "SELECT id, name FROM products" --json | jq '[.[].name]'
```

---

## When to use raw commands vs operations

| Scenario | Recommendation |
|---|---|
| Exploring an API or schema | `api call` / `db query` |
| One-off debug request | `api call` / `db query` |
| Repeatable workflow | Define an operation — use `op run` |
| Shared with team, needs docs | Define an operation with `description`, `examples` |
| AI-assisted discovery | Operations are discoverable — `op discover` works on them |
