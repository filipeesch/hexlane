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
git clone https://github.com/filipeesch/hexlane
cd hexlane
npm install
npm link        # installs the `hexlane` binary globally via npm link
```

---

## Quick Start

The fastest way to try hexlane is with the GitHub example — it uses public endpoints, so no credentials or setup are needed.

```bash
# 1. Initialize hexlane (run once — sets up local storage and vault passphrase)
hexlane init

# 2. Register the GitHub integration
hexlane integration add --file examples/github.yaml

# 3. See what operations are available
hexlane op list

# 4. Preview a request before running it
hexlane op run github/get-user --param username=torvalds --dry-run

# 5. Run it
hexlane op run github/get-user --param username=torvalds

# 6. Use filters — list open issues, 10 per page
hexlane op run github/list-issues \
  --param owner=torvalds --param repo=linux \
  --param state=open --param perPage=10
```

No vault passphrase, no `credential set`, no token needed — the `public` credential kind bypasses auth entirely.

---

## Features

- **Named operations** — typed, parameterized actions discovered and run by humans and AI agents alike
- **Integration-based architecture** — one YAML file groups targets (named tool instances) and operations for an external system
- **Template engine** — path, query, headers, and body rendered from declared parameters; `{{ name }}` syntax
- **Multi-engine SQL support** — PostgreSQL, MySQL, SQL Server, Oracle; injection-safe `:name` parameter binding
- **Pluggable credential acquisition** — `http`, `shell`, `static` strategies; `bearer`, `header`, `query_param` auth injection
- **Automatic renewal** — credentials cached in the vault, renewed before expiry using `renewal_policy`
- **Public targets** — `credential.kind: public` bypasses vault entirely for open APIs; no setup required
- **AES-256-GCM vault** — all secrets encrypted at rest; passphrase managed by OS keychain
- **Structured audit log** — every credential acquisition and HTTP/SQL call recorded (credential IDs only, no secret values)
- **AI-friendly** — `op discover`, `op list`, `op show` designed for model consumption; operations compound over time
- **Credential isolation** — credentials are never exposed to the AI model; the model only sees operation output

**Tip — custom instructions for your editor:** See [`examples/hexlane.instructions.md`](examples/hexlane.instructions.md) for a ready-to-use snippet that instructs your AI assistant to reach for hexlane automatically instead of suggesting raw curl or ad-hoc scripts.

See [`examples/github.yaml`](examples/github.yaml) for a fully working integration file using public GitHub endpoints.

---

## Documentation

| Topic                                            | Description                                                                        |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| [Operations](docs/operations.md)                 | Define, discover, and run named operations; template syntax; AI tips               |
| [Credentials](docs/credentials.md)               | Credential lifecycle, static tokens, static DB connections, vault architecture     |
| [Integration Config](docs/integration-config.md) | Integration YAML reference — targets, credential kinds, strategies, auth injection |
| [HTTP](docs/http.md)                             | Ad-hoc `http call` reference                                                       |
| [SQL](docs/sql.md)                               | Ad-hoc `sql query` reference                                                       |

---
