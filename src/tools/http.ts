import type { Command } from "commander";
import * as fs from "fs";
import { toolRegistry } from "./registry.js";
import { getContext } from "../cli/context.js";
import { outputApiResponse, die, setJsonMode, setMachineMode } from "../cli/output.js";
import { setDebugMode } from "../cli/debug.js";
import { executeApiCall } from "../executors/api-executor.js";

toolRegistry.register({
    toolName: "http",
    registerCommands(program: Command): void {
        const http = program
            .command("http")
            .description("Make HTTP calls to registered API targets");

        http
            .command("call <target-id> <path>")
            .description("Make an authenticated HTTP request to a registered target")
            .option("-m, --method <method>", "HTTP method: GET|POST|PUT|PATCH|DELETE (default: GET)")
            .option("--body <json>", "Request body as JSON string")
            .option("--body-file <path>", "Request body from file")
            .option("--query <key=value>", "Append a query parameter to the URL, repeatable", (val: string, prev: string[]) => [...prev, val], [] as string[])
            .option("--http-headers", "Include response headers in output")
            .option("--json", "Output response as JSON")
            .option("--machine", "Output response as TOON (structured format for AI/scripting consumption)")
            .option("--debug", "Enable verbose debug logging to stderr")
            .action(async (targetId: string, path: string, opts: {
                method?: string;
                body?: string;
                bodyFile?: string;
                query: string[];
                httpHeaders?: boolean;
                json?: boolean;
                machine?: boolean;
                debug?: boolean;
            }) => {
                if (opts.json) setJsonMode(true);
                if (opts.machine) setMachineMode(true);
                if (opts.debug) setDebugMode(true);
                try {
                    let body: string | undefined;
                    if (opts.bodyFile) {
                        if (!fs.existsSync(opts.bodyFile)) die(`Body file not found: ${opts.bodyFile}`);
                        body = fs.readFileSync(opts.bodyFile, "utf8");
                    } else if (opts.body) {
                        body = opts.body;
                    }

                    const query: Record<string, string> = {};
                    for (const entry of opts.query) {
                        const eq = entry.indexOf("=");
                        if (eq < 1) die(`Invalid --query "${entry}": expected format key=value`);
                        query[entry.slice(0, eq)] = entry.slice(eq + 1);
                    }

                    const ctx = getContext();
                    const found = ctx.integrations.findByTargetId(targetId);
                    if (!found) die(`Target "${targetId}" not found in any registered integration.`);
                    const { integrationId, target } = found;

                    if (target.tool !== "http") {
                        die(`Target "${targetId}" uses tool "${target.tool}", not "http".`);
                    }
                    if (!target.credential) {
                        die(`Target "${targetId}" has no credential configured.`);
                    }

                    const baseUrl = target.config["base_url"] as string | undefined;
                    if (!baseUrl) {
                        die(`Target "${targetId}" has no base_url configured.`);
                    }

                    await ctx.vault.unlock();
                    const credential = await ctx.resolver.resolveForTarget(integrationId, targetId, target.credential);

                    const result = await executeApiCall(ctx.vault, credential, ctx.audit, {
                        method: opts.method ?? "GET",
                        path,
                        body,
                        baseUrl,
                        query: Object.keys(query).length > 0 ? query : undefined,
                        auth: target.credential.kind === "api_token" ? target.credential.auth : undefined,
                    });

                    outputApiResponse(result, opts.httpHeaders ?? false);
                } catch (e: unknown) {
                    die((e as Error).message);
                }
            });
    },
});
