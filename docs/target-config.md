# Target & App Spec Configuration

hexlane uses two YAML file types:

- **Target YAML** — registers a named instance of a tool (`http` or `sql`) that points at a specific system, along with its credential configuration
- **App spec YAML** — declares the operations for an application

Both are separate files. An app spec can be applied against multiple targets (e.g. `my-app-api-staging`, `my-app-api-prod`).

See [`examples/github-target.yaml`](../examples/github-target.yaml) and [`examples/github-ops.yaml`](../examples/github-ops.yaml) for fully working examples using public GitHub endpoints.

---

## Target YAML

```bash
hexlane target add --file ./my-target.yaml
hexlane target list
hexlane target show <id>
hexlane target remove <id>
```

### Minimal structure

```yaml
version: 1
target:
  id: my-app-api-prod         # unique identifier used in op run / http call
  app: my-app                 # app spec this target belongs to
  tool: http                  # "http" or "sql"
  config:
    base_url: https://api.example.com
  credential:
    kind: public              # no auth
```

### Full structure

```yaml
version: 1
target:
  id: my-app-api-prod
  app: my-app
  tool: http                  # "http" or "sql"

  config:
    base_url: https://api.example.com
    # For sql targets:
    # engine: postgresql       # postgresql | mysql | sqlserver | oracle
    # host: db.example.com
    # port: 5432
    # database: my_db

  credential:
    kind: public              # public | api_token | db_connection
    acquire_strategy:
      kind: static            # static | http | shell
    auth:
      kind: bearer            # bearer | basic | header | query_param | none
    renewal_policy:
      ttl: 3600
      renew_before_expiry: 300
```

---

## `config` — Tool configuration

### HTTP target config

| Field      | Type   | Required | Description                        |
| ---------- | ------ | -------- | ---------------------------------- |
| `base_url` | string | yes      | Base URL for all requests, no path |

```yaml
config:
  base_url: https://api.github.com
```

### SQL target config

| Field      | Type    | Required | Description                                     |
| ---------- | ------- | -------- | ----------------------------------------------- |
| `engine`   | string  | yes      | `postgresql`, `mysql`, `sqlserver`, or `oracle` |
| `host`     | string  | yes      | Database hostname or IP                         |
| `port`     | integer | no       | Port (defaults to engine default)               |
| `database` | string  | yes      | Database / schema name                          |

```yaml
config:
  engine: postgresql
  host: db.prod.example.com
  port: 5432
  database: app_production
```

---

## `credential` — Credential configuration

### `kind`

| Value           | When to use                                           |
| --------------- | ----------------------------------------------------- |
| `public`        | No auth required — endpoints are publicly accessible  |
| `api_token`     | HTTP API with token-based auth (bearer, header, etc.) |
| `db_connection` | Database connection (SQL targets)                     |

---

## `acquire_strategy` — How credentials are obtained

### `static`

The credential is supplied manually via `hexlane credential set`. hexlane stores it encrypted and injects it on every call. No auto-renewal.

```yaml
credential:
  kind: api_token
  acquire_strategy:
    kind: static
  auth:
    kind: bearer
```

Load the token:
```bash
hexlane credential set --target my-app-api-prod --token eyJhbGc...
```

### `http`

hexlane calls an HTTP endpoint to obtain a token. The response is parsed for `access_token`/`token` fields and an optional expiry.

```yaml
credential:
  kind: api_token
  acquire_strategy:
    kind: http
    url: https://auth.example.com/oauth/token
    method: POST
    body: |
      {
        "client_id": "{{ CLIENT_ID }}",
        "client_secret": "{{ CLIENT_SECRET }}",
        "grant_type": "client_credentials"
      }
    headers:
      Content-Type: application/json
  auth:
    kind: bearer
  renewal_policy:
    renew_before_expiry: 300
```

`{{ VAR }}` in the strategy body and headers are resolved from environment variables at acquire time.

### `shell`

hexlane runs a shell command to obtain a token. stdout is used as the token value.

```yaml
credential:
  kind: api_token
  acquire_strategy:
    kind: shell
    command: "aws eks get-token --cluster-name my-cluster | jq -r .status.token"
  auth:
    kind: bearer
  renewal_policy:
    ttl: 600
    renew_before_expiry: 60
```

---

## `auth` — How credentials are injected into requests {#static-strategy}

Applies to `api_token` targets only.

### `bearer`

```yaml
auth:
  kind: bearer
```

Sets `Authorization: Bearer <token>`.

