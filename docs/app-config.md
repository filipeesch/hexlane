# App Config Reference

App configs are YAML files that define the environments, profiles, and operations for a single application. Register a config with `hexlane app add --file ./my-app.yaml`. Re-run the same command to update it.

See [`examples/github.yaml`](../examples/github.yaml) for a fully working example using public GitHub endpoints.

---

## Top-level structure

```yaml
version: 1
app:
  id: my-app                    # required — lowercase alphanumeric, dashes allowed
  description: "My application" # optional

  environments:
    - name: production           # at least one environment required
      base_url: https://api.example.com  # required for api_token and public profiles
      profiles:
        - ...

  operations:                    # optional — can be managed via `hexlane op add` instead
    - ...
```

- `id` — unique identifier used in all hexlane commands: `op run my-app/...`, `credential list --app my-app`
- `base_url` — base URL prepended to all operation paths and `api call` paths for this environment
- `operations` — can be defined here or added/removed via CLI without editing the file

---

## Profile kinds

Each profile declares how hexlane acquires credentials for a given environment. Profiles are referenced by name in operations and `--profile` flags.

### `kind: public`

No authentication. hexlane calls the API directly with no token — no vault, no credential acquisition.

```yaml
profiles:
  - name: public
    kind: public
```

Use this for open APIs (e.g. GitHub public endpoints, public REST APIs). Operations using this profile can be run immediately with no setup.

---

### `kind: api_token` with `acquire_strategy: http`

Fetches a token from an authentication endpoint before making API calls. Token is cached and renewed automatically.

```yaml
profiles:
  - name: default
    kind: api_token
    acquire_strategy:
      kind: http
      method: POST
      url: https://auth.example.com/token
      headers:                        # optional — static request headers
        Content-Type: application/json
      body: '{"clientId": "...", "secret": "..."}' # optional — request body
      output_mapping:
        kind: api_token
        token_path: access_token       # dot-notation path into the response JSON
        expires_at_path: expires_at    # optional — ISO8601 or Unix timestamp
        error_path: error.message      # optional — surfaced on auth failure
        trace_id_path: request_id      # optional — included in audit logs
    renewal_policy:
      ttl: 3600                        # fallback expiry in seconds (if no exp in response)
      renew_before_expiry: 300         # proactively renew 5 min before expiry
```

`token_path`, `expires_at_path`, etc. use dot notation to navigate nested JSON (`result.token`, `data.auth.access_token`).

---

### `kind: api_token` with `acquire_strategy: shell`

Runs a shell command to acquire a token. Useful for CLIs that wrap proprietary auth systems.

```yaml
profiles:
  - name: cli-auth
    kind: api_token
    acquire_strategy:
      kind: shell
      command: "my-auth-cli token get --app my-app --output json"
      output_mapping:
        kind: api_token
        token_path: token
        expires_at_path: expires_at
    renewal_policy:
      ttl: 1800
      renew_before_expiry: 300
```

The command must output valid JSON to stdout. `output_mapping` extracts fields from that JSON using dot-notation paths.

---

### `kind: api_token` with `acquire_strategy: static` {#static-strategy}

Token is stored once manually via `hexlane credential set`. No acquisition happens automatically.

```yaml
profiles:
  - name: static-service
    kind: api_token
    acquire_strategy:
      kind: static
    # auth injection defaults to Bearer — override below if needed
    # renewal_policy is optional; JWT exp claim is read automatically
```

Load the token:
```bash
hexlane credential set \
  --app my-app --env production --profile static-service \
  --token eyJhbGciOiJSUzI1NiJ9...
```

