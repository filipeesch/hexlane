# hexlane

A secure CLI tool for investigating and testing applications. It manages credentials automatically — fetching, caching, and auto-renewing tokens and database connections — so you never handle secrets manually.

## Features

- **Named operations** — define reusable, typed API / DB actions in app configs; run them with `op run`
- Authenticated API calls with automatic Bearer token acquisition and renewal
- Database queries with named parameters (injection-safe, bound via parameterized queries)
- Body templating in API operations — use `{{ varName }}` in path, headers, and body
- Secure credential caching with automatic expiry tracking and renewal
- Pluggable acquisition strategies: `http` (REST token endpoints), `shell` (arbitrary commands), and `static` (pre-loaded JWT stored in vault)
- JWT `exp` claim detection for accurate token expiry without configuration
- TOON output by default — compact, token-efficient format; `--json` to override
- `--dry-run` on `op run` and `db query` to preview execution without hitting anything
- `--debug` flag for tracing credential state, SQL, and HTTP details to stderr

## Prerequisites

- Node.js 20+

## Installation

```bash
git clone https://github.com/you/hexlane
cd hexlane
npm install
npm link        # installs the `hexlane` binary globally via npm link
```

---

## Quick Start

```bash
# 1. Register an app
hexlane app add --file ./my-app.yaml

# 2. Discover what's available
hexlane app list
hexlane app show my-app

# 3. Check if named operations exist (use them if they do)
hexlane op list --app my-app

# 4. Run an operation
hexlane op run my-app/get-order --env dev --profile support-user --param orderId=123
```

---

## Operations (preferred)

Operations are named, typed, discoverable actions defined in app configs. They wrap API calls or DB queries with declared parameters, path/body templating, and optional defaults for env and profile. Prefer `op run` over raw `api call` / `db query` whenever an operation is defined for the task.

### Discovering and running

```bash
hexlane op list                              # all operations across all apps
hexlane op list --app <app-id>              # filter by app
hexlane op list --filter <text>             # search name, description, and tags

hexlane op show <app/op>                    # full metadata: params, execution, examples
hexlane op validate <app/op>               # schema + cross-reference validation

# Dry-run: renders path/body templates without any network or DB call
hexlane op run payments-api/get-order \
  --env dev --profile support-user \
  --param orderId=123 --dry-run

# Live run (TOON output by default; pass --json to override)
hexlane op run payments-api/get-order \
  --env dev --profile support-user \
  --param orderId=123
```

Options: `--env`, `--profile`, `--param` (repeatable), `--dry-run`, `--limit N` (DB ops), `--json`, `--debug`

### Defining operations with `op add`

Operations are stored in the registered app YAML. Use `op add` to append one without editing the file manually.

```bash
# API operation with path and body templating
hexlane op add \
  --app payments-api \
  --name create-order \
  --kind api \
  --method POST \
  --path "/orders" \
  --body '{"type": "{{ orderType }}", "customerId": "{{ customerId }}"}' \
  --param "orderType:string:required:Order type" \
  --param "customerId:string:required:Customer ID" \
  --profile support-user \
  --default-env production \
  --description "Create a new order"

# DB operation
hexlane op add \
  --app payments-api \
  --name find-order \
  --kind db \
  --sql "SELECT id, created_at FROM orders WHERE id = :orderId" \
  --param "orderId:integer:required:Order primary key" \
  --profile readonly \
  --default-env production
```

`--param` format: `name:type:required:description`
- `type`: `string` (default), `integer`, `number`, `boolean`
- third segment: `required` (default) or `optional` — only the literal word `optional` marks it as not required
- description can contain colons

```bash
# Remove an operation
hexlane op delete payments-api/create-order
```

---

## Database queries

```bash
hexlane db query --app <app> --env <env> --profile <profile> \
  --sql "SELECT COUNT(*) FROM orders"

# Named parameters — injection-safe, bound via parameterized queries
hexlane db query --app <app> --env <env> --profile <profile> \
  --sql "SELECT id, created_at FROM orders WHERE status = :status" \
  --param status=active

# Multiple params
hexlane db query ... \
  --sql "SELECT * FROM t WHERE a = :x AND b = :y" \
  --param x=foo --param y=bar

# Preview the final SQL and bound params without connecting to the database
hexlane db query ... --sql "SELECT * FROM t WHERE id = :id" --param id=1 --dry-run

# From file
hexlane db query ... --sql-file ./query.sql
```

Options: `--dry-run`, `--json`, `--limit <n>` (default 500), `--sql-file <path>`, `--debug`

---

## API calls

API responses always return a structured envelope `{ status, headers, body }` — status code and headers are never split to stderr.

