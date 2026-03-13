import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import { MetadataStore } from "../../metadata/store.js";
import { AuditLogger } from "../../audit/logger.js";
import { VaultManager, deleteKeychainPassphrase } from "../../vault/vault-manager.js";
import { getHexlaneDir } from "../context.js";
import { output, die, setJsonMode } from "../output.js";

export function registerInitCommand(program: Command): void {
    program
        .command("init")
        .description("Initialize Hexlane local storage and set vault passphrase (run once)")
        .option("--json", "Output as JSON")
        .action(async (opts: { json?: boolean }) => {
            if (opts.json) setJsonMode(true);
            try {
                const hexlaneDir = getHexlaneDir();
                const dirs = [
                    path.join(hexlaneDir, "config", "apps"),
                    path.join(hexlaneDir, "vault"),
                    path.join(hexlaneDir, "data"),
                    path.join(hexlaneDir, "audit"),
                    path.join(hexlaneDir, "locks"),
                ];
                for (const d of dirs) {
                    fs.mkdirSync(d, { recursive: true });
                }

                // Initialize SQLite schema
                new MetadataStore(hexlaneDir).close();

                // Initialize empty audit log
                const auditPath = path.join(hexlaneDir, "audit", "audit.jsonl");
                if (!fs.existsSync(auditPath)) {
                    fs.writeFileSync(auditPath, "", "utf8");
                }

                // Generate master.salt and prompt for passphrase → offers to save to Keychain
                const vault = new VaultManager(hexlaneDir);
                await vault.unlock();

                output({
                    message: "Hexlane initialized",
                    dir: hexlaneDir,
                });
            } catch (e: unknown) {
                die((e as Error).message);
            }
        });
}

export function registerAuditCommand(program: Command): void {
    program
        .command("audit")
        .description("View audit log")
        .option("--app <name>", "Filter by application")
        .option("--limit <n>", "Number of recent events (default: 50)", parseInt)
        .option("--json", "Output as JSON")
        .action((opts: { app?: string; limit?: number; json?: boolean }) => {
            if (opts.json) setJsonMode(true);
            try {
                const hexlaneDir = getHexlaneDir();
                const audit = new AuditLogger(hexlaneDir);
                const events = audit.read({ app: opts.app, limit: opts.limit ?? 50 });
                output(events);
            } catch (e: unknown) {
                die((e as Error).message);
            }
        });
}

export function registerVaultCommands(program: Command): void {
    const vault = program
        .command("vault")
        .description("Vault management");

    vault
        .command("reset-passphrase")
        .description("Remove stored passphrase from macOS Keychain and set a new one")
        .action(async () => {
            try {
                const hexlaneDir = getHexlaneDir();
                const deleted = await deleteKeychainPassphrase();
                if (deleted) {
                    console.error("Existing passphrase removed from Keychain.");
                }
                // Unlocking will now prompt for a new passphrase and offer to save it
                const v = new VaultManager(hexlaneDir);
                await v.unlock();
                output({ message: "Vault passphrase updated" });
            } catch (e: unknown) {
                die((e as Error).message);
            }
        });
}
