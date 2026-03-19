import * as nodeFs from "fs";
import * as nodePath from "path";
import { glob } from "glob";
import { saveSnapshot } from "./snapshot-store.js";
import type { Snapshot } from "./snapshot-store.js";

// ─── Config validation ────────────────────────────────────────────────────────

export interface FsTargetConfig {
    root: string;
    readonly?: boolean;
}

export function validateFsConfig(config: Record<string, unknown>): FsTargetConfig {
    if (!config["root"] || typeof config["root"] !== "string") {
        throw new Error("fs target config must have a root string");
    }
    return {
        root: config["root"] as string,
        readonly: config["readonly"] === true,
    };
}

// ─── Path safety ──────────────────────────────────────────────────────────────

/**
 * Resolves a relative path against root and ensures it doesn't escape root.
 * Throws on path traversal attempts.
 */
export function safePath(root: string, relative: string): string {
    const resolved = nodePath.resolve(root, relative);
    const resolvedRoot = nodePath.resolve(root);
    if (!resolved.startsWith(resolvedRoot + nodePath.sep) && resolved !== resolvedRoot) {
        throw new Error(`Path traversal detected: "${relative}" escapes the target root.`);
    }
    return resolved;
}

// ─── Binary detection ────────────────────────────────────────────────────────

const SAMPLE_BYTES = 8000;

/**
 * Returns true if the file appears to be binary (contains null bytes in the first 8KB).
 */
export function isBinaryFile(filePath: string): boolean {
    const fd = nodeFs.openSync(filePath, "r");
    const buf = Buffer.alloc(SAMPLE_BYTES);
    const bytesRead = nodeFs.readSync(fd, buf, 0, SAMPLE_BYTES, 0);
    nodeFs.closeSync(fd);
    for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0) return true;
    }
    return false;
}

function assertTextFile(filePath: string): void {
    if (isBinaryFile(filePath)) {
        throw new Error(`Binary file rejected: "${filePath}". Only text files are supported.`);
    }
}

// ─── Read operations ──────────────────────────────────────────────────────────

export interface FsReadResult {
    file: string;
    content: string;
    totalLines: number;
    lines?: { start: number; end: number };
}

export function fsRead(root: string, relative: string, lines?: { start: number; end: number }): FsReadResult {
    const abs = safePath(root, relative);
    if (!nodeFs.existsSync(abs)) throw new Error(`File not found: "${relative}"`);
    assertTextFile(abs);
    const all = nodeFs.readFileSync(abs, "utf8");
    const allLines = all.split("\n");
    const totalLines = allLines.length;

    if (!lines) {
        return { file: relative, content: all, totalLines };
    }

    const start = Math.max(1, lines.start);
    const end = Math.min(totalLines, lines.end);
    if (start > end) throw new Error(`Invalid line range: ${start}-${end} (file has ${totalLines} lines)`);

    const content = allLines.slice(start - 1, end).join("\n");
    return { file: relative, content, totalLines, lines: { start, end } };
}

export interface FsReadGlobResult {
    file: string;
    content: string;
    totalLines: number;
}

/**
 * Read all text files matching a glob pattern, returning their contents in one call.
 * Binary files are skipped with a warning in the skipped array.
 */
export async function fsReadGlob(
    root: string,
    pattern: string = "**/*",
    depth?: number,
): Promise<{ files: FsReadGlobResult[]; skipped: string[] }> {
    const resolvedRoot = nodePath.resolve(root);
    const matches = await glob(pattern, { cwd: resolvedRoot, nodir: true, dot: false });
    const files: FsReadGlobResult[] = [];
    const skipped: string[] = [];

    for (const match of matches.sort()) {
        if (depth != null && match.split("/").length > depth) continue;
        const abs = nodePath.join(resolvedRoot, match);
        if (isBinaryFile(abs)) {
            skipped.push(match);
            continue;
        }
        const content = nodeFs.readFileSync(abs, "utf8");
        files.push({ file: match, content, totalLines: content.split("\n").length });
    }

    return { files, skipped };
}

export interface FsStatResult {
    file: string;
    size: number;
    sizeHuman: string;
    modifiedAt: string;
    isDirectory: boolean;
}

