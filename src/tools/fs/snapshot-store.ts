import * as nodeFsSync from "fs";
import * as nodePath from "path";
import * as os from "os";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SnapshotFile {
    path: string;           // relative to target root
    originalContent: string;
}

export interface Snapshot {
    operationId: string;
    targetId: string;
    command: string;        // replace | write | move | delete
    timestamp: string;      // ISO-8601
    files: SnapshotFile[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SNAPSHOT_TTL_DAYS = 7;

export function snapshotsDir(): string {
    return nodePath.join(os.homedir(), ".hexlane", "tools", "fs", "snapshots");
}

function snapshotPath(operationId: string): string {
    return nodePath.join(snapshotsDir(), `${operationId}.json`);
}

function generateOperationId(prefix: string): string {
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 7);
    return `${prefix}_${ts}_${rand}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function saveSnapshot(snapshot: Omit<Snapshot, "operationId" | "timestamp"> & { command: string }): Snapshot {
    const dir = snapshotsDir();
    nodeFsSync.mkdirSync(dir, { recursive: true });

    const prefix = snapshot.command.slice(0, 3);
    const operationId = generateOperationId(prefix);
    const full: Snapshot = {
        ...snapshot,
        operationId,
        timestamp: new Date().toISOString(),
    };
    nodeFsSync.writeFileSync(snapshotPath(operationId), JSON.stringify(full, null, 2), "utf8");
    return full;
}

export function loadSnapshot(operationId: string): Snapshot {
    const p = snapshotPath(operationId);
    if (!nodeFsSync.existsSync(p)) {
        throw new Error(`Snapshot "${operationId}" not found.`);
    }
    return JSON.parse(nodeFsSync.readFileSync(p, "utf8")) as Snapshot;
}

export function listSnapshots(targetId?: string): Snapshot[] {
    const dir = snapshotsDir();
    if (!nodeFsSync.existsSync(dir)) return [];
    const files = nodeFsSync.readdirSync(dir).filter((f) => f.endsWith(".json"));
    const snapshots: Snapshot[] = [];
    for (const file of files) {
        try {
            const s = JSON.parse(nodeFsSync.readFileSync(nodePath.join(dir, file), "utf8")) as Snapshot;
            if (!targetId || s.targetId === targetId) snapshots.push(s);
        } catch {
            // skip corrupt snapshot files
        }
    }
    return snapshots.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export function deleteSnapshot(operationId: string): void {
    const p = snapshotPath(operationId);
    if (nodeFsSync.existsSync(p)) nodeFsSync.unlinkSync(p);
}

export function pruneSnapshots(olderThanDays: number = SNAPSHOT_TTL_DAYS): { pruned: number; total: number } {
    const dir = snapshotsDir();
    if (!nodeFsSync.existsSync(dir)) return { pruned: 0, total: 0 };

    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const files = nodeFsSync.readdirSync(dir).filter((f) => f.endsWith(".json"));
    let pruned = 0;

    for (const file of files) {
        const p = nodePath.join(dir, file);
        try {
            const s = JSON.parse(nodeFsSync.readFileSync(p, "utf8")) as Snapshot;
            if (new Date(s.timestamp).getTime() < cutoff) {
                nodeFsSync.unlinkSync(p);
                pruned++;
            }
        } catch {
            // remove corrupt files
            nodeFsSync.unlinkSync(p);
            pruned++;
        }
    }

    return { pruned, total: files.length };
}
