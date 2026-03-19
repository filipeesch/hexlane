import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as nodePath from "path";
import * as nodeFs from "fs";
import * as os from "os";
import {
    saveSnapshot,
    loadSnapshot,
    listSnapshots,
    deleteSnapshot,
    pruneSnapshots,
    snapshotsDir,
} from "../snapshot-store.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let originalHome: string | undefined;
let tempHome: string;

beforeEach(() => {
    // Redirect HOME so snapshots go to a temp directory
    tempHome = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "hexlane-snap-test-"));
    originalHome = process.env["HOME"];
    process.env["HOME"] = tempHome;
});

afterEach(() => {
    process.env["HOME"] = originalHome;
    nodeFs.rmSync(tempHome, { recursive: true, force: true });
});

// ─── saveSnapshot / loadSnapshot ─────────────────────────────────────────────

describe("saveSnapshot / loadSnapshot", () => {
    it("saves a snapshot and loads it back by operationId", () => {
        const snap = saveSnapshot({
            targetId: "my-src",
            command: "replace",
            files: [{ path: "src/foo.ts", originalContent: "const x = 1;" }],
        });
        expect(snap.operationId).toMatch(/^rep_\d+_[a-z0-9]+$/);
        expect(snap.targetId).toBe("my-src");
        expect(snap.files).toHaveLength(1);

        const loaded = loadSnapshot(snap.operationId);
        expect(loaded.operationId).toBe(snap.operationId);
        expect(loaded.files[0].originalContent).toBe("const x = 1;");
    });

    it("throws when loading a non-existent operationId", () => {
        expect(() => loadSnapshot("rep_0_nosuch")).toThrow("not found");
    });

    it("snapshot file is written to the correct directory", () => {
        const snap = saveSnapshot({ targetId: "t", command: "write", files: [] });
        const dir = snapshotsDir();
        expect(nodeFs.existsSync(nodePath.join(dir, `${snap.operationId}.json`))).toBe(true);
    });

    it("operationId prefix reflects command name (first 3 chars)", () => {
        const s1 = saveSnapshot({ targetId: "t", command: "write", files: [] });
        const s2 = saveSnapshot({ targetId: "t", command: "delete", files: [] });
        const s3 = saveSnapshot({ targetId: "t", command: "replace", files: [] });
        const s4 = saveSnapshot({ targetId: "t", command: "move", files: [] });
        expect(s1.operationId).toMatch(/^wri_/);
        expect(s2.operationId).toMatch(/^del_/);
        expect(s3.operationId).toMatch(/^rep_/);
        expect(s4.operationId).toMatch(/^mov_/);
    });
});

// ─── listSnapshots ───────────────────────────────────────────────────────────

describe("listSnapshots", () => {
    it("returns empty array when no snapshots exist", () => {
        expect(listSnapshots()).toEqual([]);
    });

    it("returns all snapshots when no targetId filter is given", () => {
        saveSnapshot({ targetId: "t1", command: "write", files: [] });
        saveSnapshot({ targetId: "t2", command: "write", files: [] });
        expect(listSnapshots()).toHaveLength(2);
    });

    it("filters by targetId", () => {
        saveSnapshot({ targetId: "t1", command: "write", files: [] });
        saveSnapshot({ targetId: "t2", command: "write", files: [] });
        saveSnapshot({ targetId: "t1", command: "replace", files: [] });
        const t1 = listSnapshots("t1");
        expect(t1).toHaveLength(2);
        expect(t1.every((s) => s.targetId === "t1")).toBe(true);
    });

    it("returns snapshots sorted by timestamp descending", () => {
        saveSnapshot({ targetId: "t", command: "write", files: [] });
        saveSnapshot({ targetId: "t", command: "replace", files: [] });
        const list = listSnapshots();
        // second saved should be first in the list (most recent)
        expect(list[0].command).toBe("replace");
    });
});

// ─── deleteSnapshot ──────────────────────────────────────────────────────────

describe("deleteSnapshot", () => {
    it("removes the snapshot file", () => {
        const snap = saveSnapshot({ targetId: "t", command: "write", files: [] });
        deleteSnapshot(snap.operationId);
        expect(() => loadSnapshot(snap.operationId)).toThrow("not found");
    });

    it("does not throw when deleting a non-existent snapshot", () => {
        expect(() => deleteSnapshot("rep_0_ghost")).not.toThrow();
    });
});

// ─── pruneSnapshots ──────────────────────────────────────────────────────────

describe("pruneSnapshots", () => {
    it("returns 0 pruned when no snapshots exist", () => {
        const result = pruneSnapshots(7);
        expect(result.pruned).toBe(0);
        expect(result.total).toBe(0);
    });

    it("does not prune recent snapshots", () => {
        saveSnapshot({ targetId: "t", command: "write", files: [] });
        const result = pruneSnapshots(7);
        expect(result.pruned).toBe(0);
        expect(result.total).toBe(1);
    });

    it("prunes snapshots older than the cutoff by back-dating the file", () => {
        const snap = saveSnapshot({ targetId: "t", command: "write", files: [] });
        // Back-date the snapshot timestamp to 8 days ago
        const dir = snapshotsDir();
        const p = nodePath.join(dir, `${snap.operationId}.json`);
        const content = JSON.parse(nodeFs.readFileSync(p, "utf8"));
        const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
        content.timestamp = oldDate;
        nodeFs.writeFileSync(p, JSON.stringify(content), "utf8");

        const result = pruneSnapshots(7);
        expect(result.pruned).toBe(1);
        expect(listSnapshots()).toHaveLength(0);
    });

    it("removes corrupt snapshot files", () => {
        const dir = snapshotsDir();
        nodeFs.mkdirSync(dir, { recursive: true });
        nodeFs.writeFileSync(nodePath.join(dir, "corrupt.json"), "not-json", "utf8");
        const result = pruneSnapshots(0);
        expect(result.pruned).toBe(1);
    });
});
