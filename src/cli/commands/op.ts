import { Command } from "commander";
import { getContext } from "../context.js";
import { output, outputTable, die, setJsonMode, setToonMode } from "../output.js";
import { setDebugMode } from "../debug.js";
import { OperationRegistry } from "../../operations/registry.js";
import { resolveParams, ParamValidationError } from "../../operations/param-resolver.js";
import { renderApiExecution, renderDbExecution } from "../../operations/renderer.js";
import { validateOperation } from "../../operations/validator.js";
import { executeApiCall } from "../../executors/api-executor.js";
import { executeDbQuery } from "../../executors/db-executor.js";
import { parseParamSpec, buildOperation, addOperationToFile, deleteOperationFromFile } from "../../operations/op-writer.js";
import type { ApiOperation, DbOperation } from "../../operations/schema.js";

export function registerOpCommands(program: Command): void {
    const op = program
        .command("op")
        .description("Manage and run named operations");

    // ── op list ──────────────────────────────────────────────────────────────
    op
        .command("list")
        .description("List available operations")
        .option("--app <app>", "Filter by app ID")
        .option("--filter <text>", "Case-insensitive text filter (matches name, description, tags)")
        .option("--json", "Output as JSON")
        .option("--toon", "Output as TOON")
        .action((opts: { app?: string; filter?: string; json?: boolean; toon?: boolean }) => {
            if (opts.json) setJsonMode(true);
            if (opts.toon) setToonMode(true);

            const ctx = getContext();
            const registry = new OperationRegistry(ctx.apps);
            const entries = registry.list(opts.app, opts.filter);

            if (entries.length === 0) {
                if (opts.app) {
                    console.error(`No operations found for app "${opts.app}".`);
                } else if (opts.filter) {
                    console.error(`No operations match filter "${opts.filter}".`);
                } else {
                    console.error(`No operations registered. Add an 'operations:' key to an app config and re-register it.`);
                }
                return;
            }

            const rows = entries.map((e) => ({
                ref: e.ref,
                kind: e.operation.kind,
                description: e.operation.description ?? "",
                tags: (e.operation.tags ?? []).join(", "),
            }));

            outputTable(rows, ["ref", "kind", "description", "tags"]);
        });

    // ── op show ───────────────────────────────────────────────────────────────
    op
        .command("show <ref>")
        .description("Show full metadata for an operation (e.g. payments-api/get-order)")
        .option("--json", "Output as JSON")
        .option("--toon", "Output as TOON")
        .action((ref: string, opts: { json?: boolean; toon?: boolean }) => {
            if (opts.json) setJsonMode(true);
            if (opts.toon) setToonMode(true);

            const ctx = getContext();
            const registry = new OperationRegistry(ctx.apps);
            const entry = registry.lookup(ref);
            const op = entry.operation;

            if (opts.json || opts.toon) {
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
        .description("Run an operation (e.g. hexlane op run payments-api/get-order --env dev --profile support-user --param orderId=123)")
        .option("--env <name>", "Environment name (overrides defaultEnv from the operation)")
        .option("--profile <name>", "Profile name (overrides default profile from the operation)")
        .option("--param <key=value>", "Parameter value, repeatable", (val: string, prev: string[]) => [...prev, val], [] as string[])
        .option("--dry-run", "Render the execution template and print it — no network or DB calls, no credentials accessed")
        .option("--limit <n>", "Max rows returned for DB operations (default: 500)", parseInt)
        .option("--json", "Output as JSON")
        .option("--toon", "Output as TOON")
        .option("--debug", "Enable verbose debug logging to stderr")
        .action(async (ref: string, opts: {
            env?: string;
            profile?: string;
            param: string[];
            dryRun?: boolean;
            limit?: number;
            json?: boolean;
            toon?: boolean;
            debug?: boolean;
        }) => {
            if (opts.json) setJsonMode(true);
            if (opts.toon) setToonMode(true);
            if (opts.debug) setDebugMode(true);

            try {
                const ctx = getContext();
                const registry = new OperationRegistry(ctx.apps);
                const entry = registry.lookup(ref);
                const operation = entry.operation;

                // Resolve env
                const envName = opts.env ?? operation.defaultEnv;
                if (!envName) {
                    die(
                        `Operation "${ref}" has no defaultEnv set. Provide --env <name>.`
                    );
                }

                // Resolve profile
                const profileName = opts.profile ?? operation.profile;
                if (!profileName) {
                    die(
                        `Operation "${ref}" has no default profile. Provide --profile <name>.`
                    );
                }

                // Parse --param key=value
                const rawParams: Record<string, string> = {};
                for (const entry of opts.param) {
                    const eq = entry.indexOf("=");
                    if (eq < 1) die(`Invalid --param "${entry}": expected format key=value`);
                    rawParams[entry.slice(0, eq)] = entry.slice(eq + 1);
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

                const { env, profile } = ctx.apps.getProfile(entry.appId, envName, profileName);

                if (operation.kind === "api") {
                    if (profile.kind !== "api_token") {
                        die(`Profile "${profileName}" is kind "${profile.kind}", not "api_token". Use an api_token profile for API operations.`);
                    }
                    if (!env.base_url) {
                        die(`Environment "${envName}" has no base_url configured.`);
                    }

                    const op = operation as ApiOperation;
                    const rendered = renderApiExecution(op.execution, resolvedParams);
                    const credential = await ctx.resolver.resolve(entry.appId, envName, profile);
                    const result = await executeApiCall(ctx.vault, credential, ctx.audit, {
                        method: rendered.method,
                        path: rendered.path,
                        body: rendered.body,
                        baseUrl: env.base_url,
                    });

                    if (opts.json || opts.toon) {
                        output({ status: result.status, headers: result.headers, body: result.body });
                    } else {
                        console.error(`HTTP ${result.status}`);
                        for (const [k, v] of Object.entries(result.headers)) {
                            console.error(`  ${k}: ${v}`);
                        }
                        output(result.body);
                    }
                } else {
                    if (profile.kind !== "db_connection") {
                        die(`Profile "${profileName}" is kind "${profile.kind}", not "db_connection". Use a db_connection profile for DB operations.`);
                    }

                    const op = operation as DbOperation;
                    const rendered = renderDbExecution(op.execution, resolvedParams);
                    const credential = await ctx.resolver.resolve(entry.appId, envName, profile);
                    const result = await executeDbQuery(
                        ctx.vault,
                        credential,
                        ctx.audit,
                        rendered.sql,
                        opts.limit ?? 500,
                        rendered.params,
                    );

                    output(result.rows);
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
        .description("Add an operation to a registered app config")
        .requiredOption("--app <app>", "App ID")
        .requiredOption("--name <name>", "Operation name (lowercase alphanumeric-dashes)")
        .requiredOption("--kind <kind>", "Operation kind: api or db")
        .option("--method <method>", "HTTP method (api only): GET|POST|PUT|PATCH|DELETE")
        .option("--path <path>", "API path template (api only, e.g. /orders/{{ orderId }})")
        .option("--sql <sql>", "SQL query template (db only)")
        .option("--param <spec>", "Parameter spec: name:type:required:description (repeatable)", collectArr, [] as string[])
        .option("--profile <profile>", "Default profile name")
        .option("--default-env <env>", "Default environment name")
        .option("--tag <tag>", "Tag (repeatable)", collectArr, [] as string[])
        .option("--readonly", "Mark operation as read-only (api only; db defaults to true)")
        .option("--description <text>", "Operation description")
        .action((opts: {
            app: string;
            name: string;
            kind: string;
            method?: string;
            path?: string;
            sql?: string;
            param: string[];
            profile?: string;
            defaultEnv?: string;
            tag: string[];
            readonly?: boolean;
            description?: string;
        }) => {
            const ctx = getContext();

            // Verify app is registered and get its config path
            const appEntries = ctx.apps.list();
            const appEntry = appEntries.find((e) => e.id === opts.app);
            if (!appEntry) {
                die(`App "${opts.app}" is not registered. Use 'hexlane app add --file <path>'`);
                return;
            }
            const configPath = appEntry.config_path;

            // Validate kind
            if (opts.kind !== "api" && opts.kind !== "db") {
                die(`Invalid --kind "${opts.kind}". Must be "api" or "db".`);
                return;
            }

            // Parse --param specs
            let params;
            try {
                params = opts.param.map(parseParamSpec);
            } catch (err) {
                die(err instanceof Error ? err.message : String(err));
                return;
            }

            // Build and validate operation
            let operation;
            try {
                if (opts.kind === "api") {
                    if (!opts.method) { die("--method is required for api operations"); return; }
                    if (!opts.path) { die("--path is required for api operations"); return; }
                    operation = buildOperation({
                        kind: "api",
                        name: opts.name,
                        method: opts.method,
                        path: opts.path,
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

            // Write to registered YAML
            try {
                addOperationToFile(configPath, operation);
            } catch (err) {
                die(err instanceof Error ? err.message : String(err));
                return;
            }
            console.log(`✓ Added operation "${opts.name}" to app "${opts.app}"`);
        });

    // ── op delete ─────────────────────────────────────────────────────────────
    op
        .command("delete <ref>")
        .description("Remove an operation from a registered app config (e.g. payments-api/get-order)")
        .action((ref: string) => {
            const slash = ref.indexOf("/");
            if (slash < 1) {
                die(`Invalid ref "${ref}": expected format app/operation-name`);
                return;
            }
            const appId = ref.slice(0, slash);
            const opName = ref.slice(slash + 1);

            const ctx = getContext();
            const appEntries = ctx.apps.list();
            const appEntry = appEntries.find((e) => e.id === appId);
            if (!appEntry) {
                die(`App "${appId}" is not registered.`);
                return;
            }

            try {
                deleteOperationFromFile(appEntry.config_path, opName);
            } catch (err) {
                die(err instanceof Error ? err.message : String(err));
                return;
            }
            console.log(`✓ Removed operation "${opName}" from app "${appId}"`);
        });
}
