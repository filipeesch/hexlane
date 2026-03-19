import type { Command } from "commander";

// ─── Tool Handler Interface ───────────────────────────────────────────────────

export interface ToolHandler {
    readonly toolName: string;
    registerCommands(program: Command): void;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

class ToolRegistry {
    private handlers: ToolHandler[] = [];

    register(handler: ToolHandler): void {
        this.handlers.push(handler);
    }

    registerAllCommands(program: Command): void {
        for (const handler of this.handlers) {
            handler.registerCommands(program);
        }
    }
}

export const toolRegistry = new ToolRegistry();
