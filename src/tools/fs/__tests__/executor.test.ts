import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as nodePath from "path";
import * as nodeFs from "fs";
import * as os from "os";
import {
    safePath,
    isBinaryFile,
    validateFsConfig,
    fsRead,
    fsReadGlob,
    fsStat,
    fsList,
    fsSearch,
    fsWrite,
    fsReplace,
    fsMove,
    fsDelete,
    fsRollback,
} from "../executor.js";
import { loadSnapshot, snapshotsDir } from "../snapshot-store.js";

// ─── Test scaffolding ─────────────────────────────────────────────────────────

let tempRoot: string;
let tempHome: string;
let originalHome: string | undefined;

beforeEach(() => {
    tempRoot = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "hexlane-fs-test-"));
    tempHome = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "hexlane-home-test-"));
    originalHome = process.env["HOME"];
    process.env["HOME"] = tempHome;
});

afterEach(() => {
    process.env["HOME"] = originalHome;
    nodeFs.rmSync(tempRoot, { recursive: true, force: true });
    nodeFs.rmSync(tempHome, { recursive: true, force: true });
});

function writeFile(relative: string, content: string): void {
    const abs = nodePath.join(tempRoot, relative);
    nodeFs.mkdirSync(nodePath.dirname(abs), { recursive: true });
    nodeFs.writeFileSync(abs, content, "utf8");
}

function readFile(relative: string): string {
    return nodeFs.readFileSync(nodePath.join(tempRoot, relative), "utf8");
}

// ─── validateFsConfig ────────────────────────────────────────────────────────

describe("validateFsConfig", () => {
    it("returns config with root and defaults", () => {
        const cfg = validateFsConfig({ root: "/some/path" });
        expect(cfg.root).toBe("/some/path");
        expect(cfg.readonly).toBe(false);
    });

    it("returns readonly true when set", () => {
        const cfg = validateFsConfig({ root: "/p", readonly: true });
        expect(cfg.readonly).toBe(true);
    });

    it("throws when root is missing", () => {
        expect(() => validateFsConfig({})).toThrow("root");
    });

    it("throws when root is not a string", () => {
        expect(() => validateFsConfig({ root: 123 })).toThrow("root");
    });
});

// ─── safePath ─────────────────────────────────────────────────────────────────

describe("safePath", () => {
    it("resolves a valid relative path", () => {
        const result = safePath(tempRoot, "src/foo.ts");
        expect(result).toBe(nodePath.resolve(tempRoot, "src/foo.ts"));
    });

    it("throws on path traversal with ../", () => {
        expect(() => safePath(tempRoot, "../outside.ts")).toThrow("Path traversal");
    });

    it("throws on deeply nested traversal", () => {
        expect(() => safePath(tempRoot, "a/../../outside")).toThrow("Path traversal");
    });

    it("allows a path that resolves exactly to root", () => {
        expect(() => safePath(tempRoot, ".")).not.toThrow();
    });
});

// ─── isBinaryFile ─────────────────────────────────────────────────────────────

describe("isBinaryFile", () => {
    it("returns false for a text file", () => {
        writeFile("text.ts", "const x = 1;");
        expect(isBinaryFile(nodePath.join(tempRoot, "text.ts"))).toBe(false);
    });

    it("returns true for a file containing a null byte", () => {
        const abs = nodePath.join(tempRoot, "binary.bin");
        nodeFs.writeFileSync(abs, Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6f]));
        expect(isBinaryFile(abs)).toBe(true);
    });
});

// ─── fsRead ──────────────────────────────────────────────────────────────────

describe("fsRead", () => {
    it("reads the full content of a file", () => {
        writeFile("src/foo.ts", "line1\nline2\nline3");
        const result = fsRead(tempRoot, "src/foo.ts");
        expect(result.content).toBe("line1\nline2\nline3");
        expect(result.totalLines).toBe(3);
    });

    it("reads a line range", () => {
        writeFile("src/foo.ts", "a\nb\nc\nd\ne");
        const result = fsRead(tempRoot, "src/foo.ts", { start: 2, end: 4 });
        expect(result.content).toBe("b\nc\nd");
        expect(result.lines).toEqual({ start: 2, end: 4 });
    });

    it("clamps line range to file bounds", () => {
        writeFile("src/foo.ts", "a\nb\nc");
        const result = fsRead(tempRoot, "src/foo.ts", { start: 1, end: 100 });
        expect(result.content).toBe("a\nb\nc");
    });

    it("throws when file does not exist", () => {
        expect(() => fsRead(tempRoot, "missing.ts")).toThrow("not found");
    });

    it("throws on binary file", () => {
        const abs = nodePath.join(tempRoot, "bin.dat");
        nodeFs.writeFileSync(abs, Buffer.from([0x00, 0x01]));
        expect(() => fsRead(tempRoot, "bin.dat")).toThrow("Binary file rejected");
    });

    it("throws on invalid line range (start > end)", () => {
        writeFile("src/foo.ts", "a\nb");
        expect(() => fsRead(tempRoot, "src/foo.ts", { start: 5, end: 3 })).toThrow("Invalid line range");
    });
});

