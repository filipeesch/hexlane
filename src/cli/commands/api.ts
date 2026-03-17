import { Command } from "commander";
import * as fs from "fs";
import { getContext } from "../context.js";
import { output, die, setJsonMode, setToonMode } from "../output.js";
import { setDebugMode } from "../debug.js";
import { executeApiCall } from "../../executors/api-executor.js";

export function registerApiCommands(program: Command): void {
    const api = program
        .command("api")
        .description("Execute API calls using stored credentials");

    api
        .command("call")
        .description("Make an authenticated API call")
        .requiredOption("--app <name>", "Application ID")
        .requiredOption("--env <name>", "Environment name")
        .requiredOption("--profile <name>", "Profile name")
        .requiredOption("--method <method>", "HTTP method: GET|POST|PUT|PATCH|DELETE")
        .requiredOption("--path <path>", "API path (e.g. /orders/123)")
        .option("--body <json>", "Request body as JSON string")
        .option("--body-file <path>", "Request body from file")
        .option("--json", "Output response as JSON")
        .option("--toon", "Output response as TOON (token-efficient format)")
        .option("--debug", "Enable verbose debug logging to stderr")
        .action(async (opts: {
            app: string;
            env: string;
            profile: string;
            method: string;
            path: string;
            body?: string;
            bodyFile?: string;
            json?: boolean;
            toon?: boolean;
            debug?: boolean;
        }) => {
            if (opts.json) setJsonMode(true);
            if (opts.toon) setToonMode(true);
            if (opts.debug) setDebugMode(true);
            try {
                // Resolve body
                let body: string | undefined;
                if (opts.bodyFile) {
                    if (!fs.existsSync(opts.bodyFile)) {
                        die(`Body file not found: ${opts.bodyFile}`);
                    }
                    body = fs.readFileSync(opts.bodyFile, "utf8");
                } else if (opts.body) {
                    body = opts.body;
                }

                const ctx = getContext();
                await ctx.vault.unlock();

                const { env, profile } = ctx.apps.getProfile(opts.app, opts.env, opts.profile);
                if (profile.kind !== "api_token" && profile.kind !== "public") {
                    die(`Profile "${opts.profile}" is kind "${profile.kind}", not "api_token" or "public"`);
                }
                if (!env.base_url) {
                    die(`Environment "${opts.env}" has no base_url configured`);
                }

                const credential = await ctx.resolver.resolve(opts.app, opts.env, profile);
                const result = await executeApiCall(ctx.vault, credential, ctx.audit, {
                    method: opts.method,
                    path: opts.path,
                    body,
                    baseUrl: env.base_url,
                    auth: profile.kind === "api_token" ? profile.auth : undefined,
                });

                output({ status: result.status, headers: result.headers, body: result.body });
            } catch (e: unknown) {
                die((e as Error).message);
            }
        });
}
