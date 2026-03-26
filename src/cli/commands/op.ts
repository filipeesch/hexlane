import { Command } from "commander";
import * as fs from "fs";
import * as yaml from "js-yaml";
import { getContext } from "../context.js";
import { output, outputTable, outputApiResponse, die, setJsonMode, setMachineMode } from "../output.js";
import { setDebugMode } from "../debug.js";
import { IntegrationOperationRegistry } from "../../operations/integration-registry.js";
import { resolveParams, ParamValidationError } from "../../operations/param-resolver.js";
import { renderApiExecution, renderDbExecution } from "../../operations/renderer.js";
import { executeApiCall } from "../../executors/api-executor.js";
import { executeDbQuery } from "../../executors/db-executor.js";
import { addIntegrationOperationFromRaw, editIntegrationOperation, deleteIntegrationOperation, getIntegrationOperationYaml } from "../../operations/op-writer.js";
import type { HttpOperation, SqlOperation } from "../../operations/schema.js";

async function readStdin(): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
        process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        process.stdin.on("error", reject);
    });
}

export function registerOpCommands(program: Command): void {
    const op = program
        .command("op")
        .description("Manage and run named operations");

    // ── op list ──────────────────────────────────────────────────────────────
    op
        .command("list")
        .description("List available operations")
        .option("--integration <id>", "Filter by integration ID")
        .option("--filter <text>", "Case-insensitive text filter (matches ref, tool, name, description, tags)")
        .option("--json", "Output as JSON")
        .option("--machine", "Output as TOON (structured format for AI/scripting consumption)")
        .action((opts: { integration?: string; filter?: string; json?: boolean; machine?: boolean }) => {
            if (opts.json) setJsonMode(true);
            if (opts.machine) setMachineMode(true);

            const ctx = getContext();
            const intRegistry = new IntegrationOperationRegistry(ctx.integrations);
            const rows = intRegistry.list(opts.integration, opts.filter).map((e) => ({
                ref: e.integrationRef,
                tool: e.operation.tool,
                description: e.operation.description ?? "",
                tags: (e.operation.tags ?? []).join(", "),
            }));

            if (rows.length === 0) {
                if (opts.integration) {
                    console.error(`No operations found for integration "${opts.integration}".`);
                } else if (opts.filter) {
                    console.error(`No operations match filter "${opts.filter}".`);
                } else {
                    console.error(`No operations registered. Add an 'operations:' key to an integration config and re-register it.`);
                }
                return;
            }

            outputTable(rows, ["ref", "tool", "description", "tags"]);
        });

    // ── op show ───────────────────────────────────────────────────────────────
    op
        .command("show <ref>")
        .description("Show raw YAML for an integration operation")
        .action((ref: string) => {
            const ctx = getContext();
            const intRegistry = new IntegrationOperationRegistry(ctx.integrations);
            if (!intRegistry.hasIntegrationRef(ref)) {
                die(`Operation "${ref}" not found. Use 'hexlane op list' to see available operations.`);
                return;
            }
            const entry = intRegistry.lookupByIntegrationRef(ref);
            const intEntries = ctx.integrations.list();
            const intEntry = intEntries.find((e) => e.id === entry.integrationId);
            if (!intEntry) {
                die(`Integration "${entry.integrationId}" config not found.`);
                return;
            }
            try {
                const yamlText = getIntegrationOperationYaml(intEntry.config_path, entry.operation.name);
                process.stdout.write(yamlText);
            } catch (err) {
                die(err instanceof Error ? err.message : String(err));
            }
        });

    // ── op targets ────────────────────────────────────────────────────────────
    op
        .command("targets <ref>")
        .description("List targets compatible with an integration operation (e.g. hexlane op targets bsp/sync)")
        .option("--json", "Output as JSON")
        .action((ref: string, opts: { json?: boolean }) => {
            if (opts.json) setJsonMode(true);

            const ctx = getContext();
            const intRegistry = new IntegrationOperationRegistry(ctx.integrations);
            if (!intRegistry.hasIntegrationRef(ref)) {
                die(`Operation "${ref}" not found. Use 'hexlane op list' to see available operations.`);
                return;
            }
            const entry = intRegistry.lookupByIntegrationRef(ref);
            const compatible = intRegistry.getCompatibleTargets(entry.integrationId, entry.operation.tool);

            if (opts.json) {
                output({ ref, tool: entry.operation.tool, targets: compatible });
                return;
            }

            if (compatible.length === 0) {
                console.log(`No targets in integration "${entry.integrationId}" support tool "${entry.operation.tool}".`);
                return;
            }

            outputTable(
                compatible.map((t) => ({
                    target: t,
                    default: t === entry.targetId ? "✓" : "",
                })),
                ["target", "default"],
            );
        });

    // ── op run ────────────────────────────────────────────────────────────────
    op
        .command("run <ref>")
        .description("Run an operation (e.g. hexlane op run bsp/list-broker-integrations)")
        .option("--target <target-id>", "Override the executing target (must belong to the same integration as the op)")
        .option("--param <key=value>", "Parameter value, repeatable", (val: string, prev: string[]) => [...prev, val], [] as string[])
        .option("--dry-run", "Render the execution template and print it — no network or DB calls, no credentials accessed")
        .option("--limit <n>", "Max rows returned for DB operations (default: 500)", parseInt)
        .option("--http-headers", "Include response headers in output (API operations only)")
        .option("--json", "Output as JSON")
        .option("--machine", "Output as TOON (structured format for AI/scripting consumption)")
        .option("--debug", "Enable verbose debug logging to stderr")
        .action(async (ref: string, opts: {
            target?: string;
            param: string[];
            dryRun?: boolean;
            limit?: number;
            httpHeaders?: boolean;
            json?: boolean;
            machine?: boolean;
            debug?: boolean;
        }) => {
            if (opts.json) setJsonMode(true);
            if (opts.machine) setMachineMode(true);
            if (opts.debug) setDebugMode(true);

            try {
                const ctx = getContext();

                // Parse --param key=value
                const rawParams: Record<string, string> = {};
                for (const p of opts.param) {
                    const eq = p.indexOf("=");
                    if (eq < 1) die(`Invalid --param "${p}": expected format key=value`);
                    rawParams[p.slice(0, eq)] = p.slice(eq + 1);
                }

                // ── Try new integration model first ──────────────────────────
                const intRegistry = new IntegrationOperationRegistry(ctx.integrations);
                if (intRegistry.hasIntegrationRef(ref)) {
                    const base = intRegistry.lookupByIntegrationRef(ref);
                    const { integrationId, operation } = base;

                    // Resolve target
                    let targetId: string;
                    if (opts.target) {
                        const override = intRegistry.lookupWithTargetOverride(ref, opts.target);
                        targetId = override.targetId!;
                    } else if (base.targetId) {
                        targetId = base.targetId;
                    } else {
                        const compatible = intRegistry.getCompatibleTargets(integrationId, operation.tool);
                        die(
                            `Integration "${integrationId}" has no defaultTarget. ` +
                            `Use --target with one of: ${compatible.join(", ")}`
                        );
                        return;
                    }

                    const intConfig = ctx.integrations.get(integrationId);
                    const target = intConfig.integration.targets.find((t) => t.id === targetId);
                    if (!target) {
                        die(`Target "${targetId}" not found in integration "${integrationId}".`);
                        return;
                    }

                    // Find the tool config within the target
                    const toolConfig = target.tools.find((tc) => tc.type === operation.tool);
                    if (!toolConfig) {
                        const compatible = intRegistry.getCompatibleTargets(integrationId, operation.tool);
                        die(
                            `Target "${targetId}" does not support tool "${operation.tool}". ` +
                            `Compatible targets: ${compatible.join(", ")}`
                        );
                        return;
                    }

                    // target.params are the base; only inject keys this operation declares
                    const knownParamNames = new Set(operation.parameters.map((p) => p.name));
                    const filteredTargetParams = Object.fromEntries(
                        Object.entries(target.params ?? {}).filter(([k]) => knownParamNames.has(k))
                    );
                    const mergedRawParams = { ...filteredTargetParams, ...rawParams };

                    let resolvedParams;
                    try {
                        resolvedParams = resolveParams(operation, mergedRawParams);
                    } catch (err) {
                        if (err instanceof ParamValidationError) die(err.message);
                        throw err;
                    }

                    if (opts.dryRun) {
                        if (operation.tool === "http") {
                            const rendered = renderApiExecution(operation.execution, resolvedParams);
                            const plan: Record<string, unknown> = {
                                "dry-run": true,
                                ref,
                                target: targetId,
                                method: rendered.method,
                                path: rendered.path,
                            };
                            if (rendered.query) plan["query"] = rendered.query;
                            if (rendered.headers) plan["headers"] = rendered.headers;
                            if (rendered.body) plan["body"] = rendered.body;
                            if (target.params && Object.keys(target.params).length > 0) {
                                plan["target_params"] = target.params;
                            }
                            output(plan);
                        } else {
                            const rendered = renderDbExecution(operation.execution, resolvedParams);
                            const plan: Record<string, unknown> = {
                                "dry-run": true,
                                ref,
                                target: targetId,
                                sql: rendered.sql,
                                params: rendered.params,
                            };
                            if (target.params && Object.keys(target.params).length > 0) {
                                plan["target_params"] = target.params;
                            }
                            output(plan);
                        }
                        return;
                    }

                    await ctx.vault.unlock();

                    if (!toolConfig.credential) {
                        die(`Target "${targetId}" ${operation.tool} tool has no credential configured.`);
                        return;
                    }

                    if (operation.tool === "http") {
                        const baseUrl = toolConfig.config["base_url"] as string | undefined;
                        if (!baseUrl) {
                            die(`Target "${targetId}" is missing config.base_url for http tool.`);
                            return;
                        }
                        const httpOp = operation as HttpOperation;
                        const rendered = renderApiExecution(httpOp.execution, resolvedParams);
                        const credential = await ctx.resolver.resolveForTarget(integrationId, targetId, toolConfig.credential);
                        const result = await executeApiCall(ctx.vault, credential, ctx.audit, {
                            method: rendered.method,
                            path: rendered.path,
                            query: rendered.query,
                            body: rendered.body,
                            baseUrl,
                            auth: toolConfig.credential.kind === "api_token" ? toolConfig.credential.auth : undefined,
                        });
                        outputApiResponse(result, opts.httpHeaders ?? false);
                    } else {
                        const sqlOp = operation as SqlOperation;
                        const rendered = renderDbExecution(sqlOp.execution, resolvedParams);
                        const credential = await ctx.resolver.resolveForTarget(integrationId, targetId, toolConfig.credential);
                        if (!credential) {
                            die(`Target "${targetId}" credential resolved to null — check credential kind.`);
                            return;
                        }
                        const result = await executeDbQuery(
                            ctx.vault,
                            credential,
                            ctx.audit,
                            rendered.sql,
                            opts.limit ?? 500,
                            rendered.params,
                        );
                        outputTable(result.rows, result.fields);
                    }
                    return;
                }

                die(`Operation "${ref}" not found. Use 'hexlane op list' to see available operations.`);
            } catch (err) {
                if (err instanceof Error) {
                    die(err.message);
                }
                throw err;
            }
        });

    // ── op add ────────────────────────────────────────────────────────────────
    op
        .command("add")
        .description("Add an operation to a registered integration")
        .requiredOption("--integration <id>", "Integration ID")
        .option("--raw <yaml>", "Operation YAML inline")
        .option("--file <path>", "YAML file to read from; use - for stdin")
        .action(async (opts: {
            integration: string;
            raw?: string;
            file?: string;
        }) => {
            if (!opts.raw && !opts.file) {
                die("Provide --raw <yaml> or --file <path> (use - for stdin).");
                return;
            }

            const ctx = getContext();
            const intEntries = ctx.integrations.list();
            const intEntry = intEntries.find((e) => e.id === opts.integration);
            if (!intEntry) {
                die(`Integration "${opts.integration}" is not registered. Use 'hexlane integration add --file <path>'`);
                return;
            }

            let rawYaml: string;
            if (opts.raw) {
                rawYaml = opts.raw;
            } else if (opts.file === "-") {
                rawYaml = await readStdin();
            } else {
                if (!fs.existsSync(opts.file!)) {
                    die(`File not found: ${opts.file}`);
                    return;
                }
                rawYaml = fs.readFileSync(opts.file!, "utf8");
            }

            try {
                const operation = addIntegrationOperationFromRaw(intEntry.config_path, rawYaml);
                console.log(`✓ Added operation "${operation.name}" to integration "${opts.integration}"`);
            } catch (err) {
                die(err instanceof Error ? err.message : String(err));
            }
        });

    // ── op edit ───────────────────────────────────────────────────────────────
    op
        .command("edit <ref>")
        .description("Replace an integration operation in-place (e.g. hexlane op edit bsp/sync --raw '...')")
        .option("--raw <yaml>", "Operation YAML inline")
        .option("--file <path>", "YAML file to read from; use - for stdin")
        .action(async (ref: string, opts: { raw?: string; file?: string }) => {
            if (!opts.raw && !opts.file) {
                die("Provide --raw <yaml> or --file <path> (use - for stdin).");
                return;
            }

            const slash = ref.indexOf("/");
            if (slash < 1) {
                die(`Invalid ref "${ref}": expected format integration-id/op-name`);
                return;
            }
            const integrationId = ref.slice(0, slash);
            const opName = ref.slice(slash + 1);

            const ctx = getContext();
            const intRegistry = new IntegrationOperationRegistry(ctx.integrations);
            if (!intRegistry.hasIntegrationRef(ref)) {
                die(`Operation "${ref}" not found. Use 'hexlane op list' to see available operations.`);
                return;
            }

            const intEntries = ctx.integrations.list();
            const intEntry = intEntries.find((e) => e.id === integrationId);
            if (!intEntry) {
                die(`Integration "${integrationId}" config not found.`);
                return;
            }

            let rawYaml: string;
            if (opts.raw) {
                rawYaml = opts.raw;
            } else if (opts.file === "-") {
                rawYaml = await readStdin();
            } else {
                if (!fs.existsSync(opts.file!)) {
                    die(`File not found: ${opts.file}`);
                    return;
                }
                rawYaml = fs.readFileSync(opts.file!, "utf8");
            }

            try {
                editIntegrationOperation(intEntry.config_path, opName, rawYaml);
                console.log(`✓ Updated operation "${opName}" in integration "${integrationId}"`);
            } catch (err) {
                die(err instanceof Error ? err.message : String(err));
            }
        });

    // ── op delete ─────────────────────────────────────────────────────────────
    op
        .command("delete <ref>")
        .description("Remove an operation from a registered integration or app config (e.g. bsp/sync)")
        .action((ref: string) => {
            const slash = ref.indexOf("/");
            if (slash < 1) {
                die(`Invalid ref "${ref}": expected format id/operation-name`);
                return;
            }
            const scopeId = ref.slice(0, slash);
            const opName = ref.slice(slash + 1);

            const ctx = getContext();

            const intRegistry = new IntegrationOperationRegistry(ctx.integrations);
            if (!intRegistry.hasIntegrationRef(ref)) {
                die(`Operation "${ref}" not found. Use 'hexlane op list' to see available operations.`);
                return;
            }
            const entry = intRegistry.lookupByIntegrationRef(ref);
            const intEntries = ctx.integrations.list();
            const intEntry = intEntries.find((e) => e.id === entry.integrationId);
            if (!intEntry) {
                die(`Integration "${entry.integrationId}" config not found.`);
                return;
            }
            try {
                deleteIntegrationOperation(intEntry.config_path, opName);
                console.log(`✓ Removed operation "${opName}" from integration "${entry.integrationId}"`);
            } catch (err) {
                die(err instanceof Error ? err.message : String(err));
            }
        });
}
