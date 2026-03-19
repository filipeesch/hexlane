import type { Command } from "commander";
import * as fs from "fs";
import { toolRegistry } from "./registry.js";
import { getContext } from "../cli/context.js";
import { output, outputTable, die, setJsonMode, setMachineMode } from "../cli/output.js";
import { setDebugMode } from "../cli/debug.js";
import { executeDbQuery } from "../executors/db-executor.js";

toolRegistry.register({
    toolName: "sql",
    registerCommands(program: Command): void {
        const sql = program
            .command("sql")
            .description("Run SQL queries against registered targets");

        sql
            .command("query <target-id>")
            .description("Run a SQL query against a registered database target")
            .option("--sql <query>", "SQL query string")
            .option("--sql-file <path>", "SQL query from file")
            .option("--param <key=value>", "Bind a named SQL parameter (:name), repeatable", (val: string, prev: string[]) => [...prev, val], [] as string[])
            .option("--limit <n>", "Max rows returned (default: 500)", parseInt)
            .option("--dry-run", "Preview the final SQL and bound params without executing")
            .option("--json", "Output results as JSON array")
            .option("--machine", "Output results as TOON (structured format for AI/scripting consumption)")
            .option("--debug", "Enable verbose debug logging to stderr")
            .action(async (targetId: string, opts: {
                sql?: string;
                sqlFile?: string;
                param: string[];
                limit?: number;
                dryRun?: boolean;
                json?: boolean;
                machine?: boolean;
                debug?: boolean;
            }) => {
                if (opts.json) setJsonMode(true);
                if (opts.machine) setMachineMode(true);
                if (opts.debug) setDebugMode(true);
                try {
                    let sql: string;
                    if (opts.sqlFile) {
                        if (!fs.existsSync(opts.sqlFile)) die(`SQL file not found: ${opts.sqlFile}`);
                        sql = fs.readFileSync(opts.sqlFile, "utf8").trim();
                    } else if (opts.sql) {
                        sql = opts.sql;
                    } else {
                        die("Provide --sql or --sql-file");
                    }

                    const params: Record<string, string> = {};
                    for (const entry of opts.param) {
                        const eq = entry.indexOf("=");
                        if (eq < 1) die(`Invalid --param "${entry}": expected format key=value`);
                        params[entry.slice(0, eq)] = entry.slice(eq + 1);
                    }

                    if (opts.dryRun) {
                        output({ "dry-run": true, sql: sql!, params });
                        return;
                    }

                    const ctx = getContext();
                    const found = ctx.integrations.findByTargetId(targetId);
                    if (!found) die(`Target "${targetId}" not found in any registered integration.`);
                    const { integrationId, target } = found;

                    if (target.tool !== "sql") {
                        die(`Target "${targetId}" uses tool "${target.tool}", not "sql".`);
                    }
                    if (!target.credential) {
                        die(`Target "${targetId}" has no credential configured.`);
                    }
                    if (target.credential.kind !== "db_connection") {
                        die(`Target "${targetId}" credential is kind "${target.credential.kind}", not "db_connection".`);
                    }

                    await ctx.vault.unlock();
                    const credential = await ctx.resolver.resolveForTarget(integrationId, targetId, target.credential);
                    if (!credential) {
                        die(`Target "${targetId}" credential resolved to null — check credential kind.`);
                    }
                    const result = await executeDbQuery(
                        ctx.vault,
                        credential,
                        ctx.audit,
                        sql!,
                        opts.limit ?? 500,
                        params,
                    );

                    outputTable(result.rows, result.fields);
                } catch (e: unknown) {
                    die((e as Error).message);
                }
            });
    },
});