// ─── fsReadGlob ───────────────────────────────────────────────────────────────

describe("fsReadGlob", () => {
    it("reads all matching text files", async () => {
        writeFile("a.ts", "alpha");
        writeFile("b.ts", "beta");
        const { files, skipped } = await fsReadGlob(tempRoot, "**/*.ts");
        expect(files).toHaveLength(2);
        expect(files.map((f) => f.file).sort()).toEqual(["a.ts", "b.ts"]);
        expect(files.find((f) => f.file === "a.ts")?.content).toBe("alpha");
        expect(skipped).toHaveLength(0);
    });

    it("skips binary files and reports them in skipped", async () => {
        writeFile("a.ts", "text");
        const abs = nodePath.join(tempRoot, "bin.ts");
        nodeFs.writeFileSync(abs, Buffer.from([0x00, 0x01, 0x02]));
        const { files, skipped } = await fsReadGlob(tempRoot, "**/*.ts");
        expect(files).toHaveLength(1);
        expect(skipped).toContain("bin.ts");
    });

    it("respects depth limit", async () => {
        writeFile("top.ts", "top");
        writeFile("nested/deep.ts", "deep");
        const { files } = await fsReadGlob(tempRoot, "**/*.ts", 1);
        expect(files.map((f) => f.file)).toContain("top.ts");
        expect(files.map((f) => f.file)).not.toContain("nested/deep.ts");
    });

    it("returns empty arrays when no files match", async () => {
        const { files, skipped } = await fsReadGlob(tempRoot, "**/*.ts");
        expect(files).toHaveLength(0);
        expect(skipped).toHaveLength(0);
    });

    it("includes totalLines in each result", async () => {
        writeFile("a.ts", "line1\nline2\nline3");
        const { files } = await fsReadGlob(tempRoot, "**/*.ts");
        expect(files[0].totalLines).toBe(3);
    });
});

// ─── fsStat ───────────────────────────────────────────────────────────────────

describe("fsStat", () => {
    it("returns metadata for a file", () => {
        writeFile("src/foo.ts", "hello");
        const stat = fsStat(tempRoot, "src/foo.ts");
        expect(stat.file).toBe("src/foo.ts");
        expect(stat.size).toBe(5);
        expect(stat.isDirectory).toBe(false);
        expect(stat.modifiedAt).toBeTruthy();
    });

    it("throws for a non-existent path", () => {
        expect(() => fsStat(tempRoot, "ghost.ts")).toThrow("not found");
    });
});

// ─── fsList ───────────────────────────────────────────────────────────────────

describe("fsList", () => {
    it("lists all files under root", async () => {
        writeFile("a.ts", "");
        writeFile("src/b.ts", "");
        const entries = await fsList(tempRoot);
        const paths = entries.map((e) => e.path);
        expect(paths).toContain("a.ts");
        expect(paths).toContain("src/b.ts");
    });

    it("filters by glob pattern", async () => {
        writeFile("a.ts", "");
        writeFile("b.md", "");
        const entries = await fsList(tempRoot, "**/*.ts");
        expect(entries.every((e) => e.path.endsWith(".ts"))).toBe(true);
    });

    it("respects depth limit", async () => {
        writeFile("top.ts", "");
        writeFile("nested/deep.ts", "");
        const entries = await fsList(tempRoot, "**/*", 1);
        const paths = entries.map((e) => e.path);
        expect(paths).toContain("top.ts");
        expect(paths).not.toContain("nested/deep.ts");
    });

    it("includes size and modifiedAt for each entry", async () => {
        writeFile("a.ts", "hello");
        const entries = await fsList(tempRoot, "**/*.ts");
        expect(entries[0].size).toBeGreaterThan(0);
        expect(entries[0].modifiedAt).toBeTruthy();
        expect(entries[0].sizeHuman).toMatch(/\d+B/);
    });
});

