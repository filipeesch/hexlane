import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

interface LockData {
    pid: number;
    locked_at: string;
}

const LOCK_TTL_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const LOCK_WAIT_MS = 5_000;

export class LockManager {
    private locksDir: string;

    constructor(hexlaneDir: string) {
        this.locksDir = path.join(hexlaneDir, "locks");
        fs.mkdirSync(this.locksDir, { recursive: true });
    }

    private lockPath(vaultRef: string): string {
        return path.join(this.locksDir, `${vaultRef}.lock`);
    }

    private isProcessAlive(pid: number): boolean {
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    }

    private readLock(vaultRef: string): LockData | null {
        const p = this.lockPath(vaultRef);
        if (!fs.existsSync(p)) return null;
        try {
            return JSON.parse(fs.readFileSync(p, "utf8")) as LockData;
        } catch {
            return null;
        }
    }

    private isStale(lockData: LockData): boolean {
        const age = Date.now() - new Date(lockData.locked_at).getTime();
        return age > LOCK_TTL_MS || !this.isProcessAlive(lockData.pid);
    }

    /**
     * Acquires an advisory lock for the given vaultRef.
     * Waits up to LOCK_WAIT_MS if another process holds the lock.
     * Throws if lock cannot be acquired.
     */
    async acquire(vaultRef: string): Promise<void> {
        const deadline = Date.now() + LOCK_WAIT_MS;
        while (Date.now() < deadline) {
            const existing = this.readLock(vaultRef);
            if (existing && !this.isStale(existing)) {
                await sleep(POLL_INTERVAL_MS);
                continue;
            }
            // Write lock
            const lockData: LockData = {
                pid: process.pid,
                locked_at: new Date().toISOString(),
            };
            fs.writeFileSync(this.lockPath(vaultRef), JSON.stringify(lockData));
            return;
        }
        throw new Error(
            `Could not acquire lock for credential renewal (another process may be renewing). ` +
            `Lock ref: ${vaultRef}`
        );
    }

    release(vaultRef: string): void {
        const p = this.lockPath(vaultRef);
        if (fs.existsSync(p)) {
            fs.unlinkSync(p);
        }
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
