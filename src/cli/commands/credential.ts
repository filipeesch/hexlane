import { Command } from "commander";
import { getContext } from "../context.js";
import { output, outputTable, die, setJsonMode } from "../output.js";

export function registerCredentialCommands(program: Command): void {
    const cred = program
        .command("credential")
        .description("Inspect and manage stored credentials");

    cred
        .command("list")
        .description("List stored credentials (metadata only — no secrets)")
        .option("--app <name>", "Filter by application")
        .option("--env <name>", "Filter by environment")
        .option("--status <status>", "Filter by status: active|expired|revoked|invalid|all", "active")
        .option("--json", "Output as JSON")
        .action((opts: { app?: string; env?: string; status?: string; json?: boolean }) => {
            if (opts.json) setJsonMode(true);
            try {
                const ctx = getContext();
                const records = ctx.metadata.list({
                    app: opts.app,
                    env: opts.env,
                    status: (opts.status ?? "active") as never,
                });
                if (records.length === 0) {
                    output("No credentials found.");
                    return;
                }
                outputTable(
                    records.map((r) => ({
                        app: r.app,
                        env: r.env,
                        profile: r.profile,
                        kind: r.kind,
                        status: r.status,
                        expires_at: r.expires_at ?? "none",
                        last_used_at: r.last_used_at ?? "never",
                    })),
                    ["app", "env", "profile", "kind", "status", "expires_at", "last_used_at"]
                );
            } catch (e: unknown) {
                die((e as Error).message);
            }
        });

    cred
        .command("inspect")
        .description("Show metadata for a specific credential (no secrets)")
        .requiredOption("--app <name>", "Application ID")
        .requiredOption("--env <name>", "Environment name")
        .requiredOption("--profile <name>", "Profile name")
        .option("--json", "Output as JSON")
        .action((opts: { app: string; env: string; profile: string; json?: boolean }) => {
            if (opts.json) setJsonMode(true);
            try {
                const ctx = getContext();
                const record = ctx.metadata.findByIdentity(opts.app, opts.env, opts.profile);
                if (!record) {
                    die(`No credential found for ${opts.app}/${opts.env}/${opts.profile}`);
                }
                // Safe projection — vault_ref and id are internal, but non-secret
                output({
                    app: record.app,
                    env: record.env,
                    profile: record.profile,
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
        .requiredOption("--app <name>", "Application ID")
        .requiredOption("--env <name>", "Environment name")
        .requiredOption("--profile <name>", "Profile name")
        .option("--json", "Output as JSON")
        .action(async (opts: { app: string; env: string; profile: string; json?: boolean }) => {
            if (opts.json) setJsonMode(true);
            try {
                const ctx = getContext();
                await ctx.vault.unlock();
                await ctx.resolver.revoke(opts.app, opts.env, opts.profile);
                output({ message: `Credential revoked for ${opts.app}/${opts.env}/${opts.profile}` });
            } catch (e: unknown) {
                die((e as Error).message);
            }
        });

    cred
        .command("renew")
        .description("Force renew a credential even if not yet expired")
        .requiredOption("--app <name>", "Application ID")
        .requiredOption("--env <name>", "Environment name")
        .requiredOption("--profile <name>", "Profile name")
        .option("--json", "Output as JSON")
        .action(async (opts: { app: string; env: string; profile: string; json?: boolean }) => {
            if (opts.json) setJsonMode(true);
            try {
                const ctx = getContext();
                await ctx.vault.unlock();
                const { profile } = ctx.apps.getProfile(opts.app, opts.env, opts.profile);
                // Force expiry so resolver triggers renewal
                const existing = ctx.metadata.findByIdentity(opts.app, opts.env, opts.profile);
                if (existing) {
                    ctx.metadata.updateAfterRenewal(
                        existing.id,
                        new Date(Date.now() - 1000).toISOString(), // mark as just-expired
                        new Date().toISOString()
                    );
                }
                const record = await ctx.resolver.resolve(opts.app, opts.env, profile);
                output({
                    message: "Credential renewed",
                    app: record.app,
                    env: record.env,
                    profile: record.profile,
                    expires_at: record.expires_at,
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
