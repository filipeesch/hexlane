#!/usr/bin/env node
import { Command } from "commander";
import { registerAppCommands } from "./cli/commands/app.js";
import { registerCredentialCommands } from "./cli/commands/credential.js";
import { registerOpCommands } from "./cli/commands/op.js";
import { registerIntegrationCommands } from "./cli/commands/integration.js";
import { registerInitCommand, registerAuditCommand, registerVaultCommands } from "./cli/commands/misc.js";
import { toolRegistry } from "./tools/index.js";

const program = new Command();

program
    .name("hexlane")
    .description("Secure multi-application CLI execution broker")
    .version("0.1.0")
    .option("--json", "Output as JSON (global flag)");

registerInitCommand(program);
registerAppCommands(program);
registerCredentialCommands(program);
registerOpCommands(program);
registerIntegrationCommands(program);
registerAuditCommand(program);
registerVaultCommands(program);
toolRegistry.registerAllCommands(program);

program.parseAsync(process.argv).catch((err: unknown) => {
    console.error("Fatal:", (err as Error).message ?? String(err));
    process.exit(1);
});
