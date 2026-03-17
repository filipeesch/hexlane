import { Command } from "commander";
import * as fs from "fs";
import { getContext } from "../context.js";
import { output, die, setJsonMode, setToonMode } from "../output.js";
import { setDebugMode } from "../debug.js";
import { executeDbQuery } from "../../executors/db-executor.js";

export function registerDbCommands(program: Command): void {
    const db = program
        .command("db")
        .description("Execute database queries using stored credentials");

    db
        .command("query")
        .description("Run a SQL query")
        .requiredOption("--app <name>", "Application ID")
        .requiredOption("--env <name>", "Environment name")
        .requiredOption("--profile <name>", "Profile name")
        .option("--sql <query>", "SQL query string")
        .option("--sql-file <path>", "SQL query from file")
        .option("--param <key=value>", "Bind a named SQL parameter (:name), repeatable", (val: string, prev: string[]) => [...prev, val], [] as string[])
        .option("--limit <n>", "Max rows returned (default: 500)", parseInt)
        .option("--dry-run", "Preview the final SQL and bound params without executing")
        .option("--json", "Output results as JSON array")
        .option("--toon", "Output results as TOON (token-efficient format)")
        .option("--debug", "Enable verbose debug logging to stderr")
        .action(async (opts: {
            app: string;
            env: string;
            profile: string;
            sql?: string;
            sqlFile?: string;
            param: string[];
            limit?: number;
            dryRun?: boolean;
            json?: boolean;
            toon?: boolean;
            debug?: boolean;
        }) => {
            if (opts.json) setJsonMode(true);
            if (opts.toon) setToonMode(true);
            if (opts.debug) setDebugMode(true);
            try {
                let sql: string;
                if (opts.sqlFile) {
                    if (!fs.existsSync(opts.sqlFile)) {
                        die(`SQL file not found: ${opts.sqlFile}`);
                    }
                    sql = fs.readFileSync(opts.sqlFile, "utf8").trim();
                } else if (opts.sql) {
                    sql = opts.sql;
                } else {
                    die("Provide --sql or --sql-file");
                }

                // Parse --param key=value pairs
                const params: Record<string, string> = {};
                for (const entry of opts.param) {
                    const eq = entry.indexOf("=");
                    if (eq < 1) die(`Invalid --param "${entry}": expected format key=value`);
                    params[entry.slice(0, eq)] = entry.slice(eq + 1);
                }

                if (opts.dryRun) {
                    output({ "dry-run": true, sql, params });
                    return;
                }

                const ctx = getContext();
                await ctx.vault.unlock();

                const { profile } = ctx.apps.getProfile(opts.app, opts.env, opts.profile);
                if (profile.kind !== "db_connection") {
                    die(`Profile "${opts.profile}" is kind "${profile.kind}", not "db_connection"`);
                }

                const credential = await ctx.resolver.resolve(opts.app, opts.env, profile);
                const result = await executeDbQuery(
                    ctx.vault,
                    credential!,
                    ctx.audit,
                    sql,
                    opts.limit ?? 500,
                    params,
                );

                output(result.rows);
            } catch (e: unknown) {
                die((e as Error).message);
            }
        });
}
