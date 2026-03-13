# hexlane

A secure CLI tool for investigating and testing applications. It manages credentials automatically — fetching, caching, and auto-renewing tokens and database connections — so you never handle secrets manually.

## Features

- Authenticated API calls with automatic Bearer token acquisition and renewal
- PostgreSQL queries with named parameters (injection-safe, bound via parameterized queries)
- Credential caching in macOS Keychain via `keytar`
- Pluggable acquisition strategies: `http` (REST token endpoints) and `shell` (arbitrary commands)
- JWT `exp` claim detection for accurate token expiry without configuration
- `--debug` flag for tracing credential state, SQL, and HTTP details to stderr
- `--toon` output for compact, token-efficient tabular data (great for LLM context)
- `--json` output for full structured responses including status and headers

## Prerequisites

- Node.js 20+
- macOS (uses Keychain for credential storage)

## Installation

```bash
git clone https://github.com/you/hexlane
cd hexlane
npm install
npm link        # installs the `hexlane` binary globally via npm link
```

## Usage

### Discover available apps

Always start here. The `kind` field on each profile tells you which command to use.

```bash
hexlane app list
hexlane app show <app-id>
```

- `api_token` → use `hexlane api call`
- `db_connection` → use `hexlane db query`

### Database queries

```bash
hexlane db query --app <app> --env <env> --profile <profile> \
  --sql "SELECT COUNT(*) FROM my_table" --json

# Named parameters (never interpolate values directly into --sql)
hexlane db query --app <app> --env <env> --profile <profile> \
  --sql "SELECT * FROM my_table WHERE id = :id" \
  --param id=123 --json

# Compact output for many flat rows
hexlane db query ... --sql "SELECT id, status FROM my_table LIMIT 50" --toon
```

Options: `--json`, `--toon`, `--limit <n>` (default 500), `--sql-file <path>`, `--debug`

### API calls

```bash
hexlane api call --app <app> --env <env> --profile <profile> \
  --method GET --path /api/v1/resource --json

# POST with body
hexlane api call ... --method POST --path /api/v1/resource \
  --body '{"key": "value"}' --json
```

Options: `--json` (returns `{ status, headers, body }`), `--toon`, `--body-file <path>`, `--debug`

### Credential management

```bash
hexlane credential list                                          # all cached credentials + expiry
hexlane credential show --app <app> --env <env> --profile <profile>
hexlane credential revoke --app <app> --env <env> --profile <profile>  # force re-acquire (e.g. after 401)
```

### Registering an app

App configs are YAML files. See [`examples/payments-api.yaml`](examples/payments-api.yaml) for the full schema.

```bash
hexlane app add --file ./my-app.yaml
hexlane app validate --file ./my-app.yaml   # dry-run validation
hexlane app remove <app-id>
```

## App Config Schema

```yaml
version: 1
app:
  id: my-app
  description: "..."

  environments:
    - name: production
      base_url: https://api.example.com

      profiles:
        - name: default
          kind: api_token          # or db_connection
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
```

## Build

```bash
npm run build       # bundles to dist/ via ncc
npm run typecheck   # type-check without emitting
```

## Investigation Workflow

1. `hexlane app list` + `hexlane app show <app-id>` — find the right env and profile
2. Match `kind` to command (`db_connection` → `db query`, `api_token` → `api call`)
3. Use `--toon` for large flat result sets, `--json` for structured/nested data
4. On 401 or auth errors: `hexlane credential revoke ...` then retry
5. On any failure: add `--debug` to trace the full request/response cycle

## License

ISC
