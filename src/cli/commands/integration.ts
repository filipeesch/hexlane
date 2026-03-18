import { Command } from "commander";
import { getContext } from "../context.js";
import { output, outputTable, die, setJsonMode, setMachineMode } from "../output.js";

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
                        targets: integ.targets.map((t) => ({
                            id: t.id,
                            tool: t.tool,
                            config: t.config,
                            credential_kind: t.credential?.kind ?? "none",
                        })),
                        operations: (integ.operations ?? []).map((op) => ({
                            name: op.name,
                            tool: op.tool,
                            description: op.description,
                            defaultTarget: op.defaultTarget,
                        })),
                    });
                    return;
                }

                console.log(`\nIntegration: ${integ.id}`);
                if (integ.description) console.log(`  Description: ${integ.description}`);
                console.log(`\nTargets (${integ.targets.length}):`);
                for (const t of integ.targets) {
                    console.log(`  - ${t.id}  [${t.tool}]  credential: ${t.credential?.kind ?? "none"}`);
                }

                const ops = integ.operations ?? [];
                if (ops.length > 0) {
                    console.log(`\nOperations (${ops.length}):`);
                    outputTable(
                        ops.map((op) => ({
                            name: op.name,
                            tool: op.tool,
                            target: op.defaultTarget ?? "(first target)",
                            description: op.description ?? "",
                        })),
                        ["name", "tool", "target", "description"],
                    );
                } else {
                    console.log(`\nOperations: none`);
                }
                console.log();
            } catch (err) {
                die(err instanceof Error ? err.message : String(err));
            }
        });

    // ── integration remove ────────────────────────────────────────────────────
    integration
        .command("remove <id>")
        .description("Remove a registered integration (does not delete the source file)")
        .action((id: string) => {
            const ctx = getContext();
            try {
                ctx.integrations.remove(id);
                console.log(`✓ Removed integration "${id}"`);
            } catch (err) {
                die(err instanceof Error ? err.message : String(err));
            }
        });
}