// ─── fsSearch ────────────────────────────────────────────────────────────────

describe("fsSearch", () => {
    it("finds matching lines with context", async () => {
        writeFile("src/foo.ts", "alpha\nbeta\ngamma\ndelta\nepsilon");
        const results = await fsSearch(tempRoot, "gamma", "**/*.ts", 1);
        expect(results).toHaveLength(1);
        expect(results[0].line).toBe(3);
        expect(results[0].match).toBe("gamma");
        expect(results[0].contextBefore).toEqual(["beta"]);
        expect(results[0].contextAfter).toEqual(["delta"]);
    });

    it("returns empty array when pattern not found", async () => {
        writeFile("src/foo.ts", "hello world");
        const results = await fsSearch(tempRoot, "zzz", "**/*.ts");
        expect(results).toHaveLength(0);
    });

    it("finds matches across multiple files", async () => {
        writeFile("a.ts", "TODO: fix this");
        writeFile("b.ts", "// TODO: later");
        const results = await fsSearch(tempRoot, "TODO", "**/*.ts");
        expect(results).toHaveLength(2);
    });

    it("supports regex patterns", async () => {
        writeFile("src/foo.ts", "const x = 123;\nconst y = 456;");
        const results = await fsSearch(tempRoot, "const \\w+ = \\d+", "**/*.ts");
        expect(results).toHaveLength(2);
    });

    it("silently skips binary files during search", async () => {
        writeFile("text.ts", "searchme");
        const abs = nodePath.join(tempRoot, "binary.bin");
        nodeFs.writeFileSync(abs, Buffer.from([0x00, 0x01, 0x02]));
        const results = await fsSearch(tempRoot, "searchme", "**/*");
        expect(results.every((r) => r.file === "text.ts")).toBe(true);
    });
});

// ─── fsWrite — create ────────────────────────────────────────────────────────

describe("fsWrite — create", () => {
    it("creates a new file", () => {
        const result = fsWrite(tempRoot, "tgt", { file: "new.ts", content: "hello" });
        expect(result.action).toBe("created");
        expect(readFile("new.ts")).toBe("hello");
    });

    it("creates parent directories as needed", () => {
        fsWrite(tempRoot, "tgt", { file: "deep/nested/file.ts", content: "x" });
        expect(readFile("deep/nested/file.ts")).toBe("x");
    });

    it("does not snapshot when creating (nothing to restore)", () => {
        const result = fsWrite(tempRoot, "tgt", { file: "new.ts", content: "x" });
        expect(result.operationId).toBeUndefined();
    });

    it("dry-run returns diff without creating the file", () => {
        const result = fsWrite(tempRoot, "tgt", { file: "new.ts", content: "hi", dryRun: true });
        expect(result.dryRun).toBe(true);
        expect(result.diff).toContain("+ hi");
        expect(nodeFs.existsSync(nodePath.join(tempRoot, "new.ts"))).toBe(false);
    });
});

// ─── fsWrite — overwrite ─────────────────────────────────────────────────────

describe("fsWrite — overwrite", () => {
    it("overwrites an existing file and snapshots original", () => {
        writeFile("foo.ts", "original");
        const result = fsWrite(tempRoot, "tgt", { file: "foo.ts", content: "updated" });
        expect(result.action).toBe("overwritten");
        expect(readFile("foo.ts")).toBe("updated");
        expect(result.operationId).toBeDefined();

        const snap = loadSnapshot(result.operationId!);
        expect(snap.files[0].originalContent).toBe("original");
    });

    it("dry-run does not modify the file", () => {
        writeFile("foo.ts", "original");
        fsWrite(tempRoot, "tgt", { file: "foo.ts", content: "updated", dryRun: true });
        expect(readFile("foo.ts")).toBe("original");
    });

    it("throws on binary file", () => {
        const abs = nodePath.join(tempRoot, "bin.dat");
        nodeFs.writeFileSync(abs, Buffer.from([0x00, 0x01]));
        expect(() => fsWrite(tempRoot, "tgt", { file: "bin.dat", content: "x" }))
            .toThrow("Binary file rejected");
    });
});

