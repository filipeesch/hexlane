import { spawn } from "child_process";
import type { ShellStrategy } from "../config/schema.js";
import type { StrategyResult, StrategyError } from "./types.js";
import { mapOutput } from "./output-mapper.js";
import { debugLog } from "../cli/debug.js";

const TIMEOUT_MS = 30_000;

/**
 * Executes a shell strategy.
 * - Uses spawn() with an argv array split — never exec() to avoid shell injection.
 * - stdout is treated as raw secret material — never logged or echoed.
 * - stderr is captured for diagnostic messages but never logged in detail.
 */
export async function runShellStrategy(
    strategy: ShellStrategy
): Promise<StrategyResult> {
    const acquiredAt = new Date();
    return new Promise((resolve, reject) => {
        // Split command into argv — handles simple cases.
        // Commands with complex shell quoting should use a wrapper script.
        const parts = strategy.command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
        if (!parts || parts.length === 0) {
            reject({ kind: "strategy_failure", code: "command_failed", message: "Empty command" } as StrategyError);
            return;
        }
        const [cmd, ...args] = parts;
        debugLog(`shell strategy`, `running: ${strategy.command}`);
        const child = spawn(cmd!, args, {
            env: { ...process.env },
            timeout: TIMEOUT_MS,
            stdio: ["ignore", "pipe", "pipe"],
        });

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

        child.on("close", (code, signal) => {
            if (signal === "SIGTERM" || signal === "SIGKILL") {
                reject({
                    kind: "strategy_failure",
                    code: "command_timeout",
                    message: `Shell command timed out after ${TIMEOUT_MS / 1000}s`,
                } as StrategyError);
                return;
            }
            if (code !== 0) {
                reject({
                    kind: "strategy_failure",
                    code: "command_failed",
                    message: `Shell command exited with code ${code ?? "unknown"}`,
                    exit_code: code ?? undefined,
                } as StrategyError);
                return;
            }

            const rawOutput = Buffer.concat(stdoutChunks).toString("utf8").trim();
            // Parse stdout as JSON (raw buffer is discarded after parsing)
            let parsed: unknown;
            try {
                parsed = JSON.parse(rawOutput);
            } catch {
                reject({
                    kind: "strategy_failure",
                    code: "parse_error",
                    message: "Shell command output is not valid JSON",
                } as StrategyError);
                return;
            }

            try {
                const { secret, expires_at, trace_id } = mapOutput(
                    parsed,
                    strategy.output_mapping,
                    acquiredAt
                );
                resolve({ secret, acquired_at: acquiredAt, expires_at, trace_id });
            } catch (e: unknown) {
                reject({
                    kind: "strategy_failure",
                    code: "mapping_error",
                    message: (e as Error).message,
                } as StrategyError);
            }
        });

        child.on("error", (err) => {
            reject({
                kind: "strategy_failure",
                code: "command_failed",
                message: `Failed to start command: ${err.message}`,
            } as StrategyError);
        });
    });
}