### `basic`

```yaml
auth:
  kind: basic
  username: my-client-id    # optional — resolved from env var if omitted
```

Sets `Authorization: Basic <b64(username:token)>`.

### `header`

```yaml
auth:
  kind: header
  header_name: X-API-Key
```

Sets `X-API-Key: <token>`.

### `query_param`

```yaml
auth:
  kind: query_param
  param_name: api_key
```

Appends `?api_key=<token>` to the request URL.

---

## `renewal_policy`

```yaml
renewal_policy:
  ttl: 3600              # fallback expiry in seconds when no exp is parseable from the token
  renew_before_expiry: 300  # proactively renew this many seconds before expiry
```

- `ttl` — used only when the acquired token/lease has no parseable expiry (JWT `exp`, Vault lease). Omit when the strategy always returns an expiry.
- `renew_before_expiry` — defaults to 300 s. Tune down for tokens with very short lifetimes.
- `static` credentials never auto-renew.

---

## App spec YAML

App specs live separately from targets. They hold the operations for an application. Register an app spec with:

```bash
hexlane app add --file ./my-app-ops.yaml
hexlane app list
hexlane app show <app-id>
hexlane app remove <app-id>
```

### Structure

```yaml
version: 1
app:
  id: my-app
  operations:
    - name: get-order
      tool: http
      defaultTarget: my-app-api-prod
      description: Fetch a single order by ID
      parameters:
        - name: orderId
          type: integer
          required: true
          description: Order primary key
      execution:
        method: GET
        path: /orders/{{ orderId }}

    - name: find-orders
      tool: sql
      defaultTarget: my-app-db-prod
      description: Query orders by status
      parameters:
        - name: status
          type: string
          required: true
          description: "Order status: pending, active, failed"
      execution:
        sql: SELECT id, created_at, total FROM orders WHERE status = :status
```

### HTTP operation {#http-operation}

```yaml
- name: create-order
  tool: http
  defaultTarget: my-app-api-prod
  parameters:
    - name: orderType
      type: string
      required: true
      description: Order type
    - name: customerId
      type: string
      required: true
      description: Customer ID
  execution:
    method: POST
    path: /orders
    body: '{"type": "{{ orderType }}", "customerId": "{{ customerId }}"}'
    headers:
      Content-Type: application/json
```

**With query parameters** — optional params placed in `query:`. Missing/empty values are omitted automatically:

```yaml
- name: list-issues
  tool: http
  defaultTarget: github
  parameters:
    - name: owner
      type: string
      required: true
    - name: repo
      type: string
      required: true
    - name: state
      type: string
      required: false
      description: "open, closed, or all"
    - name: perPage
      type: integer
      required: false
  execution:
    method: GET
    path: /repos/{{ owner }}/{{ repo }}/issues
    query:
      state: "{{ state }}"
      per_page: "{{ perPage }}"
```

### SQL operation

```yaml
- name: find-failed-charges
  tool: sql
  defaultTarget: my-app-db-prod
  parameters:
    - name: since
      type: string
      required: true
      description: ISO 8601 timestamp — return rows after this time
  execution:
    sql: |
      SELECT id, amount, reason
      FROM charges
      WHERE status = 'failed'
        AND created_at > :since
      ORDER BY created_at DESC
```

SQL placeholders use `:name` syntax. PostgreSQL `::type` casts (e.g. `:since::timestamptz`) are supported and do not conflict.

---

## Full example — HTTP target + app spec

**`github-target.yaml`** (target)

```yaml
version: 1
target:
  id: github
  app: github
  tool: http
  config:
    base_url: https://api.github.com
  credential:
    kind: public
```

**`github-ops.yaml`** (app spec)

```yaml
version: 1
app:
  id: github
  operations:
    - name: get-user
      tool: http
      defaultTarget: github
      description: Fetch a GitHub user profile
      parameters:
        - name: username
          type: string
          required: true
          description: GitHub username
      execution:
        method: GET
        path: /users/{{ username }}

    - name: list-repos
      tool: http
      defaultTarget: github
      description: List public repositories for a user
      parameters:
        - name: username
          type: string
          required: true
        - name: perPage
          type: integer
          required: false
      execution:
        method: GET
        path: /users/{{ username }}/repos
        query:
          per_page: "{{ perPage }}"
```

Register both:

```bash
hexlane target add --file ./github-target.yaml
hexlane app add --file ./github-ops.yaml
```

Run:

```bash
hexlane op run github/get-user --param username=torvalds
```
