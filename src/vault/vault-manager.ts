import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import type { VaultSecret } from "./types.js";

const SALT_FILE = "master.salt";
const KEYCHAIN_SERVICE = "hexlane";
const KEYCHAIN_ACCOUNT = "vault-passphrase";
const SALT_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/**
 * Derives the AES-256 vault key using scrypt (Node built-in, no native addons).
 * Key is derived once per CLI invocation and held in memory only.
 */
function deriveKey(passphrase: string, salt: Buffer): Buffer {
    return crypto.scryptSync(passphrase, salt, KEY_LENGTH, {
        N: 16384,   // CPU/memory cost
        r: 8,
        p: 1,
    });
}

/**
 * Tries to load keytar (optional native addon).
 * Returns null if not available (e.g. headless CI with no libsecret).
 */
async function tryKeytar(): Promise<typeof import("keytar") | null> {
    try {
        const mod = await import("keytar");
        // Handle both ESM default export and direct CommonJS export
        const keytar = (mod as any).default ?? mod;
        return keytar as typeof import("keytar");
    } catch {
        return null;
    }
}

/**
 * Resolves the vault passphrase from (in priority order):
 *  1. HEXLANE_VAULT_PASSPHRASE env var  — agent / CI (explicit override)
 *  2. macOS Keychain via keytar         — human dev (transparent, never in env)
 *  3. TTY prompt                        — first-time setup, offers to save to Keychain
 *
 * The passphrase is never written to disk, never in a child process environment,
 * and never visible to agents invoking hexlane commands.
 */
async function resolvePassphrase(): Promise<string> {
    // Priority 1: explicit env var (agent / CI usage)
    if (process.env["HEXLANE_VAULT_PASSPHRASE"]) {
        return process.env["HEXLANE_VAULT_PASSPHRASE"];
    }

    // Priority 2: OS Keychain (transparent for human devs after first init)
    const keytar = await tryKeytar();
    if (keytar) {
        const stored = await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
        if (stored) return stored;
    }

    // Priority 3: interactive TTY prompt (first-time or keychain unavailable)
    if (!process.stdin.isTTY) {
        throw new Error(
            "Vault passphrase required. Run 'hexlane init' on this machine, " +
            "or set HEXLANE_VAULT_PASSPHRASE for non-interactive use."
        );
    }

    const passphrase = await promptPassphraseHidden("Hexlane vault passphrase: ");
    if (!passphrase) {
        throw new Error("Passphrase cannot be empty.");
    }

    // Offer to save to keychain so this never needs to be entered again
    if (keytar) {
        const save = await promptConfirm("Save passphrase to macOS Keychain? [Y/n]: ");
        if (save) {
            await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, passphrase);
            console.error("Passphrase saved to macOS Keychain. You will not be prompted again.");
        }
    }

    return passphrase;
}

export async function deleteKeychainPassphrase(): Promise<boolean> {
    const keytar = await tryKeytar();
    if (!keytar) return false;
    return keytar.deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
}

function promptPassphraseHidden(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
        // Do NOT use readline here — it echoes characters via its own output stream.
        // Write the prompt directly and listen to raw stdin instead.
        process.stdout.write(prompt);
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding("utf8");

        let input = "";

        const onData = (char: string) => {
            if (char === "\n" || char === "\r" || char === "\u0004") {
                process.stdin.setRawMode(false);
                process.stdin.pause();
                process.stdin.removeListener("data", onData);
                process.stdout.write("\n");
                resolve(input);
            } else if (char === "\u0003") {
                process.stdin.setRawMode(false);
                process.stdin.pause();
                process.stdin.removeListener("data", onData);
                reject(new Error("Passphrase entry aborted"));
            } else if (char === "\u007f" || char === "\b") {
                input = input.slice(0, -1);
            } else {
                input += char;
            }
        };

        process.stdin.on("data", onData);
    });
}

function promptConfirm(prompt: string): Promise<boolean> {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(prompt, (answer) => {
            rl.close();
            resolve(answer.trim().toLowerCase() !== "n");
        });
    });
}

export class VaultManager {
    private vaultDir: string;
    private derivedKey: Buffer | null = null;

    constructor(hexlaneDir: string) {
        this.vaultDir = path.join(hexlaneDir, "vault");
    }

    /**
     * Must be called once before any encrypt/decrypt operation.
     * Derives the key from passphrase + salt and holds it in memory.
     */
    async unlock(): Promise<void> {
        if (this.derivedKey) return;
        const salt = this.getOrCreateSalt();
        const passphrase = await resolvePassphrase();
        this.derivedKey = deriveKey(passphrase, salt);
    }

    private getOrCreateSalt(): Buffer {
        fs.mkdirSync(this.vaultDir, { recursive: true });
        const saltPath = path.join(this.vaultDir, SALT_FILE);
        if (fs.existsSync(saltPath)) {
            return fs.readFileSync(saltPath);
        }
        const salt = crypto.randomBytes(SALT_LENGTH);
        fs.writeFileSync(saltPath, salt);
        return salt;
    }

    private key(): Buffer {
        if (!this.derivedKey) {
            throw new Error("Vault is locked. Call unlock() first.");
        }
        return this.derivedKey;
    }

    /**
     * Returns a deterministic, opaque filename for a logical identity.
     * sha256(app:env:profile) → first 32 hex chars.
     */
    static vaultRef(app: string, env: string, profile: string): string {
        return crypto
            .createHash("sha256")
            .update(`${app}:${env}:${profile}`)
            .digest("hex")
            .substring(0, 32);
    }

    private vaultPath(vaultRef: string): string {
        return path.join(this.vaultDir, `${vaultRef}.enc`);
    }

    write(vaultRef: string, secret: VaultSecret): void {
        const key = this.key();
        const plaintext = Buffer.from(JSON.stringify(secret), "utf8");
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const tag = cipher.getAuthTag();
        // File layout: [IV 12 bytes][ciphertext N bytes][tag 16 bytes]
        const payload = Buffer.concat([iv, ciphertext, tag]);
        fs.mkdirSync(this.vaultDir, { recursive: true });
        // Atomic write: write to .tmp then rename
        const tmpPath = `${this.vaultPath(vaultRef)}.tmp`;
        fs.writeFileSync(tmpPath, payload);
        fs.renameSync(tmpPath, this.vaultPath(vaultRef));
    }

    read(vaultRef: string): VaultSecret {
        const key = this.key();
        const filePath = this.vaultPath(vaultRef);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Vault record not found for ref: ${vaultRef}`);
        }
        const payload = fs.readFileSync(filePath);
        if (payload.length < IV_LENGTH + TAG_LENGTH + 1) {
            throw new Error("Vault file is corrupted or too short");
        }
        const iv = payload.subarray(0, IV_LENGTH);
        const tag = payload.subarray(payload.length - TAG_LENGTH);
        const ciphertext = payload.subarray(IV_LENGTH, payload.length - TAG_LENGTH);
        try {
            const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
            decipher.setAuthTag(tag);
            const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
            return JSON.parse(plaintext.toString("utf8")) as VaultSecret;
        } catch {
            throw new Error(
                "Failed to decrypt vault record. Wrong passphrase or file tampered."
            );
        }
    }

    delete(vaultRef: string): void {
        const filePath = this.vaultPath(vaultRef);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }

    exists(vaultRef: string): boolean {
        return fs.existsSync(this.vaultPath(vaultRef));
    }
}
