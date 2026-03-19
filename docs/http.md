# Ad-hoc HTTP Commands

`hexlane http call` lets you make one-off HTTP requests against a registered target without defining a named operation. It shares the same credential resolution, vault, and audit pipeline as `op run`.

Use raw commands for exploration and debugging. Use [`op run`](operations.md) for repeatable, documented workflows.

---

## `hexlane http call`

Make a single HTTP request against a registered target.

```
hexlane http call <target-id> <path> [options]
```

### Options

| Flag                    | Description                                                  |
| ----------------------- | ------------------------------------------------------------ |
| `-m, --method <method>` | HTTP method (default: `GET`)                                 |
| `--body <json>`         | Request body as a JSON string                                |
| `--body-file <path>`    | Request body from a file                                     |
| `--query <key=value>`   | Append a query parameter to the URL — repeatable             |
| `--http-headers`        | Include response headers in the output                       |
| `--machine`             | Output TOON (structured format for AI/scripting consumption) |
| `--json`                | Output raw JSON envelope `{ status, headers?, body }`        |
| `--debug`               | Log credential state and HTTP details to stderr              |

### Response format

By default, `http call` outputs pretty-printed JSON with `status` and `body` only:

```json
{
  "status": 200,
  "body": { ... }
}
```

`body` is parsed JSON if the response `Content-Type` is JSON, otherwise a raw string. Non-2xx responses use the same shape — `status` reflects the HTTP code.

Pass `--http-headers` to include response headers:

```json
{
  "status": 200,
  "headers": {
    "content-type": "application/json",
    "x-ratelimit-remaining": "59"
  },
  "body": { ... }
}
```

Pass `--machine` to get TOON output (structured, intended for AI model consumption or scripting). Pass `--json` for a raw JSON envelope.

### Examples

```bash
# GET /users/torvalds against the github target
hexlane http call github /users/torvalds

# POST with a body
hexlane http call my-app-api-prod /orders \
  -m POST \
  --body '{"item": "widget", "qty": 2}'

# Include response headers
hexlane http call github /users/torvalds --http-headers

# Raw JSON output (e.g. to pipe to jq)
hexlane http call github /repos/torvalds/linux --json | jq '.body.stargazers_count'

# TOON output for AI/structured consumption
hexlane http call github /users/torvalds --machine
```

### Public vs authenticated targets

- **Public targets** (`credential.kind: public`) — hexlane calls the URL directly with no token. Fast and requires no vault setup.
- **Authenticated targets** — hexlane resolves or acquires a credential from the vault, injects it per the target's `auth` config, then makes the request.

Targets are registered via `hexlane integration add` — see [integration-config.md](integration-config.md).

---

## When to use raw commands vs operations

| Scenario                     | Recommendation                                     |
| ---------------------------- | -------------------------------------------------- |
| Exploring an API             | `http call`                                        |
| One-off debug request        | `http call`                                        |
| Repeatable workflow          | Define an operation — use `op run`                 |
| Shared with team, needs docs | Define an operation with `description`, `examples` |
| AI-assisted discovery        | Operations are discoverable via `op list`          |
