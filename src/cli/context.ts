import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { VaultManager } from "../vault/vault-manager.js";
import { MetadataStore } from "../metadata/store.js";
import { LockManager } from "../credential/lock-manager.js";
import { CredentialResolver } from "../credential/resolver.js";
import { AuditLogger } from "../audit/logger.js";
import { AppStore } from "../config/app-store.js";
import { IntegrationStore } from "../config/integration-store.js";

export interface HexlaneContext {
    hexlaneDir: string;
    vault: VaultManager;
    metadata: MetadataStore;
    locks: LockManager;
    audit: AuditLogger;
    resolver: CredentialResolver;
    apps: AppStore;
    integrations: IntegrationStore;
}

export function getHexlaneDir(): string {
    return (
        process.env["HEXLANE_DIR"] ??
        path.join(os.homedir(), ".hexlane")
    );
}

let _ctx: HexlaneContext | null = null;

/**
 * Returns a shared context. Vault must be unlocked separately for
 * commands that need decryption.
 */
export function getContext(): HexlaneContext {
    if (_ctx) return _ctx;
    const hexlaneDir = getHexlaneDir();
    fs.mkdirSync(hexlaneDir, { recursive: true });

    const vault = new VaultManager(hexlaneDir);
    const metadata = new MetadataStore(hexlaneDir);
    const locks = new LockManager(hexlaneDir);
    const audit = new AuditLogger(hexlaneDir);
    const apps = new AppStore(hexlaneDir);
    const integrations = new IntegrationStore(hexlaneDir);
    const resolver = new CredentialResolver(vault, metadata, locks, audit);

    _ctx = { hexlaneDir, vault, metadata, locks, audit, resolver, apps, integrations };
    return _ctx;
}
