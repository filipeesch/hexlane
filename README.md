# hexlane

**hexlane** is interface layer for interacting with external systems through a unified CLI, it can access Web APIs, databases, and more (Kafka support planned). It is designed to be used by humans and AI models alike.

The core idea is a shared library of **named operations**: typed, parameterized actions that any caller — human or AI — can discover and execute against registered systems. An AI model with access to terminal can answer questions and perform tasks expressed in natural language, translating them into hexlane commands. The model reasons; hexlane executes, credential-free from the model's perspective.

Two roles work in concert:
- **Humans** register applications, environments, and credentials — defining what systems can be accessed and how authentication works.
- **AI agents and humans** operate within that perimeter: listing available operations, composing new ones at runtime with `op add`, and executing them safely with named parameters.

Operations are persistent. Every operation an agent defines becomes a reusable, discoverable building block for future sessions — the agent's operational knowledge compounds over time.

---

## Natural language examples

When hexlane is available as a tool to an AI model, requests expressed in natural language become executable workflows across multiple systems.

**Example 1 — Cross-system investigation**
> *"Use hexlane to pull the transaction record for TXN-9921 from the database and check its current status on the payments API — I want to know if the two are consistent."*

The agent queries the transactions database for the raw record, calls the payments API with the same transaction ID, and compares the state reported by each system — flagging any discrepancy between them.

**Example 2 — Cross-referencing data across services**
> *"Use hexlane to get all orders placed in the last 7 days with status failed, then for each one fetch the customer's name and contact email from the customers API and give me a single joined view."*

The agent queries the orders database filtered by date and status, then calls the customers API once per result to fetch the profile. It returns a correlated table — no manual joins, no credential handling.

**Example 3 — Detecting inconsistencies between systems**
> *"Use hexlane to find all subscription plans marked as inactive in our database that are still showing as available in the billing API — I suspect there's a sync problem."*

The agent queries the database for inactive plans, calls the billing API for each to check visibility, and produces a list of entries that are out of sync across both systems — giving the human a concrete starting point to investigate.

---

## Security model

Credentials are **never visible to the AI model** or stored in plain text. The vault is the only place secrets live.

- All credentials (tokens, DB passwords) are encrypted with **AES-256-GCM** and stored in `~/.hexlane/vault/` on the local machine
- The encryption key is derived from a passphrase using **scrypt** (CPU/memory-hard KDF) — the passphrase itself is never written to disk
- The passphrase is stored in the **OS secret store** after first use: macOS Keychain, Windows Credential Manager, or Linux libsecret (GNOME Keyring / KWallet). In CI or headless environments, set `HEXLANE_VAULT_PASSPHRASE` as an environment variable
- When an AI model invokes hexlane, it only sees operation output (API responses, query rows) — never the credentials used to obtain them
- Audit logs record every credential acquisition and API/DB call (credential IDs only, no secret values)

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

The fastest way to try hexlane is with the GitHub example — it uses public endpoints, so no credentials or setup are needed.

```bash
# 1. Register the GitHub app (operations are baked in)
hexlane app add --file examples/github.yaml

# 2. See what operations are available
hexlane op list --app github

# 3. Preview a request before running it
hexlane op run github/get-user --param username=torvalds --dry-run

# 4. Run it
hexlane op run github/get-user --param username=torvalds

# 5. Use filters — list open issues, 10 per page
hexlane op run github/list-issues \
  --param owner=torvalds --param repo=linux \
  --param state=open --param perPage=10
```

No vault passphrase, no `credential set`, no token needed — the `public` profile bypasses auth entirely.

---

## Operations (preferred)

Operations are named, typed, discoverable actions defined in app configs. They wrap API calls or DB queries with declared parameters, path/body templating, and optional defaults for env and profile. Prefer `op run` over raw `api call` / `db query` whenever an operation is defined for the task.

Operations can be created and managed entirely through natural language. Tell the AI model what you want to do, and it will define the appropriate operation using `op add` — choosing the right method, path, parameters, and profile. You never need to write the command yourself.

> *"Use hexlane to create an operation that fetches a user profile from the GitHub API."*
> *"Use hexlane to add a DB operation that queries the orders table for all rows with a given status."*
> *"Use hexlane to remove the create-draft operation from payments-api."*

**Using an OpenAPI spec as context:** If your API has an OpenAPI (Swagger) file, share it with the model. It contains all the paths, methods, parameters, and schemas the model needs to define accurate operations without guessing. You can paste it directly into the conversation or reference it as a file attachment.

**Tip — custom instructions for your editor:** For the best experience, configure your AI assistant (Cursor, GitHub Copilot, or similar) with custom rules that instruct it to always use hexlane when interacting with registered applications. This ensures the model reaches for `op list`, `op run`, and `op add` automatically rather than suggesting raw curl or ad-hoc scripts. See [`examples/hexlane.instructions.md`](examples/hexlane.instructions.md) for a ready-to-use starting point.

### Discovering and running

```bash
hexlane op list                              # all operations across all apps
hexlane op list --app <app-id>              # filter by app
hexlane op list --filter <text>             # search name, description, and tags

hexlane op show <app/op>                    # full metadata: params, execution, examples
hexlane op validate <app/op>               # schema + cross-reference validation

# Dry-run: renders path/query/body templates without any network or DB call
hexlane op run github/list-issues \
  --param owner=torvalds --param repo=linux \
  --param state=open --dry-run

# Live run (TOON output by default; pass --json to override)
hexlane op run github/get-user \
  --param username=torvalds
```

Options: `--env`, `--profile`, `--param` (repeatable), `--dry-run`, `--limit N` (DB ops), `--json`, `--debug`

### Defining operations with `op add`

Operations are stored in the registered app YAML. Use `op add` to append one without editing the file manually — or simply ask the AI model to do it for you in natural language.

```bash
# API operation with path and query templating
hexlane op add \
  --app github \
  --name list-releases \
  --kind api \
  --method GET \
  --path "/repos/{{ owner }}/{{ repo }}/releases" \
  --param "owner:string:required:Repository owner" \
  --param "repo:string:required:Repository name" \
  --param "perPage:integer:optional:Results per page" \
  --profile public \
  --default-env public \
  --description "List releases for a public repository"

# DB operation
hexlane op add \
  --app my-app \
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
hexlane op delete github/list-releases
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

### Static credentials

For credentials that are externally managed and can't be fetched automatically, declare the profile with `acquire_strategy: static` and load the value once with `credential set`. hexlane stores it in the encrypted vault.

**API token (JWT or opaque):**
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

**Database connection string:**
```bash
# Supported schemes: postgresql, mysql, sqlserver, oracle
hexlane credential set \
  --app my-app --env production --profile static-db \
  --connection-string "postgresql://user:pass@host:5432/dbname?sslmode=require"

# Pull from an environment variable or secret manager to avoid shell history
hexlane credential set --app my-app --env production --profile static-db \
  --connection-string "$DATABASE_URL"
```

---

## App management

App configs are YAML files that define environments, profiles, and credential acquisition strategies. See [`examples/github.yaml`](examples/github.yaml) for a fully working example.

```bash
hexlane app list                               # list all registered apps
hexlane app show <app-id>                      # full config: envs, profiles, strategies
hexlane app add --file ./my-app.yaml           # register or update an app from a YAML file
hexlane app validate --file ./my-app.yaml      # validate without registering
hexlane app remove <app-id>                    # remove an app
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