// ─── fsWrite — patch (lines) ─────────────────────────────────────────────────

describe("fsWrite — patch", () => {
    it("replaces the specified line range", () => {
        writeFile("foo.ts", "a\nb\nc\nd\ne");
        fsWrite(tempRoot, "tgt", { file: "foo.ts", content: "X\nY", lines: { start: 2, end: 3 } });
        expect(readFile("foo.ts")).toBe("a\nX\nY\nd\ne");
    });

    it("snapshots original content before patching", () => {
        writeFile("foo.ts", "a\nb\nc");
        const result = fsWrite(tempRoot, "tgt", { file: "foo.ts", content: "Z", lines: { start: 2, end: 2 } });
        expect(result.operationId).toBeDefined();
        const snap = loadSnapshot(result.operationId!);
        expect(snap.files[0].originalContent).toBe("a\nb\nc");
    });

    it("returns action: patched", () => {
        writeFile("foo.ts", "a\nb\nc");
        const result = fsWrite(tempRoot, "tgt", { file: "foo.ts", content: "Z", lines: { start: 2, end: 2 } });
        expect(result.action).toBe("patched");
    });
});

// ─── fsWrite — --expect ──────────────────────────────────────────────────────

describe("fsWrite — --expect", () => {
    it("applies patch when expect string is found on start line", () => {
        writeFile("foo.ts", "const x = 1;\nconst y = 2;");
        const result = fsWrite(tempRoot, "tgt", {
            file: "foo.ts",
            content: "const x = 99;",
            lines: { start: 1, end: 1 },
            expect: "const x = 1",
        });
        expect(result.expectResult?.matched).toBe(true);
        expect(readFile("foo.ts")).toBe("const x = 99;\nconst y = 2;");
    });

    it("returns failed expectResult and does NOT apply patch when expect string is not found", () => {
        writeFile("foo.ts", "const x = 1;\nconst y = 2;");
        const result = fsWrite(tempRoot, "tgt", {
            file: "foo.ts",
            content: "const x = 99;",
            lines: { start: 1, end: 1 },
            expect: "THIS_WILL_NOT_MATCH",
        });
        expect(result.expectResult?.matched).toBe(false);
        expect(result.expectResult?.found).toBe("const x = 1;");
        expect(readFile("foo.ts")).toBe("const x = 1;\nconst y = 2;"); // unchanged
        expect(result.operationId).toBeUndefined(); // no snapshot taken
    });

    it("includes found line content in expectResult on mismatch", () => {
        writeFile("foo.ts", "actual content here");
        const result = fsWrite(tempRoot, "tgt", {
            file: "foo.ts",
            content: "new",
            lines: { start: 1, end: 1 },
            expect: "expected something else",
        });
        expect(result.expectResult?.found).toBe("actual content here");
    });

    it("throws when using --expect on a non-existent file", () => {
        expect(() => fsWrite(tempRoot, "tgt", {
            file: "ghost.ts",
            content: "x",
            lines: { start: 1, end: 1 },
            expect: "anything",
        })).toThrow("non-existent");
    });
});

// ─── fsReplace ───────────────────────────────────────────────────────────────

