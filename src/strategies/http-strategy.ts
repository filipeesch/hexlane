import type { HttpStrategy } from "../config/schema.js";
import type { StrategyResult, StrategyError } from "./types.js";
import { mapOutput } from "./output-mapper.js";
import { debugLog } from "../cli/debug.js";

const TIMEOUT_MS = 30_000;

/**
 * Interpolates ${VAR_NAME} placeholders from process.env.
 * Only used for header values and body — never for URL params (to avoid SSRF risks).
 */
function interpolateEnvVars(template: string): string {
    return template.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
        const val = process.env[name];
        if (!val) {
            throw new Error(`Environment variable "${name}" is not set but required by strategy config`);
        }
        return val;
    });
}

/**
 * Executes an HTTP strategy.
 * - Raw response body is treated as secret material — never logged.
 * - Only HTTP status code is safe to include in error messages.
 * - Application-level error fields are checked via output_mapping.error_path.
 */
export async function runHttpStrategy(
    strategy: HttpStrategy
): Promise<StrategyResult> {
    const acquiredAt = new Date();

    const headers: Record<string, string> = {};
    if (strategy.headers) {
        for (const [k, v] of Object.entries(strategy.headers) as [string, string][]) {
            headers[k] = interpolateEnvVars(v);
        }
    }

    const body = strategy.body ? interpolateEnvVars(strategy.body) : undefined;

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), TIMEOUT_MS);

    debugLog(`http strategy`, `${strategy.method} ${strategy.url}`);

    let response: Response;
    try {
        response = await fetch(strategy.url, {
            method: strategy.method,
            headers,
            body,
            signal: controller.signal,
        });
    } catch (e: unknown) {
        clearTimeout(timeoutHandle);
        const isTimeout = (e as Error).name === "AbortError";
        throw {
            kind: "strategy_failure",
            code: isTimeout ? "command_timeout" : "http_error",
            message: isTimeout
                ? `HTTP request timed out after ${TIMEOUT_MS / 1000}s`
                : `HTTP request failed: ${(e as Error).message}`,
        } as StrategyError;
    }
    clearTimeout(timeoutHandle);
    debugLog(`http strategy response`, `status ${response.status}`);

    if (!response.ok) {
        // Only log status — response body may contain secret material
        throw {
            kind: "strategy_failure",
            code: "http_error",
            message: `HTTP strategy failed with status ${response.status}`,
            http_status: response.status,
        } as StrategyError;
    }

    // Read body into memory, parse as JSON, then discard the raw buffer
    let parsed: unknown;
    try {
        parsed = await response.json();
    } catch {
        throw {
            kind: "strategy_failure",
            code: "parse_error",
            message: "HTTP response is not valid JSON",
        } as StrategyError;
    }

    try {
        const { secret, expires_at, trace_id } = mapOutput(
            parsed,
            strategy.output_mapping,
            acquiredAt
        );
        return { secret, acquired_at: acquiredAt, expires_at, trace_id };
    } catch (e: unknown) {
        throw {
            kind: "strategy_failure",
            code: "mapping_error",
            message: (e as Error).message,
        } as StrategyError;
    }
}
