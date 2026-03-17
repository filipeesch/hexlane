import { Command } from "commander";
import * as fs from "fs";
import { loadAppConfig } from "../../config/loader.js";
import { getContext } from "../context.js";
import { output, outputTable, die, setJsonMode } from "../output.js";

export function registerAppCommands(program: Command): void {
    const app = program
        .command("app")
        .description("Manage registered applications");

    app
        .command("add")
        .description("Register an application from a YAML config file")
        .requiredOption("--file <path>", "Path to the app YAML config file")
        .option("--json", "Output as JSON")
        .action((opts: { file: string; json?: boolean }) => {
            if (opts.json) setJsonMode(true);
            try {
                const ctx = getContext();
                const config = ctx.apps.register(opts.file);
                output({
                    message: `App "${config.app.id}" registered successfully`,
                    app: config.app.id,
                    environments: config.app.environments.map((e: { name: string }) => e.name),
                });
            } catch (e: unknown) {
                die((e as Error).message);
            }
        });

    app
        .command("list")
        .description("List registered applications")
        .option("--json", "Output as JSON")
        .action((opts: { json?: boolean }) => {
            if (opts.json) setJsonMode(true);
            try {
                const ctx = getContext();
                const apps = ctx.apps.list();
                if (apps.length === 0) {
                    output("No applications registered. Use 'hexlane app add --file <path>'");
                    return;
                }
                outputTable(
                    apps.map((a) => ({
                        app: a.id,
                        registered_at: a.registered_at,
                        validated: a.validated ? "yes" : "no",
                    })),
                    ["app", "registered_at", "validated"]
                );
            } catch (e: unknown) {
                die((e as Error).message);
            }
        });

    app
        .command("show")
        .description("Show application config (safe — no secrets)")
        .requiredOption("--app <name>", "Application ID")
        .option("--json", "Output as JSON")
        .action((opts: { app: string; json?: boolean }) => {
            if (opts.json) setJsonMode(true);
            try {
                const ctx = getContext();
                const config = ctx.apps.get(opts.app);
                // Safe to output — config contains no secrets; strategies may have env var refs
                output({
                    id: config.app.id,
                    description: config.app.description,
                    environments: config.app.environments.map((env) => ({
                        name: env.name,
                        base_url: env.base_url,
                        profiles: env.profiles.map((p) => ({
                            name: p.name,
                            kind: p.kind,
                            strategy_kind: p.kind === "public" ? "public" : p.acquire_strategy.kind,
                            renewal_policy: p.kind === "public" ? null : p.renewal_policy,
                        })),
                    })),
                });
            } catch (e: unknown) {
                die((e as Error).message);
            }
        });

    app
        .command("validate")
        .description("Validate an application config file")
        .option("--file <path>", "Path to config file (validates before registering)")
        .option("--app <name>", "Validate already-registered app")
        .option("--json", "Output as JSON")
        .action((opts: { file?: string; app?: string; json?: boolean }) => {
            if (opts.json) setJsonMode(true);
            try {
                if (opts.file) {
                    loadAppConfig(opts.file);
                    output({ valid: true, file: opts.file });
                } else if (opts.app) {
                    const ctx = getContext();
                    ctx.apps.get(opts.app);
                    output({ valid: true, app: opts.app });
                } else {
                    die("Provide --file or --app");
                }
            } catch (e: unknown) {
                if ((e as Error).message.includes("Invalid app config")) {
                    output({ valid: false, errors: [(e as Error).message] });
                    process.exit(1);
                }
                die((e as Error).message);
            }
        });

    app
        .command("remove")
        .description("Remove a registered application and all its credentials")
        .requiredOption("--app <name>", "Application ID")
        .option("--json", "Output as JSON")
        .action((opts: { app: string; json?: boolean }) => {
            if (opts.json) setJsonMode(true);
            try {
                const ctx = getContext();
                // Revoke all active credentials for this app first
                const creds = ctx.metadata.list({ app: opts.app });
                for (const cred of creds) {
                    ctx.vault.delete(cred.vault_ref);
                    ctx.metadata.delete(cred.id);
                }
                ctx.apps.remove(opts.app);
                output({ message: `App "${opts.app}" removed`, credentials_removed: creds.length });
            } catch (e: unknown) {
                die((e as Error).message);
            }
        });
}