describe("fsReplace", () => {
    it("replaces pattern across multiple files and snapshots all", async () => {
        writeFile("a.ts", 'const foo = require("bar");');
        writeFile("b.ts", 'const baz = require("qux");');
        const result = await fsReplace(tempRoot, "tgt", {
            pattern: 'require\\("([^"]+)"\\)',
            replacement: 'import from "$1"',
            globPattern: "**/*.ts",
        });
        expect(result.filesAffected).toBe(2);
        expect(result.totalMatches).toBe(2);
        expect(result.operationId).toBeDefined();

        const snap = loadSnapshot(result.operationId!);
        expect(snap.files).toHaveLength(2);
    });

    it("dry-run returns diffs without modifying files", async () => {
        writeFile("a.ts", "hello world");
        const result = await fsReplace(tempRoot, "tgt", {
            pattern: "hello",
            replacement: "goodbye",
            dryRun: true,
        });
        expect(result.dryRun).toBe(true);
        expect(readFile("a.ts")).toBe("hello world"); // unchanged
    });

    it("returns empty result when pattern matches nothing", async () => {
        writeFile("a.ts", "no match here");
        const result = await fsReplace(tempRoot, "tgt", { pattern: "ZZZNOMATCH", replacement: "x" });
        expect(result.filesAffected).toBe(0);
        expect(result.totalMatches).toBe(0);
        expect(result.operationId).toBeUndefined();
    });

    it("throws on binary file encountered during replace", async () => {
        const abs = nodePath.join(tempRoot, "binary.bin");
        nodeFs.writeFileSync(abs, Buffer.from([0x00, 0x01, 0x02]));
        await expect(fsReplace(tempRoot, "tgt", {
            pattern: "x",
            replacement: "y",
            globPattern: "**/*.bin",
        })).rejects.toThrow("Binary file");
    });

    it("scopes replacement to glob pattern", async () => {
        writeFile("a.ts", "replace_me");
        writeFile("b.md", "replace_me");
        await fsReplace(tempRoot, "tgt", { pattern: "replace_me", replacement: "done", globPattern: "**/*.ts" });
        expect(readFile("a.ts")).toBe("done");
        expect(readFile("b.md")).toBe("replace_me"); // untouched
    });

    it("--literal treats pattern as exact string not regex", async () => {
        writeFile("a.ts", "hello.world");
        const result = await fsReplace(tempRoot, "tgt", {
            pattern: "hello.world",
            replacement: "hello_world",
            literal: true,
        });
        expect(result.totalMatches).toBe(1);
        expect(readFile("a.ts")).toBe("hello_world");
    });

    it("--literal does not treat dot as wildcard", async () => {
        writeFile("a.ts", "helloXworld");
        const result = await fsReplace(tempRoot, "tgt", {
            pattern: "hello.world",
            replacement: "replaced",
            literal: true,
        });
        // dot is literal — helloXworld should NOT match
        expect(result.filesAffected).toBe(0);
        expect(readFile("a.ts")).toBe("helloXworld");
    });

    it("--once succeeds when exactly one match exists", async () => {
        writeFile("a.ts", "const foo = 1;");
        const result = await fsReplace(tempRoot, "tgt", {
            pattern: "foo",
            replacement: "bar",
            once: true,
            globPattern: "**/*.ts",
        });
        expect(result.totalMatches).toBe(1);
        expect(readFile("a.ts")).toBe("const bar = 1;");
    });

    it("--once errors when pattern matches zero times", async () => {
        writeFile("a.ts", "no match here");
        await expect(fsReplace(tempRoot, "tgt", {
            pattern: "NOTFOUND",
            replacement: "x",
            once: true,
        })).rejects.toThrow("--once specified but pattern");
    });

    it("--once errors when pattern matches more than once", async () => {
        writeFile("a.ts", "foo foo");
        await expect(fsReplace(tempRoot, "tgt", {
            pattern: "foo",
            replacement: "bar",
            once: true,
        })).rejects.toThrow("matched 2 times");
    });

    it("--file targets a single file instead of glob", async () => {
        writeFile("a.ts", "target");
        writeFile("b.ts", "target");
        const result = await fsReplace(tempRoot, "tgt", {
            pattern: "target",
            replacement: "replaced",
            file: "a.ts",
        });
        expect(result.filesAffected).toBe(1);
        expect(readFile("a.ts")).toBe("replaced");
        expect(readFile("b.ts")).toBe("target"); // untouched
    });

    it("--file errors if file does not exist", async () => {
        await expect(fsReplace(tempRoot, "tgt", {
            pattern: "x",
            replacement: "y",
            file: "missing.ts",
        })).rejects.toThrow("not found");
    });

    it("--file and --glob are mutually exclusive", async () => {
        writeFile("a.ts", "x");
        await expect(fsReplace(tempRoot, "tgt", {
            pattern: "x",
            replacement: "y",
            file: "a.ts",
            globPattern: "**/*.ts",
        })).rejects.toThrow("mutually exclusive");
    });
});

// ─── fsMove ───────────────────────────────────────────────────────────────────