```bash
hexlane api call --app <app> --env <env> --profile <profile> \
  --method GET --path /api/v1/resource

# POST with body
hexlane api call ... --method POST --path /api/v1/resource \
  --body '{"key": "value"}'

# Body from file
hexlane api call ... --method POST --path /api/v1/resource \
  --body-file ./payload.json
```

Options: `--json` (same `{ status, headers, body }` envelope in JSON), `--body-file <path>`, `--debug`

---

## Credential management

Credentials are acquired and cached automatically on first use. Expiry is tracked and renewal happens before the credential expires.

```bash
hexlane credential list                                                   # all cached credentials with expiry
hexlane credential revoke --app <app> --env <env> --profile <profile>     # force re-acquire on next use (e.g. after 401)
```

### Static JWT profiles

For APIs that use a long-lived or externally-issued JWT, declare the profile with `acquire_strategy: static` — no URL or command needed. Load the token once using `credential set`; hexlane stores it in the encrypted vault.

```bash
# Load a token (or rotate it)
hexlane credential set \
  --app my-app --env production --profile my-service \
  --token eyJhbGciOiJSUzI1NiJ9...

# Pipe from a file or a secret manager
cat ./token.jwt | hexlane credential set --app my-app --env production --profile my-service

# If the JWT contains an exp claim, expiry is tracked automatically.
# When it expires, run credential set again with the new token.
```

---

## App management

App configs are YAML files that define environments, profiles, and credential acquisition strategies. See [`examples/payments-api.yaml`](examples/payments-api.yaml) for the full schema.

```bash
hexlane app list                               # list all registered apps
hexlane app show <app-id>                      # full config: envs, profiles, strategies
hexlane app add --file ./app-config.yaml       # register or update an app from a YAML file
hexlane app validate --file ./app-config.yaml  # validate without registering
hexlane app remove <app-id>                    # remove an app
```

---

## App Config Schema

```yaml
version: 1
app:
  id: my-app
  description: "..."

  environments:
    - name: production
      base_url: https://api.example.com   # required for api_token profiles

      profiles:
        # —————————————————————————————————————————————
        # Option A: automatically fetch a token from an auth endpoint
        # —————————————————————————————————————————————
        - name: default
          kind: api_token
          acquire_strategy:
            kind: http             # or shell
            method: POST
            url: https://auth.example.com/token
            output_mapping:
              kind: api_token
              token_path: access_token
          renewal_policy:
            ttl: 3600
            renew_before_expiry: 300

        # —————————————————————————————————————————————
        # Option B: static JWT — token is loaded once via `credential set`
        # —————————————————————————————————————————————
        - name: static-service
          kind: api_token
          acquire_strategy:
            kind: static
          # renewal_policy is optional — expiry is read from JWT exp claim automatically

  operations:
    - name: get-order
      kind: api
      description: Fetch a single order by ID
      profile: support-user
      defaultEnv: production
      tags: [orders, read]
      parameters:
        - name: orderId
          type: string
          required: true
          description: Unique order identifier
      execution:
        method: GET
        path: /orders/{{ orderId }}
```

### Auth injection

By default the token is sent as `Authorization: Bearer <token>`. Override with an `auth:` block on the profile:

```yaml
# Default — no need to specify
auth:
  kind: bearer

# Custom header name (raw token value)
auth:
  kind: header
  name: X-Api-Key

# Query parameter
auth:
  kind: query_param
  name: api_key   # appended as ?api_key=<token>
```

---

## Output Format

**TOON is the default output format for all commands.** Use `--json` only when you need JSON explicitly.

| Situation                             | Use                                             |
| ------------------------------------- | ----------------------------------------------- |
| Normal usage (rows, API responses)    | (no flag — TOON is the default)                 |
| Need JSON format                      | `--json`                                        |
| Checking HTTP status / response shape | (no flag needed — envelope is always in stdout) |
| Credential / connection issues        | `--debug`                                       |
| Preview SQL or op before executing    | `--dry-run`                                     |

---

## Workflow

1. **Discover apps** — `hexlane app list` + `hexlane app show <app-id>` to find envs and profiles.
2. **Check for operations** — `hexlane op list --app <app-id>`. If one exists for your task, use it.
3. **Before running** — `hexlane op show <app/op>` to read param names/types, then `--dry-run` to confirm the rendered request.
4. **Parameterize everything** — never interpolate values into `--sql` or path strings; always use `--param name=value`.
5. **On auth failure** — `hexlane credential revoke ...` then retry. Add `--debug` to trace the full cycle.

---

## Build

```bash
npm run build       # bundles to dist/ via ncc
npm run typecheck   # type-check without emitting
npm test            # run all tests (vitest)
```

## License

ISC
