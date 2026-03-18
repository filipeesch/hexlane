# Integration Configuration

An **integration** is a single YAML file that defines everything needed to work with an external system: one or more **targets** (named, configured instances of a tool) and the **operations** available against them.

```bash
hexlane integration add --file ./github.yaml
hexlane integration list
hexlane integration show <id>
hexlane integration remove <id>
```

See [`examples/github.yaml`](../examples/github.yaml) for a fully working example using public GitHub endpoints.

---

## Structure

```yaml
version: 1
integration:
  id: my-app                  # unique identifier for this integration
  description: "My App API"   # optional

  targets:
    - id: my-app-api-prod     # unique — used in op run / http call / sql query
      tool: http              # "http" or "sql"
      config:
        base_url: https://api.example.com
      credential:
        kind: public

  operations:
    - name: get-order
      tool: http
      defaultTarget: my-app-api-prod
      ...
```

- `integration.id` — identifies the integration; used in `hexlane integration show <id>`
- `targets[].id` — the runtime namespace: `op run <target-id>/<op-name>`, `http call <target-id>`
- `operations` — live alongside targets in the same file; `defaultTarget` links an operation to its default target

---

## `targets` — Tool instances

Each target in the array is a named, configured instance of a tool pointing at a specific system.

### HTTP target

```yaml
targets:
  - id: my-app-api-prod
    tool: http
    config:
      base_url: https://api.example.com
    credential:
      kind: public
```

### SQL target

```yaml
targets:
  - id: my-app-db-prod
    tool: sql
    config:
      engine: postgresql      # postgresql | mysql | sqlserver | oracle
      host: db.prod.example.com
      port: 5432
      database: app_production
    credential:
      kind: db_connection
      acquire_strategy:
        kind: static
```

### Multiple targets in one integration

```yaml
targets:
  - id: my-app-api-staging
    tool: http
    config:
      base_url: https://staging.api.example.com
    credential:
      kind: api_token
      acquire_strategy:
        kind: static
      auth:
        kind: bearer

  - id: my-app-api-prod
    tool: http
    config:
      base_url: https://api.example.com
    credential:
      kind: api_token
      acquire_strategy:
        kind: static
      auth:
        kind: bearer

  - id: my-app-db-prod
    tool: sql
    config:
      engine: postgresql
      host: db.prod.example.com
      database: app_production
    credential:
      kind: db_connection
      acquire_strategy:
        kind: static
```

---

## `config` — Tool configuration

### HTTP config fields

| Field      | Type   | Required | Description                        |
| ---------- | ------ | -------- | ---------------------------------- |
| `base_url` | string | yes      | Base URL for all requests, no path |

### SQL config fields

| Field      | Type    | Required | Description                                     |
| ---------- | ------- | -------- | ----------------------------------------------- |
| `engine`   | string  | yes      | `postgresql`, `mysql`, `sqlserver`, or `oracle` |
| `host`     | string  | yes      | Database hostname or IP                         |
| `port`     | integer | no       | Port (defaults to engine default)               |
| `database` | string  | yes      | Database / schema name                          |

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

- `ttl` — used only when the acquired token/lease has no parseable expiry (JWT `exp`, Vault lease).
- `renew_before_expiry` — defaults to 300 s.
- `static` credentials never auto-renew.

---

## `operations` — Defining operations {#http-operation}

Operations live inside `integration.operations`. Each references a target via `defaultTarget`.

### HTTP operation

```yaml
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

**With a request body:**

```yaml
  - name: create-order
    tool: http
    defaultTarget: my-app-api-prod
    parameters:
      - name: orderType
        type: string
        required: true
      - name: customerId
        type: string
        required: true
    execution:
      method: POST
      path: /orders
      body: '{"type": "{{ orderType }}", "customerId": "{{ customerId }}"}'
      headers:
        Content-Type: application/json
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

## Full example

```yaml
version: 1
integration:
  id: github
  description: "GitHub REST API — public endpoints, no authentication required"

  targets:
    - id: github
      tool: http
      config:
        base_url: https://api.github.com
      credential:
        kind: public

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

Register and run:

```bash
hexlane integration add --file ./github.yaml
hexlane op run github/get-user --param username=torvalds
```
