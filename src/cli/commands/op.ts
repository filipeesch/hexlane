import { Command } from "commander";
import * as fs from "fs";
import * as yaml from "js-yaml";
import { getContext } from "../context.js";
import { output, outputTable, outputApiResponse, die, setJsonMode, setMachineMode } from "../output.js";
import { setDebugMode } from "../debug.js";
import { OperationRegistry } from "../../operations/registry.js";
import { IntegrationOperationRegistry } from "../../operations/integration-registry.js";
import { resolveParams, ParamValidationError } from "../../operations/param-resolver.js";
import { renderApiExecution, renderDbExecution } from "../../operations/renderer.js";
import { validateOperation } from "../../operations/validator.js";
import { executeApiCall } from "../../executors/api-executor.js";
import { executeDbQuery } from "../../executors/db-executor.js";
import { parseParamSpec, buildOperation, addOperationToFile, deleteOperationFromFile, addIntegrationOperationFromRaw, editIntegrationOperation, deleteIntegrationOperation, getIntegrationOperationYaml } from "../../operations/op-writer.js";
import type { ApiOperation, DbOperation } from "../../operations/schema.js";
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
        .option("--app <app>", "Filter by app ID (legacy model)")
        .option("--integration <id>", "Filter by integration ID")
        .option("--filter <text>", "Case-insensitive text filter (matches ref, tool, name, description, tags)")
        .option("--json", "Output as JSON")
        .option("--machine", "Output as TOON (structured format for AI/scripting consumption)")
        .action((opts: { app?: string; integration?: string; filter?: string; json?: boolean; machine?: boolean }) => {
            if (opts.json) setJsonMode(true);
            if (opts.machine) setMachineMode(true);

            const ctx = getContext();

            // New integration model entries
            const intRegistry = new IntegrationOperationRegistry(ctx.integrations);
            const intEntries = opts.app
                ? []
                : intRegistry.list(opts.integration, opts.filter).map((e) => ({
                    ref: e.integrationRef,
                    tool: e.operation.tool,
                    description: e.operation.description ?? "",
                    tags: (e.operation.tags ?? []).join(", "),
                }));

            // Legacy app model entries
            const legacyRegistry = new OperationRegistry(ctx.apps);
            const legacyEntries = opts.integration
                ? []
                : legacyRegistry.list(opts.app, opts.filter).map((e) => ({
                    ref: e.ref,
                    tool: e.operation.kind,
                    description: e.operation.description ?? "",
                    tags: (e.operation.tags ?? []).join(", "),
                }));

            const rows = [...intEntries, ...legacyEntries];

            if (rows.length === 0) {
                if (opts.integration) {
                    console.error(`No operations found for integration "${opts.integration}".`);
                } else if (opts.app) {
                    console.error(`No operations found for app "${opts.app}".`);
                } else if (opts.filter) {
                    console.error(`No operations match filter "${opts.filter}".`);
                } else {
                    console.error(`No operations registered. Add an 'operations:' key to an integration or app config and re-register it.`);
                }
                return;
            }

            outputTable(rows, ["ref", "tool", "description", "tags"]);
        });

    // ── op show ───────────────────────────────────────────────────────────────
    op
        .command("show <ref>")
        .description("Show raw YAML for an integration operation or metadata for a legacy operation")
        .option("--json", "Output as JSON (legacy model only)")
        .option("--machine", "Output as TOON (legacy model only)")
        .action((ref: string, opts: { json?: boolean; machine?: boolean }) => {
            const ctx = getContext();

            // Integration model → raw YAML output (pipeable)
            const intRegistry = new IntegrationOperationRegistry(ctx.integrations);
            if (intRegistry.hasIntegrationRef(ref)) {
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
                return;
            }

            // Fall back to legacy model
            if (opts.json) setJsonMode(true);
            if (opts.machine) setMachineMode(true);

            const registry = new OperationRegistry(ctx.apps);
            const entry = registry.lookup(ref);
            const op = entry.operation;

            if (opts.json || opts.machine) {
                output({ app: entry.appId, ...op });
                return;
            }

            // Human-readable output
            console.log(`\nOperation: ${entry.ref}`);
            console.log(`  Kind:        ${op.kind}`);
            console.log(`  App:         ${entry.appId}`);
            if (op.description) console.log(`  Description: ${op.description}`);
            if (op.profile) console.log(`  Default profile: ${op.profile}`);
            if (op.defaultEnv) console.log(`  Default env:     ${op.defaultEnv}`);
            if (op.tags?.length) console.log(`  Tags:        ${op.tags.join(", ")}`);
            if (op.kind === "db") console.log(`  Read-only:   ${op.readOnly}`);

            if (op.parameters.length > 0) {
                console.log(`\nParameters:`);
                outputTable(
                    op.parameters.map((p) => ({
                        name: p.name,
                        type: p.type,
                        required: String(p.required !== false),
                        description: p.description ?? "",
                    })),
                    ["name", "type", "required", "description"],
                );
            } else {
                console.log(`\nParameters: none`);
            }

            if (op.kind === "api") {
                const exec = op.execution;
                console.log(`\nExecution:`);
                console.log(`  ${exec.method} ${exec.path}`);
                if (exec.body) console.log(`  Body: ${exec.body}`);
                if (exec.headers) {
                    for (const [k, v] of Object.entries(exec.headers)) {
                        console.log(`  Header: ${k}: ${v}`);
                    }
                }
            } else {
                console.log(`\nExecution:`);
                console.log(`  SQL: ${op.execution.sql}`);
            }

            if (op.examples?.length) {
                console.log(`\nExamples:`);
                for (const ex of op.examples) {
                    console.log(`  # ${ex.description}`);
                    console.log(`  ${ex.command}`);
                }
            }

            console.log(`\nProfile: ${op.profile ? `${op.profile} (default, override with --profile)` : "required — pass --profile at runtime"}`);
            console.log();
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

    // ── op validate ───────────────────────────────────────────────────────────
    op
        .command("validate <ref>")
        .description("Validate an operation's schema and cross-references")
        .option("--json", "Output as JSON")
        .action((ref: string, opts: { json?: boolean }) => {
            if (opts.json) setJsonMode(true);

            const ctx = getContext();
            const registry = new OperationRegistry(ctx.apps);
            const entry = registry.lookup(ref);

            const result = validateOperation(entry.appId, entry.operation, ctx.apps);

            if (opts.json) {
                output({ ref, valid: result.valid, errors: result.errors });
                return;
            }

            if (result.valid) {
                console.log(`✓ ${ref} is valid`);
            } else {
                console.error(`✗ ${ref} has ${result.errors.length} error(s):`);
                for (const err of result.errors) {
                    console.error(`  • ${err}`);
                }
                process.exit(1);
            }
        });

    // ── op run ────────────────────────────────────────────────────────────────
    op
        .command("run <ref>")
        .description("Run an operation (e.g. hexlane op run bsp/list-broker-integrations)")
        .option("--target <target-id>", "Override the executing target (must belong to the same integration as the op)")
        .option("--env <name>", "Environment name (legacy model — overrides defaultEnv from the operation)")
        .option("--profile <name>", "Profile name (legacy model — overrides default profile from the operation)")
        .option("--param <key=value>", "Parameter value, repeatable", (val: string, prev: string[]) => [...prev, val], [] as string[])
        .option("--dry-run", "Render the execution template and print it — no network or DB calls, no credentials accessed")
        .option("--limit <n>", "Max rows returned for DB operations (default: 500)", parseInt)
        .option("--http-headers", "Include response headers in output (API operations only)")
        .option("--json", "Output as JSON")
        .option("--machine", "Output as TOON (structured format for AI/scripting consumption)")
        .option("--debug", "Enable verbose debug logging to stderr")
        .action(async (ref: string, opts: {
            target?: string;
            env?: string;
            profile?: string;
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

                // ── Fall back to legacy app model ────────────────────────────
                const registry = new OperationRegistry(ctx.apps);
                const entry = registry.lookup(ref);
                const operation = entry.operation;

                // Resolve env
                const envName = opts.env ?? operation.defaultEnv;
                if (!envName) {
                    die(`Operation "${ref}" has no defaultEnv set. Provide --env <name>.`);
                }

                // Resolve profile
                const profileName = opts.profile ?? operation.profile;
                if (!profileName) {
                    die(`Operation "${ref}" has no default profile. Provide --profile <name>.`);
                }

                // Validate and coerce parameters
                let resolvedParams;
                try {
                    resolvedParams = resolveParams(operation, rawParams);
                } catch (err) {
                    if (err instanceof ParamValidationError) {
                        die(err.message);
                    }
                    throw err;
                }

                // ── dry-run: render and print, no execution ──────────────────
                if (opts.dryRun) {
                    if (operation.kind === "api") {
                        const rendered = renderApiExecution(operation.execution, resolvedParams);
                        const plan: Record<string, unknown> = {
                            "dry-run": true,
                            ref,
                            env: envName,
                            profile: profileName,
                            method: rendered.method,
                            path: rendered.path,
                        };
                        if (rendered.query) plan["query"] = rendered.query;
                        if (rendered.headers) plan["headers"] = rendered.headers;
                        if (rendered.body) plan["body"] = rendered.body;
                        output(plan);
                    } else {
                        const rendered = renderDbExecution(operation.execution, resolvedParams);
                        output({
                            "dry-run": true,
                            ref,
                            env: envName,
                            profile: profileName,
                            sql: rendered.sql,
                            params: rendered.params,
                        });
                    }
                    return;
                }

                // ── live execution ────────────────────────────────────────────
                await ctx.vault.unlock();

                const { env, profile } = ctx.apps.getProfile(entry.appId, envName!, profileName!);

                if (operation.kind === "api") {
                    if (profile.kind !== "api_token" && profile.kind !== "public") {
                        die(`Profile "${profileName}" is kind "${profile.kind}", not "api_token" or "public". Use an api_token or public profile for API operations.`);
                    }
                    if (!env.base_url) {
                        die(`Environment "${envName}" has no base_url configured.`);
                    }

                    const op = operation as ApiOperation;
                    const rendered = renderApiExecution(op.execution, resolvedParams);
                    const credential = await ctx.resolver.resolve(entry.appId, envName!, profile);
                    const result = await executeApiCall(ctx.vault, credential, ctx.audit, {
                        method: rendered.method,
                        path: rendered.path,
                        query: rendered.query,
                        body: rendered.body,
                        baseUrl: env.base_url!,
                        auth: profile.kind === "api_token" ? profile.auth : undefined,
                    });

                    outputApiResponse(result, opts.httpHeaders ?? false);
                } else {
                    if (profile.kind !== "db_connection") {
                        die(`Profile "${profileName}" is kind "${profile.kind}", not "db_connection". Use a db_connection profile for DB operations.`);
                    }

                    const op = operation as DbOperation;
                    const rendered = renderDbExecution(op.execution, resolvedParams);
                    const credential = await ctx.resolver.resolve(entry.appId, envName!, profile);
                    const result = await executeDbQuery(
                        ctx.vault,
                        credential!,
                        ctx.audit,
                        rendered.sql,
                        opts.limit ?? 500,
                        rendered.params,
                    );

                    outputTable(result.rows, result.fields);
                }
            } catch (err) {
                if (err instanceof Error) {
                    die(err.message);
                }
                throw err;
            }
        });

    // ── op add ────────────────────────────────────────────────────────────────
    const collectArr = (val: string, prev: string[]) => [...prev, val];

    op
        .command("add")
        .description("Add an operation to a registered integration or app config")
        .option("--app <app>", "App ID (legacy model)")
        .option("--integration <id>", "Integration ID")
        .option("--raw <yaml>", "Operation YAML inline (integration model)")
        .option("--file <path>", "YAML file to read from; use - for stdin (integration model)")
        .option("--kind <kind>", "Operation kind for legacy model: api or db")
        .option("--name <name>", "Operation name (legacy model)")
        .option("--method <method>", "HTTP method: GET|POST|PUT|PATCH|DELETE (legacy model)")
        .option("--path <path>", "API path template (legacy model)")
        .option("--sql <sql>", "SQL query template (legacy model)")
        .option("--param <spec>", "Parameter spec: name:type:required:description (legacy, repeatable)", collectArr, [] as string[])
        .option("--profile <profile>", "Default profile name (legacy model)")
        .option("--default-env <env>", "Default environment name (legacy model)")
        .option("--tag <tag>", "Tag (repeatable, legacy model)", collectArr, [] as string[])
        .option("--body <template>", "Request body template (legacy model)")
        .option("--readonly", "Mark operation as read-only (legacy model)")
        .option("--description <text>", "Operation description (legacy model)")
        .action(async (opts: {
            app?: string;
            integration?: string;
            raw?: string;
            file?: string;
            name?: string;
            kind?: string;
            method?: string;
            path?: string;
            body?: string;
            sql?: string;
            param: string[];
            profile?: string;
            defaultEnv?: string;
            tag: string[];
            readonly?: boolean;
            description?: string;
        }) => {
            const ctx = getContext();

            if (!opts.app && !opts.integration) {
                die("Provide either --app <id> (legacy) or --integration <id>.");
                return;
            }

            if (opts.integration) {
                // New model: require --raw or --file
                if (!opts.raw && !opts.file) {
                    die("Provide --raw <yaml> or --file <path> (use - for stdin).");
                    return;
                }

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
                return;
            }

            // Legacy model
            const appEntries = ctx.apps.list();
            const appEntry = appEntries.find((e) => e.id === opts.app);
            if (!appEntry) {
                die(`App "${opts.app}" is not registered. Use 'hexlane app add --file <path>'`);
                return;
            }
            const configPath = appEntry.config_path;

            let params;
            try {
                params = opts.param.map(parseParamSpec);
            } catch (err) {
                die(err instanceof Error ? err.message : String(err));
                return;
            }

            const kind = opts.kind;
            if (kind !== "api" && kind !== "db") {
                die(`Invalid --kind "${kind ?? "(not provided)"}". Must be "api" or "db".`);
                return;
            }

            if (!opts.name) {
                die("--name is required for legacy app operations.");
                return;
            }

            let operation;
            try {
                if (kind === "api") {
                    if (!opts.method) { die("--method is required for api operations"); return; }
                    if (!opts.path) { die("--path is required for api operations"); return; }
                    operation = buildOperation({
                        kind: "api",
                        name: opts.name,
                        method: opts.method,
                        path: opts.path,
                        body: opts.body,
                        params,
                        profile: opts.profile,
                        defaultEnv: opts.defaultEnv,
                        tags: opts.tag,
                        readOnly: opts.readonly,
                        description: opts.description,
                    });
                } else {
                    if (!opts.sql) { die("--sql is required for db operations"); return; }
                    operation = buildOperation({
                        kind: "db",
                        name: opts.name,
                        sql: opts.sql,
                        params,
                        profile: opts.profile,
                        defaultEnv: opts.defaultEnv,
                        tags: opts.tag,
                        description: opts.description,
                    });
                }
            } catch (err) {
                die(err instanceof Error ? err.message : String(err));
                return;
            }

            try {
                addOperationToFile(configPath, operation);
            } catch (err) {
                die(err instanceof Error ? err.message : String(err));
                return;
            }
            console.log(`✓ Added operation "${opts.name}" to app "${opts.app}"`);
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

            // Try integration model
            const intRegistry = new IntegrationOperationRegistry(ctx.integrations);
            if (intRegistry.hasIntegrationRef(ref)) {
                const entry = intRegistry.lookupByIntegrationRef(ref);
                const intEntries = ctx.integrations.list();
                const intEntry = intEntries.find((e) => e.id === entry.integrationId);
                if (intEntry) {
                    try {
                        deleteIntegrationOperation(intEntry.config_path, opName);
                        console.log(`✓ Removed operation "${opName}" from integration "${entry.integrationId}"`);
                    } catch (err) {
                        die(err instanceof Error ? err.message : String(err));
                    }
                    return;
                }
            }

            // Fall back to legacy app model
            const appEntries = ctx.apps.list();
            const appEntry = appEntries.find((e) => e.id === scopeId);
            if (!appEntry) {
                die(`"${scopeId}" is not a registered integration or app.`);
                return;
            }

            try {
                deleteOperationFromFile(appEntry.config_path, opName);
            } catch (err) {
                die(err instanceof Error ? err.message : String(err));
                return;
            }
            console.log(`✓ Removed operation "${opName}" from app "${scopeId}"`);
        });
}
