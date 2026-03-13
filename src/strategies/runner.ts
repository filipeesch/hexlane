import type { Strategy } from "../config/schema.js";
import type { StrategyResult } from "./types.js";
import { runShellStrategy } from "./shell-strategy.js";
import { runHttpStrategy } from "./http-strategy.js";

export async function runStrategy(strategy: Strategy): Promise<StrategyResult> {
    if (strategy.kind === "shell") {
        return runShellStrategy(strategy);
    } else {
        return runHttpStrategy(strategy);
    }
}