export function fsStat(root: string, relative: string): FsStatResult {
    const abs = safePath(root, relative);
    if (!nodeFs.existsSync(abs)) throw new Error(`Path not found: "${relative}"`);
    const stat = nodeFs.statSync(abs);
    const size = stat.size;
    const sizeHuman = size < 1024 ? `${size}B`
        : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)}KB`
            : `${(size / 1024 / 1024).toFixed(1)}MB`;
    return {
        file: relative,
        size,
        sizeHuman,
        modifiedAt: stat.mtime.toISOString(),
        isDirectory: stat.isDirectory(),
    };
}

export interface FsListEntry {
    path: string;
    size: number;
    sizeHuman: string;
    modifiedAt: string;
}

export async function fsList(
    root: string,
    pattern: string = "**/*",
    depth?: number,
): Promise<FsListEntry[]> {
    const resolvedRoot = nodePath.resolve(root);
    const matches = await glob(pattern, {
        cwd: resolvedRoot,
        nodir: true,
        dot: false,
    });
    const entries: FsListEntry[] = [];
    for (const match of matches.sort()) {
        // depth filter: count path separators; a file at the root has depth 1
        if (depth != null && match.split("/").length > depth) continue;
        const abs = nodePath.join(resolvedRoot, match);
        const stat = nodeFs.statSync(abs);
        const size = stat.size;
        const sizeHuman = size < 1024 ? `${size}B`
            : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)}KB`
                : `${(size / 1024 / 1024).toFixed(1)}MB`;
        entries.push({ path: match, size, sizeHuman, modifiedAt: stat.mtime.toISOString() });
    }
    return entries;
}

export interface FsSearchMatch {
    file: string;
    line: number;
    match: string;
    contextBefore: string[];
    contextAfter: string[];
}

export async function fsSearch(
    root: string,
    pattern: string,
    globPattern: string = "**/*",
    contextLines: number = 3,
): Promise<FsSearchMatch[]> {
    const resolvedRoot = nodePath.resolve(root);
    const regex = new RegExp(pattern);
    const files = await glob(globPattern, { cwd: resolvedRoot, nodir: true, dot: false });
    const results: FsSearchMatch[] = [];

    for (const file of files.sort()) {
        const abs = nodePath.join(resolvedRoot, file);
        if (isBinaryFile(abs)) continue; // silently skip binaries in search
        const content = nodeFs.readFileSync(abs, "utf8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
                results.push({
                    file,
                    line: i + 1,
                    match: lines[i],
                    contextBefore: lines.slice(Math.max(0, i - contextLines), i),
                    contextAfter: lines.slice(i + 1, Math.min(lines.length, i + 1 + contextLines)),
                });
            }
        }
    }
    return results;
}

// ─── Write operations ─────────────────────────────────────────────────────────

export interface FsWriteOptions {
    file: string;
    content: string;
    lines?: { start: number; end: number };
    expect?: string;
    dryRun?: boolean;
}

export interface FsWriteResult {
    file: string;
    action: "created" | "overwritten" | "patched";
    operationId?: string;
    expectResult?: { matched: boolean; expected: string; found?: string };
    dryRun?: boolean;
    diff?: string;
}

export function fsWrite(root: string, targetId: string, opts: FsWriteOptions): FsWriteResult {
    const abs = safePath(root, opts.file);
    const exists = nodeFs.existsSync(abs);

    // Validate --expect before anything else
    let expectResult: FsWriteResult["expectResult"];
    if (opts.expect && opts.lines) {
        if (!exists) throw new Error(`Cannot use --expect on a non-existent file: "${opts.file}"`);
        assertTextFile(abs);
        const allLines = nodeFs.readFileSync(abs, "utf8").split("\n");
        const lineContent = allLines[opts.lines.start - 1] ?? "";
        const matched = lineContent.includes(opts.expect);
        expectResult = { matched, expected: opts.expect, found: matched ? undefined : lineContent };
        if (!matched) {
            return {
                file: opts.file,
                action: "patched",
                expectResult,
            };
        }
    }

    let originalContent: string | undefined;
    let newContent: string;
    let action: FsWriteResult["action"];

    if (!exists) {
        action = "created";
        newContent = opts.content;
    } else {
        assertTextFile(abs);
        originalContent = nodeFs.readFileSync(abs, "utf8");

        if (opts.lines) {
            // Patch mode — replace the specified line range
            const allLines = originalContent.split("\n");
            const start = opts.lines.start - 1; // 0-indexed
            const end = opts.lines.end;          // exclusive
            const newLines = opts.content.split("\n");
            allLines.splice(start, end - start, ...newLines);
            newContent = allLines.join("\n");
            action = "patched";
        } else {
            // Full overwrite
            newContent = opts.content;
            action = "overwritten";
        }
    }

    const diff = buildDiff(opts.file, originalContent ?? "", newContent, action);

    if (opts.dryRun) {
        return { file: opts.file, action, dryRun: true, diff, expectResult };
    }

    // Snapshot before write
    const snapshotFiles = originalContent !== undefined
        ? [{ path: opts.file, originalContent }]
        : [];
    const snapshot: Snapshot | undefined = snapshotFiles.length > 0
        ? saveSnapshot({ targetId, command: "write", files: snapshotFiles })
        : undefined;

    // Ensure parent directory exists
    nodeFs.mkdirSync(nodePath.dirname(abs), { recursive: true });
    nodeFs.writeFileSync(abs, newContent, "utf8");

    return { file: opts.file, action, operationId: snapshot?.operationId, diff, expectResult };
}

