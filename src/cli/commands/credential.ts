import { Command } from "commander";
import * as crypto from "crypto";
import { getContext } from "../context.js";
import { output, outputTable, die, setJsonMode } from "../output.js";
import { VaultManager } from "../../vault/vault-manager.js";
import { tryDecodeJwtExp } from "../../strategies/output-mapper.js";
import type { CredentialRecord } from "../../metadata/store.js";

function defaultPort(engine: string): number {
    const ports: Record<string, number> = { postgresql: 5432, mysql: 3306, sqlserver: 1433, oracle: 1521 };
    return ports[engine] ?? 5432;
}

async function readStdin(): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
        process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        process.stdin.on("error", reject);
    });
}

export function registerCredentialCommands(program: Command): void {
    const cred = program
        .command("credential")
        .description("Inspect and manage stored credentials");

    cred
        .command("list")
        .description("List stored credentials (metadata only — no secrets)")
        .option("--integration <id>", "Filter by integration ID")
        .option("--target <target-id>", "Filter by target ID")
        .option("--status <status>", "Filter by status: active|expired|revoked|invalid|all", "active")
        .option("--json", "Output as JSON")
        .action((opts: { integration?: string; target?: string; status?: string; json?: boolean }) => {
            if (opts.json) setJsonMode(true);
            try {
                const ctx = getContext();
                const records = ctx.metadata.list({
                    app: opts.integration,
                    env: opts.target,
                    status: (opts.status ?? "active") as never,
                });
                if (records.length === 0) {
                    output("No credentials found.");
                    return;
                }
                outputTable(
                    records.map((r) => ({
                        integration: r.app,
                        target: r.env,
                        kind: r.kind,
                        status: r.status,
                        expires_at: r.expires_at ?? "none",
                        last_used_at: r.last_used_at ?? "never",
                    })),
                    ["integration", "target", "kind", "status", "expires_at", "last_used_at"]
                );
            } catch (e: unknown) {
                die((e as Error).message);
            }
        });

    cred
        .command("inspect")
        .description("Show metadata for a specific credential (no secrets)")
        .requiredOption("--target <target-id>", "Target ID")
        .option("--json", "Output as JSON")
        .action((opts: { target: string; json?: boolean }) => {
            if (opts.json) setJsonMode(true);
            try {
                const ctx = getContext();
                const found = ctx.integrations.findByTargetId(opts.target);
                if (!found) die(`Target "${opts.target}" not found in any registered integration.`);
                const { integrationId, target } = found;
                if (!target.credential) die(`Target "${opts.target}" has no credential configured.`);
                const profileName = target.credential.kind;
                const record = ctx.metadata.findByIdentity(integrationId, opts.target, profileName);
                if (!record) {
                    die(`No credential found for target "${opts.target}" — it may not have been acquired yet.`);
                }
                // Safe projection — vault_ref and id are internal, but non-secret
                output({
                    integration: record.app,
                    target: record.env,
                    kind: record.kind,
                    status: record.status,
                    renewable: Boolean(record.renewable),
                    created_at: record.created_at,
                    updated_at: record.updated_at,
                    expires_at: record.expires_at,
                    last_used_at: record.last_used_at,
                    db_host: record.db_host,
                    db_name: record.db_name,
                    db_engine: record.db_engine,
                });
            } catch (e: unknown) {
                die((e as Error).message);
            }
        });

    cred
        .command("revoke")
        .description("Revoke a credential and delete it from the vault")
        .requiredOption("--target <target-id>", "Target ID")
        .option("--json", "Output as JSON")
        .action(async (opts: { target: string; json?: boolean }) => {
            if (opts.json) setJsonMode(true);
            try {
                const ctx = getContext();
                const found = ctx.integrations.findByTargetId(opts.target);
                if (!found) die(`Target "${opts.target}" not found in any registered integration.`);
                const { integrationId, target } = found;
                if (!target.credential) die(`Target "${opts.target}" has no credential configured.`);
                await ctx.vault.unlock();
                await ctx.resolver.revoke(integrationId, opts.target, target.credential.kind);
                output({ message: `Credential revoked for target "${opts.target}"` });
            } catch (e: unknown) {
                die((e as Error).message);
            }
        });

    cred
        .command("renew")
        .description("Force renew a credential even if not yet expired")
        .requiredOption("--target <target-id>", "Target ID")
        .option("--json", "Output as JSON")
        .action(async (opts: { target: string; json?: boolean }) => {
            if (opts.json) setJsonMode(true);
            try {
                const ctx = getContext();
                const found = ctx.integrations.findByTargetId(opts.target);
                if (!found) die(`Target "${opts.target}" not found in any registered integration.`);
                const { integrationId, target } = found;
                if (!target.credential) die(`Target "${opts.target}" has no credential configured.`);
                await ctx.vault.unlock();
                // Force expiry so resolver triggers renewal on next resolveForTarget call
                const existing = ctx.metadata.findByIdentity(integrationId, opts.target, target.credential.kind);
                if (existing) {
                    ctx.metadata.updateAfterRenewal(
                        existing.id,
                        new Date(Date.now() - 1000).toISOString(), // mark as just-expired
                        new Date().toISOString()
                    );
                }
                const record = await ctx.resolver.resolveForTarget(integrationId, opts.target, target.credential);
                output({
                    message: "Credential renewed",
                    integration: integrationId,
                    target: opts.target,
                    kind: target.credential.kind,
                    expires_at: record?.expires_at ?? null,
                });
            } catch (e: unknown) {
                die((e as Error).message);
            }
        });

    cred
        .command("set")
        .description("Store a static credential in the vault for a target with acquire_strategy: static")
        .requiredOption("--target <target-id>", "Target ID")
        .option("--token <value>", "(api_token) Token value (omit to read from stdin)")
        .option("--connection-string <url>", "(db_connection) e.g. postgresql://user:pass@host:5432/dbname?sslmode=require")
        .option("--json", "Output as JSON")
        .action(async (opts: { target: string; token?: string; connectionString?: string; json?: boolean }) => {
            if (opts.json) setJsonMode(true);
            try {
                const ctx = getContext();

                const found = ctx.integrations.findByTargetId(opts.target);
                if (!found) die(`Target "${opts.target}" not found in any registered integration.`);
                const { integrationId, target } = found;

                if (!target.credential) {
                    die(`Target "${opts.target}" has no credential configured.`);
                    return;
                }
                if (target.credential.kind === "public") {
                    die(`Target "${opts.target}" is kind "public" — public targets need no credential.`);
                    return;
                }
                if (target.credential.acquire_strategy.kind !== "static") {
                    die(`Target "${opts.target}" uses acquire_strategy "${target.credential.acquire_strategy.kind}", not "static". Only static targets require manual credential loading.`);
                    return;
                }

                await ctx.vault.unlock();

                const profileName = target.credential.kind;
                const vaultRef = VaultManager.vaultRef(integrationId, opts.target, profileName);
                const now = new Date();
                const renewalTtl = target.credential.renewal_policy?.ttl;

                // ── Static DB connection string ──────────────────────────────────────
                if (target.credential.kind === "db_connection") {
                    if (!opts.connectionString) {
                        die("Provide --connection-string <url>, e.g. postgresql://user:pass@host:5432/dbname");
                    }

                    let connUrl: URL;
                    try {
                        connUrl = new URL(opts.connectionString!);
                    } catch {
                        die("Invalid connection string — must be a valid URL, e.g. postgresql://user:pass@host:5432/dbname");
                        return;
                    }

                    const schemeToEngine: Record<string, string> = {
                        postgresql: "postgresql",
                        postgres: "postgresql",
                        mysql: "mysql",
                        sqlserver: "sqlserver",
                        mssql: "sqlserver",
                        oracle: "oracle",
                    };
                    const scheme = connUrl.protocol.replace(/:$/, "");
                    const engine = schemeToEngine[scheme];
                    if (!engine) {
                        die(`Unsupported scheme "${scheme}" — supported: postgresql, mysql, sqlserver, oracle`);
                        return;
                    }

                    const host = connUrl.hostname;
                    const port = connUrl.port ? parseInt(connUrl.port, 10) : defaultPort(engine);
                    const user = decodeURIComponent(connUrl.username);
                    const password = decodeURIComponent(connUrl.password);
                    const dbname = connUrl.pathname.replace(/^\//, "");

                    if (!host || !user || !password || !dbname) {
                        die("Connection string must include host, user, password, and database name");
                    }

                    const rawSslMode = connUrl.searchParams.get("sslmode");
                    const sslMode = ["disable", "require", "verify-full"].includes(rawSslMode ?? "")
                        ? (rawSslMode as "disable" | "require" | "verify-full")
                        : undefined;

                    const expiresAt: string | null = renewalTtl
                        ? new Date(now.getTime() + renewalTtl * 1000).toISOString()
                        : null;

                    ctx.vault.write(vaultRef, { kind: "db_connection", engine: engine as import("../../vault/types.js").DbEngine, host, port, user, password, dbname, ssl_mode: sslMode });

                    const existing = ctx.metadata.findByIdentity(integrationId, opts.target, profileName);
                    const dbRecord: CredentialRecord = {
                        id: existing?.id ?? crypto.randomUUID(),
                        app: integrationId,
                        env: opts.target,
                        profile: profileName,
                        kind: "db_connection",
                        status: "active",
                        renewable: false,
                        vault_ref: vaultRef,
                        created_at: existing?.created_at ?? now.toISOString(),
                        updated_at: now.toISOString(),
                        expires_at: expiresAt,
                        last_used_at: null,
                        db_host: host,
                        db_name: dbname,
                        db_engine: engine,
                    };
                    ctx.metadata.upsert(dbRecord);

                    output({
                        message: `Credential stored for target "${opts.target}"`,
                        integration: integrationId,
                        engine,
                        host,
                        port,
                        user,
                        dbname,
                        ssl_mode: sslMode ?? "default",
                        expires_at: expiresAt ?? "no expiry",
                    });
                    return;
                }

                // ── Static API token ─────────────────────────────────────────────────
                let token: string;
                if (opts.token) {
                    token = opts.token.trim();
                } else {
                    if (process.stdin.isTTY) {
                        die("Provide --token <value> or pipe the token via stdin");
                    }
                    token = (await readStdin()).trim();
                }
                if (!token) die("Token cannot be empty");

                // Parse JWT exp claim for expiry tracking; fall back to renewal_policy.ttl
                const jwtExpiry = tryDecodeJwtExp(token);
                let expiresAt: string | null = null;
                if (jwtExpiry) {
                    expiresAt = jwtExpiry.toISOString();
                } else if (renewalTtl) {
                    expiresAt = new Date(now.getTime() + renewalTtl * 1000).toISOString();
                }

                ctx.vault.write(vaultRef, { kind: "api_token", token });

                const existing = ctx.metadata.findByIdentity(integrationId, opts.target, profileName);
                const record: CredentialRecord = {
                    id: existing?.id ?? crypto.randomUUID(),
                    app: integrationId,
                    env: opts.target,
                    profile: profileName,
                    kind: "api_token",
                    status: "active",
                    renewable: false,
                    vault_ref: vaultRef,
                    created_at: existing?.created_at ?? now.toISOString(),
                    updated_at: now.toISOString(),
                    expires_at: expiresAt,
                    last_used_at: null,
                    db_host: null,
                    db_name: null,
                    db_engine: null,
                };
                ctx.metadata.upsert(record);

                output({
                    message: `Credential stored for target "${opts.target}"`,
                    integration: integrationId,
                    expires_at: expiresAt ?? "no expiry",
                });
            } catch (e: unknown) {
                die((e as Error).message);
            }
        });

    cred
        .command("cleanup")
        .description("Remove expired and revoked credentials from vault and metadata")
        .option("--json", "Output as JSON")
        .action(async (opts: { json?: boolean }) => {
            if (opts.json) setJsonMode(true);
            try {
                const ctx = getContext();
                await ctx.vault.unlock();
                const { removed } = ctx.resolver.cleanup();
                output({ message: `Cleanup complete`, credentials_removed: removed });
            } catch (e: unknown) {
                die((e as Error).message);
            }
        });
}