See [credentials.md](credentials.md#static-api-token) for full rotation details.

---

### `kind: db_connection` with `acquire_strategy: shell`

Runs a shell command to acquire DB credentials. The command must return JSON with connection fields.

```yaml
profiles:
  - name: readonly
    kind: db_connection
    acquire_strategy:
      kind: shell
      command: "db-cli credentials get --env production --role readonly --output json"
      output_mapping:
        kind: db_connection
        unwrap_array: true        # if command outputs [{...}], extracts first element
        host_path: hostname
        port_path: port
        user_path: username
        password_path: password
        dbname_path: database
        lease_id_path: id         # optional — Vault-style lease ID for native renewal
        expires_at_path: expires  # optional — ISO8601 or Unix timestamp
        ssl_mode: require         # optional static override
    renewal_policy:
      ttl: 172800                 # 48 hours
      renew_before_expiry: 3600
```

`output_mapping` fields for `db_connection`:

| Field                                        | Description                                         |
| -------------------------------------------- | --------------------------------------------------- |
| `host_path`                                  | JSON path to hostname                               |
| `port_path`                                  | JSON path to port number                            |
| `user_path`                                  | JSON path to username                               |
| `password_path`                              | JSON path to password                               |
| `dbname_path`                                | JSON path to database name                          |
| `auth_token_path`                            | JSON path to auth token (e.g. AWS RDS IAM token)    |
| `auth_token_value: raw`                      | Entire output is a raw auth token string (not JSON) |
| `expires_at_path`                            | JSON path to expiry timestamp                       |
| `lease_id_path`                              | JSON path to lease/decision ID                      |
| `unwrap_array`                               | `true` to unwrap single-element array output        |
| `host`, `user`, `dbname`, `ssl_mode`, `port` | Static overrides applied after path extraction      |
| `error_path`, `trace_id_path`                | Error message and trace ID paths for diagnostics    |

---

### `kind: db_connection` with `acquire_strategy: static`

Connection details stored once manually via `hexlane credential set --connection-string`.

```yaml
profiles:
  - name: static-db
    kind: db_connection
    acquire_strategy:
      kind: static
    # No renewal_policy needed unless you want TTL-based expiry reminders
```

Load the connection string:
```bash
hexlane credential set \
  --app my-app --env production --profile static-db \
  --connection-string "postgresql://user:pass@host:5432/dbname?sslmode=require"
```

Supported schemes: `postgresql`/`postgres`, `mysql`, `sqlserver`/`mssql`, `oracle`.

---

## Auth injection

Controls how the token is sent for `api_token` profiles. Defaults to `Authorization: Bearer <token>` if omitted.

```yaml
# Default — no need to specify
auth:
  kind: bearer

# Custom header name, raw token value (no "Bearer " prefix)
auth:
  kind: header
  name: X-Api-Key

# Token appended as a query parameter
auth:
  kind: query_param
  name: api_key     # results in ?api_key=<token>
```

---

## Operations in config

Operations can be defined directly in the YAML or added via `hexlane op add`. Both approaches produce the same result — `op add` writes to the YAML file.

### API operation

```yaml
operations:
  - name: get-user              # lowercase alphanumeric-dashes
    kind: api
    description: Fetch a GitHub user profile
    profile: public             # default profile — overridable with --profile
    defaultEnv: public          # default env — overridable with --env
    tags: [users, read]
    readOnly: true              # informational; does not enforce anything
    parameters:
      - name: username
        type: string            # string | integer | number | boolean
        required: true
        description: GitHub username
    execution:
      method: GET
      path: /users/{{ username }}
      query:                    # optional — rendered and appended as query string
        state: "{{ state }}"    # empty values are omitted automatically
        per_page: "{{ perPage }}"
      headers:                  # optional — static or templated
        X-Custom: "{{ traceId }}"
      body: '{"key": "{{ val }}"}'  # optional — templated JSON body
    examples:
      - description: Fetch the torvalds profile
        command: hexlane op run github/get-user --param username=torvalds
```

### DB operation

```yaml
operations:
  - name: find-orders
    kind: db
    description: Find orders by status
    profile: readonly
    defaultEnv: production
    tags: [orders, read]
    readOnly: true              # default true for db ops
    parameters:
      - name: status
        type: string
        required: true
        description: Order status
    execution:
      sql: "SELECT id, created_at FROM orders WHERE status = :status"
      # PostgreSQL ::type casts are safe — they don't conflict with :name params
      # e.g. "SELECT id::text FROM orders WHERE created_at > :since::timestamp"
    examples:
      - description: Find all failed orders
        command: hexlane op run my-app/find-orders --param status=failed
```

---

## App management commands

```bash
hexlane app list                               # list all registered apps
hexlane app show <app-id>                      # full config: envs, profiles, strategy kinds
hexlane app add --file ./my-app.yaml           # register or update
hexlane app validate --file ./my-app.yaml      # validate without registering
hexlane app remove <app-id>                    # remove app and its stored credentials
```