export interface FsReplaceOptions {
    pattern: string;
    replacement: string;
    /** Treat --pattern as an exact literal string instead of a regex. */
    literal?: boolean;
    /**
     * Require exactly one match across the whole operation.
     * Errors if 0 or more than 1 occurrence is found.
     * Intended for single-file, single-site edits where ambiguity is a bug.
     */
    once?: boolean;
    /** Target a single file instead of a glob. Mutually exclusive with globPattern. */
    file?: string;
    globPattern?: string;
    dryRun?: boolean;
}

export interface FsReplaceFileDiff {
    file: string;
    matchCount: number;
    diff: string;
}

export interface FsReplaceResult {
    filesAffected: number;
    totalMatches: number;
    operationId?: string;
    dryRun?: boolean;
    diffs: FsReplaceFileDiff[];
}

export async function fsReplace(
    root: string,
    targetId: string,
    opts: FsReplaceOptions,
): Promise<FsReplaceResult> {
    if (opts.file && opts.globPattern) {
        throw new Error("--file and --glob are mutually exclusive. Use one or the other.");
    }

    const resolvedRoot = nodePath.resolve(root);

    // Build the search regex
    const patternSource = opts.literal
        ? opts.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        : opts.pattern;
    const flags = opts.once ? "g" : "g"; // always global so we can count occurrences
    const regex = new RegExp(patternSource, flags);

    // Resolve the file list
    let files: string[];
    if (opts.file) {
        safePath(root, opts.file); // path safety check
        if (!nodeFs.existsSync(nodePath.join(resolvedRoot, opts.file))) {
            throw new Error(`File not found: "${opts.file}"`);
        }
        files = [opts.file];
    } else {
        files = await glob(opts.globPattern ?? "**/*", { cwd: resolvedRoot, nodir: true, dot: false });
        files.sort();
    }

    const diffs: FsReplaceFileDiff[] = [];
    const toWrite: { abs: string; relative: string; original: string; updated: string }[] = [];

    for (const file of files) {
        const abs = nodePath.join(resolvedRoot, file);
        if (isBinaryFile(abs)) {
            throw new Error(`Binary file encountered during replace: "${file}". Only text files are supported.`);
        }
        const original = nodeFs.readFileSync(abs, "utf8");
        let matchCount = 0;
        const updated = original.replace(regex, (m, ...args) => {
            matchCount++;
            // Support $1, $2 capture group references in replacement
            return opts.literal
                ? opts.replacement
                : m.replace(new RegExp(patternSource), opts.replacement);
        });
        if (matchCount > 0) {
            diffs.push({ file, matchCount, diff: buildDiff(file, original, updated, "overwritten") });
            toWrite.push({ abs, relative: file, original, updated });
        }
    }

    // --once: require exactly one total match across all files
    if (opts.once) {
        const total = diffs.reduce((s, d) => s + d.matchCount, 0);
        if (total === 0) {
            throw new Error(`--once specified but pattern "${opts.pattern}" was not found.`);
        }
        if (total > 1) {
            const locations = diffs.map((d) => `  ${d.file}: ${d.matchCount} occurrence(s)`).join("\n");
            throw new Error(
                `--once specified but pattern "${opts.pattern}" matched ${total} times:\n${locations}\n` +
                `Use a more specific pattern or omit --once for bulk replacement.`,
            );
        }
    }

    if (opts.dryRun || toWrite.length === 0) {
        return {
            filesAffected: toWrite.length,
            totalMatches: diffs.reduce((s, d) => s + d.matchCount, 0),
            dryRun: true,
            diffs,
        };
    }

    const snapshot = saveSnapshot({
        targetId,
        command: "replace",
        files: toWrite.map((f) => ({ path: f.relative, originalContent: f.original })),
    });

    for (const f of toWrite) {
        nodeFs.writeFileSync(f.abs, f.updated, "utf8");
    }

    return {
        filesAffected: toWrite.length,
        totalMatches: diffs.reduce((s, d) => s + d.matchCount, 0),
        operationId: snapshot.operationId,
        diffs,
    };
}

