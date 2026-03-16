import type { Strategy } from "../config/schema.js";
import type { StrategyResult } from "./types.js";
import { runShellStrategy } from "./shell-strategy.js";
import { runHttpStrategy } from "./http-strategy.js";

export async function runStrategy(strategy: Strategy): Promise<StrategyResult> {
    if (strategy.kind === "shell") {
        return runShellStrategy(strategy);
    } else if (strategy.kind === "http") {
        return runHttpStrategy(strategy);
    } else {
        // static — token must be pre-loaded via `hexlane credential set`
        throw new Error(
            "Static credentials must be pre-loaded using `hexlane credential set`. " +
            "Run that command to store the token in the vault before using this profile."
        );
    }
}
