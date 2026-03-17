# Credentials

hexlane manages credentials automatically — fetching, caching, and renewing tokens and DB connections so neither humans nor AI models need to handle secrets directly.

---

## Lifecycle

On every `op run`, `api call`, or `db query`, hexlane:

1. **Looks up** the cached credential for the app/env/profile identity in SQLite metadata
2. **Checks expiry** — if the credential expires within `renew_before_expiry` seconds (default 300), it proactively renews
3. **Acquires** a new credential if none exists — running the configured strategy (`http` or `shell`)
4. **Injects** the credential into the request — the model or human never sees it

All secret values (tokens, passwords) are stored encrypted in the vault. SQLite holds only safe metadata: expiry timestamps, status, host/dbname for DB connections.

---

## Commands

```bash
# List all cached credentials (metadata only — no secrets shown)
hexlane credential list
hexlane credential list --app <id>
hexlane credential list --env <env>
hexlane credential list --status expired   # active (default) | expired | revoked | all

# Show metadata for a specific credential
hexlane credential inspect --app <id> --env <env> --profile <name>

# Force re-acquire on next use (e.g. after a 401)
hexlane credential revoke --app <id> --env <env> --profile <name>

# Force renew now even if not yet expired
hexlane credential renew --app <id> --env <env> --profile <name>

# Remove expired and revoked entries from vault and metadata
hexlane credential cleanup
```

**On auth failure:** run `credential revoke` then retry the original command. Add `--debug` to trace the full acquisition cycle.

---

## Static credentials

For credentials that are externally managed — long-lived JWTs, service account keys, direct DB passwords — declare the profile with `acquire_strategy: static` and load the value once with `credential set`. hexlane stores it encrypted in the vault and tracks expiry automatically.

See [app-config.md](app-config.md#static-strategy) for how to declare a static profile.

### Static API token

```bash
# Load a token (or rotate it by running the same command again)
hexlane credential set \
  --app my-app --env production --profile my-service \
  --token eyJhbGciOiJSUzI1NiJ9...

# Pipe from a file
cat ./token.jwt | hexlane credential set \
  --app my-app --env production --profile my-service

# Pull from a secret manager without touching the filesystem
vault kv get -field=token secret/my-service | hexlane credential set \
  --app my-app --env production --profile my-service
```

If the token is a JWT with an `exp` claim, expiry is extracted automatically — no `renewal_policy.ttl` needed. When it expires, run `credential set` again with the new token.

### Static DB connection string

```bash
# Supported schemes: postgresql, mysql, sqlserver, oracle
hexlane credential set \
  --app my-app --env production --profile static-db \
  --connection-string "postgresql://user:pass@host:5432/dbname?sslmode=require"

# Use an environment variable to avoid exposing the password in shell history
hexlane credential set --app my-app --env production --profile static-db \
  --connection-string "$DATABASE_URL"
```

The connection string is parsed and broken into discrete fields (host, port, user, password, dbname, ssl_mode) before being stored encrypted. The scheme determines the engine:

| Scheme | Engine |
|---|---|
| `postgresql://` or `postgres://` | PostgreSQL |
| `mysql://` | MySQL |
| `sqlserver://` or `mssql://` | SQL Server |
| `oracle://` | Oracle |

`?sslmode=` is parsed from the query string — accepted values: `disable`, `require`, `verify-full`.

---

## Vault architecture

All secrets are encrypted with **AES-256-GCM** and stored in `~/.hexlane/vault/`. The encryption key is derived from a passphrase using **scrypt** (a CPU/memory-hard KDF). The passphrase is never written to disk.

After first use, the passphrase is saved to the **OS secret store**:
- **macOS** — Keychain
- **Windows** — Credential Manager
- **Linux** — libsecret (GNOME Keyring / KWallet)

In CI or headless environments, skip the interactive prompt entirely by setting:

```bash
export HEXLANE_VAULT_PASSPHRASE="your-passphrase"
```

AI models invoking hexlane via MCP or a CLI agent only ever see operation output (API responses, query rows) — vault contents are never surfaced. Audit logs record every acquisition and call using credential IDs only, never secret values.

---

## Automatic renewal strategies

For `api_token` and `db_connection` profiles using `http` or `shell` strategies, configure `renewal_policy` in the app YAML:

```yaml
renewal_policy:
  ttl: 3600              # fallback expiry in seconds — used when the strategy output has no exp field
  renew_before_expiry: 300  # proactively renew this many seconds before expiry (default: 300)
```

- `ttl` is only needed when the strategy output contains no parseable expiry. JWT `exp` claims and Vault lease durations are read automatically.
- `renew_before_expiry` defaults to 300 seconds (5 minutes) — tune this for short-lived tokens.
- Static profiles (`acquire_strategy: static`) do not auto-renew. Rotation is manual via `credential set`.