export interface FsMoveOptions {
    from: string;
    to: string;
    dryRun?: boolean;
}

export interface FsMoveResult {
    from: string;
    to: string;
    operationId?: string;
    dryRun?: boolean;
}

export function fsMove(root: string, targetId: string, opts: FsMoveOptions): FsMoveResult {
    const absFrom = safePath(root, opts.from);
    const absTo = safePath(root, opts.to);

    if (!nodeFs.existsSync(absFrom)) throw new Error(`Source not found: "${opts.from}"`);
    if (nodeFs.existsSync(absTo)) throw new Error(`Destination already exists: "${opts.to}"`);

    // Only check binary for files (not directories)
    const stat = nodeFs.statSync(absFrom);
    if (!stat.isDirectory()) assertTextFile(absFrom);

    if (opts.dryRun) return { from: opts.from, to: opts.to, dryRun: true };

    // Snapshot — store content of all files under source
    const snapshotFiles = collectFiles(absFrom, opts.from);
    const snapshot = saveSnapshot({ targetId, command: "move", files: snapshotFiles });

    nodeFs.mkdirSync(nodePath.dirname(absTo), { recursive: true });
    nodeFs.renameSync(absFrom, absTo);

    return { from: opts.from, to: opts.to, operationId: snapshot.operationId };
}

export interface FsDeleteResult {
    file: string;
    operationId?: string;
    dryRun?: boolean;
}

export function fsDelete(root: string, targetId: string, relative: string, dryRun = false): FsDeleteResult {
    const abs = safePath(root, relative);
    if (!nodeFs.existsSync(abs)) throw new Error(`Path not found: "${relative}"`);

    const stat = nodeFs.statSync(abs);
    if (!stat.isDirectory()) assertTextFile(abs);

    if (dryRun) return { file: relative, dryRun: true };

    const snapshotFiles = collectFiles(abs, relative);
    const snapshot = saveSnapshot({ targetId, command: "delete", files: snapshotFiles });

    nodeFs.rmSync(abs, { recursive: true });

    return { file: relative, operationId: snapshot.operationId };
}

// ─── Rollback ─────────────────────────────────────────────────────────────────

export function fsRollback(root: string, snapshot: import("./snapshot-store.js").Snapshot): { restored: string[] } {
    const restored: string[] = [];
    for (const file of snapshot.files) {
        const abs = safePath(root, file.path);
        nodeFs.mkdirSync(nodePath.dirname(abs), { recursive: true });
        nodeFs.writeFileSync(abs, file.originalContent, "utf8");
        restored.push(file.path);
    }
    return { restored };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function collectFiles(abs: string, relative: string): import("./snapshot-store.js").SnapshotFile[] {
    const stat = nodeFs.statSync(abs);
    if (!stat.isDirectory()) {
        return [{ path: relative, originalContent: nodeFs.readFileSync(abs, "utf8") }];
    }
    const entries: import("./snapshot-store.js").SnapshotFile[] = [];
    for (const child of nodeFs.readdirSync(abs)) {
        entries.push(...collectFiles(
            nodePath.join(abs, child),
            nodePath.join(relative, child),
        ));
    }
    return entries;
}

function buildDiff(file: string, original: string, updated: string, action: string): string {
    if (action === "created") return `+++ ${file} (new file)\n${updated.split("\n").map((l) => `+ ${l}`).join("\n")}`;
    const oldLines = original.split("\n");
    const newLines = updated.split("\n");
    const lines: string[] = [`--- ${file}`, `+++ ${file}`];
    const maxLen = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < maxLen; i++) {
        const o = oldLines[i];
        const n = newLines[i];
        if (o !== n) {
            if (o !== undefined) lines.push(`- ${o}`);
            if (n !== undefined) lines.push(`+ ${n}`);
        }
    }
    return lines.join("\n");
}
