# Ad-hoc SQL Commands

`hexlane sql query` lets you run one-off SQL queries against a registered target without defining a named operation. It shares the same credential resolution, vault, and audit pipeline as `op run`.

Use raw commands for exploration and debugging. Use [`op run`](operations.md) for repeatable, documented workflows.

---

## `hexlane sql query`

Run raw SQL against a registered target.

```
hexlane sql query <target-id> [options]
```

SQL is provided via `--sql` or `--sql-file`. Named parameters are bound with `:name` syntax. Results are formatted as a table by default.

### Options

| Flag                   | Description                                                  |
| ---------------------- | ------------------------------------------------------------ |
| `--sql <query>`        | SQL statement                                                |
| `--sql-file <path>`    | Path to a `.sql` file                                        |
| `--param <name=value>` | Bind a named parameter — repeatable                          |
| `--limit <n>`          | Append `LIMIT n` to the query                                |
| `--dry-run`            | Print the resolved SQL and parameters without executing      |
| `--machine`            | Output TOON (structured format for AI/scripting consumption) |
| `--json`               | Output raw JSON array of rows                                |

### Named parameters

Use `:name` placeholders to bind values safely without string interpolation:

```bash
hexlane sql query my-app-db-prod \
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
hexlane sql query my-app-db-prod \
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
hexlane sql query my-app-db-prod --sql "SELECT * FROM events ORDER BY created_at DESC" --limit 20
```

### Reading from a file

```bash
hexlane sql query my-app-db-prod --sql-file ./queries/find-orders.sql --param status=pending
```

### Examples

```bash
# Count rows
hexlane sql query my-app-db-prod --sql "SELECT COUNT(*) FROM users"

# Filter with parameters
hexlane sql query my-app-db-prod \
  --sql "SELECT id, email FROM users WHERE role = :role" \
  --param role=admin \
  --limit 10

# Dry-run a complex query
hexlane sql query my-app-db-prod --sql-file ./queries/audit.sql --dry-run

# JSON output for scripting
hexlane sql query my-app-db-prod --sql "SELECT id, name FROM products" --json | jq '[.[].name]'

# TOON output for AI/structured consumption
hexlane sql query my-app-db-prod --sql "SELECT id, name FROM products" --machine
```

---

## When to use raw commands vs operations

| Scenario                     | Recommendation                                     |
| ---------------------------- | -------------------------------------------------- |
| Exploring a schema           | `sql query`                                        |
| One-off debug query          | `sql query`                                        |
| Repeatable workflow          | Define an operation — use `op run`                 |
| Shared with team, needs docs | Define an operation with `description`, `examples` |
| AI-assisted discovery        | Operations are discoverable via `op list`          |
