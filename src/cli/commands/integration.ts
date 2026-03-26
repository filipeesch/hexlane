import { Command } from "commander";
import { getContext } from "../context.js";
import { output, outputTable, die, setJsonMode, setMachineMode } from "../output.js";
import { loadIntegrationConfig, validateIntegrationConfig } from "../../config/integration-store.js";

export function registerIntegrationCommands(program: Command): void {
    const integration = program
        .command("integration")
        .description("Manage registered integrations");

    // ── integration add ───────────────────────────────────────────────────────
    integration
        .command("add")
        .description("Register an integration from a YAML file")
        .requiredOption("--file <path>", "Path to the integration YAML file")
        .option("--json", "Output as JSON")
        .action((opts: { file: string; json?: boolean }) => {
            if (opts.json) setJsonMode(true);

            const ctx = getContext();
            try {
                const config = ctx.integrations.register(opts.file);
                const id = config.integration.id;
                const targetCount = config.integration.targets.length;
                const opCount = config.integration.operations?.length ?? 0;

                if (opts.json) {
                    output({ registered: true, id, targets: targetCount, operations: opCount });
                } else {
                    console.log(`✓ Registered integration "${id}" (${targetCount} target(s), ${opCount} operation(s))`);
                }
            } catch (err) {
                die(err instanceof Error ? err.message : String(err));
            }
        });

    // ── integration list ──────────────────────────────────────────────────────
    integration
        .command("list")
        .description("List registered integrations")
        .option("--json", "Output as JSON")
        .option("--machine", "Output as TOON (structured format for AI/scripting consumption)")
        .action((opts: { json?: boolean; machine?: boolean }) => {
            if (opts.json) setJsonMode(true);
            if (opts.machine) setMachineMode(true);

            const ctx = getContext();
            const entries = ctx.integrations.list();

            if (entries.length === 0) {
                console.error("No integrations registered. Use 'hexlane integration add --file <path>'");
                return;
            }

            outputTable(
                entries.map((e) => ({
                    id: e.id,
                    config_path: e.config_path,
                    registered_at: e.registered_at,
                })),
                ["id", "config_path", "registered_at"],
            );
        });

    // ── integration show ──────────────────────────────────────────────────────
    integration
        .command("show <id>")
        .description("Show details for a registered integration")
        .option("--json", "Output as JSON")
        .option("--machine", "Output as TOON (structured format for AI/scripting consumption)")
        .action((id: string, opts: { json?: boolean; machine?: boolean }) => {
            if (opts.json) setJsonMode(true);
            if (opts.machine) setMachineMode(true);

            const ctx = getContext();
            try {
                const config = ctx.integrations.get(id);
                const integ = config.integration;

                if (opts.json || opts.machine) {
                    // Redact credentials from output
                    output({
                        id: integ.id,
                        description: integ.description,
                        defaultTarget: integ.defaultTarget,
                        targets: integ.targets.map((t) => ({
                            id: t.id,
                            tools: t.tools.map((tc) => ({
                                type: tc.type,
                                config: tc.config,
                                credential_kind: tc.credential?.kind ?? "none",
                            })),
                        })),
                        operations: (integ.operations ?? []).map((op) => ({
                            name: op.name,
                            tool: op.tool,
                            description: op.description,
                        })),
                    });
                    return;
                }

                console.log(`\nIntegration: ${integ.id}`);
                if (integ.description) console.log(`  Description: ${integ.description}`);
                if (integ.defaultTarget) console.log(`  Default target: ${integ.defaultTarget}`);
                console.log(`\nTargets (${integ.targets.length}):`);
                for (const t of integ.targets) {
                    console.log(`  - ${t.id}`);
                    for (const tc of t.tools) {
                        const credKind = tc.credential?.kind ?? "none";
                        const configStr = Object.entries(tc.config).map(([k, v]) => `${k}=${v}`).join("  ");
                        console.log(`      ${tc.type}  ${configStr}  credential: ${credKind}`);
                    }
                }

                const ops = integ.operations ?? [];
                if (ops.length > 0) {
                    console.log(`\nOperations (${ops.length}):`);
                    outputTable(
                        ops.map((op) => ({
                            name: op.name,
                            tool: op.tool,
                            description: op.description ?? "",
                        })),
                        ["name", "tool", "description"],
                    );
                } else {
                    console.log(`\nOperations: none`);
                }
                console.log();
            } catch (err) {
                die(err instanceof Error ? err.message : String(err));
            }
        });

    // ── integration validate ───────────────────────────────────────────────────
    integration
        .command("validate")
        .description("Validate an integration config file or a registered integration")
        .option("--file <path>", "Path to a YAML file to validate (not yet registered)")
        .option("--id <id>", "Re-validate an already-registered integration")
        .option("--json", "Output as JSON")
        .action((opts: { file?: string; id?: string; json?: boolean }) => {
            if (opts.json) setJsonMode(true);
            if (!opts.file && !opts.id) {
                die("Provide --file <path> or --id <id>");
                return;
            }
            if (opts.file) {
                const result = validateIntegrationConfig(opts.file);
                if (result.valid) {
                    output({ valid: true, file: opts.file });
                } else {
                    output({ valid: false, errors: result.errors });
                    process.exit(1);
                }
                return;
            }
            // --id: re-validate the stored copy
            const ctx = getContext();
            try {
                const config = ctx.integrations.get(opts.id!);
                output({ valid: true, id: config.integration.id });
            } catch (err) {
                output({ valid: false, id: opts.id, errors: [err instanceof Error ? err.message : String(err)] });
                process.exit(1);
            }
        });

    // ── integration remove ────────────────────────────────────────────────────
    integration
        .command("remove <id>")
        .description("Remove a registered integration and all its credentials")
        .option("--json", "Output as JSON")
        .action(async (id: string, opts: { json?: boolean }) => {
            if (opts.json) setJsonMode(true);
            const ctx = getContext();
            try {
                const creds = ctx.metadata.list({ app: id });
                if (creds.length > 0) {
                    await ctx.vault.unlock();
                    for (const cred of creds) {
                        ctx.vault.delete(cred.vault_ref);
                        ctx.metadata.delete(cred.id);
                    }
                }
                ctx.integrations.remove(id);
                output({ message: `Integration "${id}" removed`, credentials_removed: creds.length });
            } catch (err) {
                die(err instanceof Error ? err.message : String(err));
            }
        });
}