describe("fsMove", () => {
    it("moves a file and snapshots original content", () => {
        writeFile("old.ts", "content");
        const result = fsMove(tempRoot, "tgt", { from: "old.ts", to: "new.ts" });
        expect(result.from).toBe("old.ts");
        expect(result.to).toBe("new.ts");
        expect(nodeFs.existsSync(nodePath.join(tempRoot, "new.ts"))).toBe(true);
        expect(nodeFs.existsSync(nodePath.join(tempRoot, "old.ts"))).toBe(false);
        expect(result.operationId).toBeDefined();

        const snap = loadSnapshot(result.operationId!);
        expect(snap.command).toBe("move");
        expect(snap.files[0].path).toBe("old.ts");
    });

    it("dry-run does not move the file", () => {
        writeFile("old.ts", "x");
        const result = fsMove(tempRoot, "tgt", { from: "old.ts", to: "new.ts", dryRun: true });
        expect(result.dryRun).toBe(true);
        expect(nodeFs.existsSync(nodePath.join(tempRoot, "old.ts"))).toBe(true);
    });

    it("throws when source does not exist", () => {
        expect(() => fsMove(tempRoot, "tgt", { from: "ghost.ts", to: "new.ts" }))
            .toThrow("Source not found");
    });

    it("throws when destination already exists", () => {
        writeFile("a.ts", "a");
        writeFile("b.ts", "b");
        expect(() => fsMove(tempRoot, "tgt", { from: "a.ts", to: "b.ts" }))
            .toThrow("Destination already exists");
    });

    it("throws on path traversal in destination", () => {
        writeFile("a.ts", "a");
        expect(() => fsMove(tempRoot, "tgt", { from: "a.ts", to: "../escape.ts" }))
            .toThrow("Path traversal");
    });
});

// ─── fsDelete ─────────────────────────────────────────────────────────────────

describe("fsDelete", () => {
    it("deletes a file and snapshots content", () => {
        writeFile("foo.ts", "deleteme");
        const result = fsDelete(tempRoot, "tgt", "foo.ts");
        expect(nodeFs.existsSync(nodePath.join(tempRoot, "foo.ts"))).toBe(false);
        expect(result.operationId).toBeDefined();

        const snap = loadSnapshot(result.operationId!);
        expect(snap.files[0].originalContent).toBe("deleteme");
    });

    it("dry-run does not delete the file", () => {
        writeFile("foo.ts", "x");
        const result = fsDelete(tempRoot, "tgt", "foo.ts", true);
        expect(result.dryRun).toBe(true);
        expect(nodeFs.existsSync(nodePath.join(tempRoot, "foo.ts"))).toBe(true);
    });

    it("throws when path does not exist", () => {
        expect(() => fsDelete(tempRoot, "tgt", "ghost.ts")).toThrow("not found");
    });

    it("throws on binary file", () => {
        const abs = nodePath.join(tempRoot, "bin.dat");
        nodeFs.writeFileSync(abs, Buffer.from([0x00, 0x01]));
        expect(() => fsDelete(tempRoot, "tgt", "bin.dat")).toThrow("Binary file rejected");
    });
});

// ─── fsRollback ───────────────────────────────────────────────────────────────

describe("fsRollback", () => {
    it("restores files from snapshot", () => {
        writeFile("foo.ts", "original");
        const result = fsWrite(tempRoot, "tgt", { file: "foo.ts", content: "modified" });
        expect(readFile("foo.ts")).toBe("modified");

        const snap = loadSnapshot(result.operationId!);
        const rollback = fsRollback(tempRoot, snap);
        expect(rollback.restored).toContain("foo.ts");
        expect(readFile("foo.ts")).toBe("original");
    });

    it("restores a deleted file from snapshot", () => {
        writeFile("foo.ts", "was here");
        const result = fsDelete(tempRoot, "tgt", "foo.ts");
        expect(nodeFs.existsSync(nodePath.join(tempRoot, "foo.ts"))).toBe(false);

        const snap = loadSnapshot(result.operationId!);
        fsRollback(tempRoot, snap);
        expect(readFile("foo.ts")).toBe("was here");
    });

    it("restores a moved file to original location", () => {
        writeFile("old.ts", "content");
        const result = fsMove(tempRoot, "tgt", { from: "old.ts", to: "new.ts" });

        const snap = loadSnapshot(result.operationId!);
        fsRollback(tempRoot, snap);
        expect(readFile("old.ts")).toBe("content");
    });

    it("restores a patched file to original state", () => {
        writeFile("foo.ts", "a\nb\nc");
        const result = fsWrite(tempRoot, "tgt", {
            file: "foo.ts",
            content: "PATCHED",
            lines: { start: 2, end: 2 },
        });

        const snap = loadSnapshot(result.operationId!);
        fsRollback(tempRoot, snap);
        expect(readFile("foo.ts")).toBe("a\nb\nc");
    });
});
