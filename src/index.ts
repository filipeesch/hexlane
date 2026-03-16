#!/usr/bin/env node
import { Command } from "commander";
import { registerAppCommands } from "./cli/commands/app.js";
import { registerCredentialCommands } from "./cli/commands/credential.js";
import { registerApiCommands } from "./cli/commands/api.js";
import { registerDbCommands } from "./cli/commands/db.js";
import { registerOpCommands } from "./cli/commands/op.js";
import { registerInitCommand, registerAuditCommand, registerVaultCommands } from "./cli/commands/misc.js";

const program = new Command();

program
    .name("hexlane")
    .description("Secure multi-application CLI execution broker")
    .version("0.1.0")
    .option("--json", "Output as JSON (global flag)");

registerInitCommand(program);
registerAppCommands(program);
registerCredentialCommands(program);
registerApiCommands(program);
registerDbCommands(program);
registerOpCommands(program);
registerAuditCommand(program);
registerVaultCommands(program);

program.parseAsync(process.argv).catch((err: unknown) => {
    console.error("Fatal:", (err as Error).message ?? String(err));
    process.exit(1);
});
