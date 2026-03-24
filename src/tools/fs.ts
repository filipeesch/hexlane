import type { Command } from "commander";
import * as nodeFs from "fs";
import { toolRegistry } from "./registry.js";
import { getContext } from "../cli/context.js";
import { output, die, setJsonMode, setMachineMode } from "../cli/output.js";
import {
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
} from "./fs/executor.js";
import {
    loadSnapshot,
    listSnapshots,
    deleteSnapshot,
    pruneSnapshots,
} from "./fs/snapshot-store.js";

toolRegistry.register({
    toolName: "fs",
    registerCommands(program: Command): void {
        const fs = program
            .command("fs")
            .description("File system operations on registered targets (read, write, search, rollback)");

        // ── fs list ───────────────────────────────────────────────────────────
        fs
            .command("list <target-id>")
            .description("List files under the target root")
            .option("--glob <pattern>", "Glob pattern to filter files (default: **/*)")
            .option("--depth <n>", "Limit depth (e.g. 2 shows two levels deep)", parseInt)
            .option("--json", "Output as JSON")
            .option("--machine", "Output as TOON")
            .action(async (targetId: string, opts: { glob?: string; depth?: number; json?: boolean; machine?: boolean }) => {
                if (opts.json) setJsonMode(true);
                if (opts.machine) setMachineMode(true);
                const { root } = resolveTarget(targetId);
                const entries = await fsList(root, opts.glob, opts.depth);
                output(entries.map((e) => ({
                    path: e.path,
                    size: e.sizeHuman,
                    modified: e.modifiedAt,
                })));
            });

        // ── fs read ───────────────────────────────────────────────────────────
        fs
            .command("read <target-id>")
            .description(
                "Read a file (or line range) within the target root. " +
                "Pass --glob to read multiple files at once (returns an array).",
            )
            .option("--file <path>", "Single file path relative to target root")
            .option("--lines <range>", "Line range for single-file mode, e.g. 10-50")
            .option("--glob <pattern>", "Read all matching files at once (e.g. src/**/*.ts)")
            .option("--depth <n>", "Limit depth when using --glob", parseInt)
            .option("--json", "Output as JSON")
            .option("--machine", "Output as TOON")
            .action(async (targetId: string, opts: {
                file?: string;
                lines?: string;
                glob?: string;
                depth?: number;
                json?: boolean;
                machine?: boolean;
            }) => {
                if (opts.json) setJsonMode(true);
                if (opts.machine) setMachineMode(true);
                const { root } = resolveTarget(targetId);
                if (opts.glob && opts.file) die("--file and --glob are mutually exclusive.");
                try {
                    if (opts.glob) {
                        const result = await fsReadGlob(root, opts.glob, opts.depth);
                        output(result);
                    } else {
                        if (!opts.file) die("Provide --file <path> or --glob <pattern>.");
                        const lines = parseLineRange(opts.lines);
                        output(fsRead(root, opts.file!, lines));
                    }
                } catch (err) {
                    die(String((err as Error).message));
                }
            });

        // ── fs stat ───────────────────────────────────────────────────────────
        fs
            .command("stat <target-id>")
            .description("Show metadata for a file within the target root")
            .requiredOption("--file <path>", "File path relative to target root")
            .option("--json", "Output as JSON")
            .option("--machine", "Output as TOON")
            .action((targetId: string, opts: { file: string; json?: boolean; machine?: boolean }) => {
                if (opts.json) setJsonMode(true);
                if (opts.machine) setMachineMode(true);
                const { root } = resolveTarget(targetId);
                try {
                    output(fsStat(root, opts.file));
                } catch (err) {
                    die(String((err as Error).message));
                }
            });

        // ── fs search ─────────────────────────────────────────────────────────
        fs
            .command("search <target-id>")
            .description("Search file contents using a regex pattern")
            .requiredOption("--pattern <regex>", "Regex pattern to search for")
            .option("--glob <pattern>", "Glob filter (default: **/*)")
            .option("--context <n>", "Lines of context around each match (default: 3)", parseInt)
            .option("--json", "Output as JSON")
            .option("--machine", "Output as TOON")
            .action(async (targetId: string, opts: {
                pattern: string;
                glob?: string;
                context?: number;
                json?: boolean;
                machine?: boolean;
            }) => {
                if (opts.json) setJsonMode(true);
                if (opts.machine) setMachineMode(true);
                const { root } = resolveTarget(targetId);
                try {
                    const results = await fsSearch(root, opts.pattern, opts.glob, opts.context);
                    output(results);
                } catch (err) {
                    die(String((err as Error).message));
                }
            });

        // ── fs write ──────────────────────────────────────────────────────────
        fs
            .command("write <target-id>")
            .description("Create, overwrite, or patch a file within the target root. Always snapshots before writing.")
            .requiredOption("--file <path>", "File path relative to target root")
            .option("--content <string>", "Content to write")
            .option("--content-file <path>", "Read content from a file")
            .option("--lines <range>", "Patch mode: replace only the specified line range (e.g. 45-52)")
            .option(
                "--expect <string>",
                "Guard: patch is applied only if the start line contains this string. " +
                "Returns success/fail result so the caller can verify before retrying. " +
                "Use this to prevent patching stale line numbers.",
            )
            .option("--dry-run", "Preview what would change without modifying any files")
            .option("--json", "Output as JSON")
            .option("--machine", "Output as TOON")
            .action((targetId: string, opts: {
                file: string;
                content?: string;
                contentFile?: string;
                lines?: string;
                expect?: string;
                dryRun?: boolean;
                json?: boolean;
                machine?: boolean;
            }) => {
                if (opts.json) setJsonMode(true);
                if (opts.machine) setMachineMode(true);
                const { root } = resolveTarget(targetId, { requireWritable: true });

                let content: string;
                if (opts.contentFile) {
                    if (!nodeFs.existsSync(opts.contentFile)) die(`Content file not found: ${opts.contentFile}`);
                    content = nodeFs.readFileSync(opts.contentFile, "utf8");
                } else if (opts.content !== undefined) {
                    content = opts.content;
                } else {
                    die("Provide --content or --content-file");
                    return;
                }

                const lines = parseLineRange(opts.lines);
                try {
                    const result = fsWrite(root, targetId, {
                        file: opts.file,
                        content,
                        lines,
                        expect: opts.expect,
                        dryRun: opts.dryRun,
                    });
                    output(result);
                } catch (err) {
                    die(String((err as Error).message));
                }
            });

        // ── fs replace ────────────────────────────────────────────────────────
        fs
            .command("replace <target-id>")
            .description(
                "Find-and-replace within the target root. " +
                "Defaults to regex across all files. " +
                "Use --file + --literal + --once for safe single-site edits. " +
                "Snapshots all affected files.",
            )
            .requiredOption("--pattern <string>", "Pattern to find (regex by default; use --literal for exact string)")
            .option("--replacement <string>", "Replacement string (supports $1, $2 for regex capture groups)")
            .option("--replacement-file <path>", "Read replacement from a file (for multi-line replacements)")
            .option("--pattern-file <path>", "Read pattern from a file (for multi-line patterns)")
            .option("--file <path>", "Target a single file instead of --glob")
            .option("--glob <pattern>", "Glob filter (default: **/*). Mutually exclusive with --file")
            .option("--literal", "Treat --pattern as an exact string, not a regex")
            .option(
                "--once",
                "Require exactly one match — errors if 0 or >1 occurrences found. " +
                "Intended for targeted single-site edits where ambiguity is a bug.",
            )
            .option("--dry-run", "Preview matches and diffs without modifying any files")
            .option("--json", "Output as JSON")
            .option("--machine", "Output as TOON")
            .action(async (targetId: string, opts: {
                pattern: string;
                replacement?: string;
                replacementFile?: string;
                patternFile?: string;
                file?: string;
                glob?: string;
                literal?: boolean;
                once?: boolean;
                dryRun?: boolean;
                json?: boolean;
                machine?: boolean;
            }) => {
                if (opts.json) setJsonMode(true);
                if (opts.machine) setMachineMode(true);
                const { root } = resolveTarget(targetId, { requireWritable: true });

                const pattern = opts.patternFile
                    ? (() => {
                        if (!nodeFs.existsSync(opts.patternFile!)) die(`Pattern file not found: ${opts.patternFile}`);
                        return nodeFs.readFileSync(opts.patternFile!, "utf8").trimEnd();
                    })()
                    : opts.pattern;

                let replacement: string;
                if (opts.replacementFile) {
                    if (!nodeFs.existsSync(opts.replacementFile)) die(`Replacement file not found: ${opts.replacementFile}`);
                    replacement = nodeFs.readFileSync(opts.replacementFile, "utf8").trimEnd();
                } else if (opts.replacement !== undefined) {
                    replacement = opts.replacement;
                } else {
                    die("Provide --replacement <string> or --replacement-file <path>.");
                    return;
                }

                try {
                    const result = await fsReplace(root, targetId, {
                        pattern,
                        replacement,
                        file: opts.file,
                        globPattern: opts.glob,
                        literal: opts.literal,
                        once: opts.once,
                        dryRun: opts.dryRun,
                    });
                    output(result);
                } catch (err) {
                    die(String((err as Error).message));
                }
            });

        // ── fs move ───────────────────────────────────────────────────────────
        fs
            .command("move <target-id>")
            .description("Move or rename a file within the target root. Snapshots original content.")
            .requiredOption("--from <path>", "Source path relative to target root")
            .requiredOption("--to <path>", "Destination path relative to target root")
            .option("--dry-run", "Preview the move without modifying any files")
            .option("--json", "Output as JSON")
            .option("--machine", "Output as TOON")
            .action((targetId: string, opts: {
                from: string;
                to: string;
                dryRun?: boolean;
                json?: boolean;
                machine?: boolean;
            }) => {
                if (opts.json) setJsonMode(true);
                if (opts.machine) setMachineMode(true);
                const { root } = resolveTarget(targetId, { requireWritable: true });
                try {
                    output(fsMove(root, targetId, { from: opts.from, to: opts.to, dryRun: opts.dryRun }));
                } catch (err) {
                    die(String((err as Error).message));
                }
            });

        // ── fs delete ─────────────────────────────────────────────────────────
        fs
            .command("delete <target-id>")
            .description("Delete a file within the target root. Snapshots content before deleting.")
            .requiredOption("--file <path>", "File path relative to target root")
            .option("--dry-run", "Preview what would be deleted without modifying any files")
            .option("--json", "Output as JSON")
            .option("--machine", "Output as TOON")
            .action((targetId: string, opts: { file: string; dryRun?: boolean; json?: boolean; machine?: boolean }) => {
                if (opts.json) setJsonMode(true);
                if (opts.machine) setMachineMode(true);
                const { root } = resolveTarget(targetId, { requireWritable: true });
                try {
                    output(fsDelete(root, targetId, opts.file, opts.dryRun));
                } catch (err) {
                    die(String((err as Error).message));
                }
            });

        // ── fs rollback ───────────────────────────────────────────────────────
        const rollback = fs
            .command("rollback")
            .description("Manage and restore file operation snapshots");

        rollback
            .command("restore <target-id>")
            .description("Restore files to their state before a write operation")
            .requiredOption("--operation-id <id>", "The operation ID returned by write, replace, move, or delete")
            .option("--json", "Output as JSON")
            .option("--machine", "Output as TOON")
            .action((targetId: string, opts: { operationId: string; json?: boolean; machine?: boolean }) => {
                if (opts.json) setJsonMode(true);
                if (opts.machine) setMachineMode(true);
                const { root } = resolveTarget(targetId);
                try {
                    const snap = loadSnapshot(opts.operationId);
                    if (snap.targetId !== targetId) {
                        die(`Snapshot "${opts.operationId}" belongs to target "${snap.targetId}", not "${targetId}".`);
                    }
                    const result = fsRollback(root, snap);
                    deleteSnapshot(opts.operationId);
                    output({ operationId: opts.operationId, restored: result.restored });
                } catch (err) {
                    die(String((err as Error).message));
                }
            });

        rollback
            .command("list [target-id]")
            .description("List available rollback snapshots, optionally filtered by target")
            .option("--json", "Output as JSON")
            .option("--machine", "Output as TOON")
            .action((targetId: string | undefined, opts: { json?: boolean; machine?: boolean }) => {
                if (opts.json) setJsonMode(true);
                if (opts.machine) setMachineMode(true);
                const snapshots = listSnapshots(targetId);
                output(snapshots.map((s) => ({
                    operationId: s.operationId,
                    targetId: s.targetId,
                    command: s.command,
                    timestamp: s.timestamp,
                    files: s.files.map((f) => f.path),
                })));
            });

        rollback
            .command("prune")
            .description("Delete snapshots older than a specified duration (default: 7 days)")
            .option("--older-than <duration>", "Duration string, e.g. 7d, 30d, 1d (default: 7d)", "7d")
            .option("--json", "Output as JSON")
            .option("--machine", "Output as TOON")
            .action((opts: { olderThan: string; json?: boolean; machine?: boolean }) => {
                if (opts.json) setJsonMode(true);
                if (opts.machine) setMachineMode(true);
                const days = parseDays(opts.olderThan);
                const result = pruneSnapshots(days);
                output({ pruned: result.pruned, total: result.total, olderThanDays: days });
            });
    },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveTarget(targetId: string, opts?: { requireWritable?: boolean }): { root: string } {
    const ctx = getContext();
    const found = ctx.integrations.findByTargetId(targetId);
    if (!found) die(`Target "${targetId}" not found in any registered integration.`);
    const { target } = found!;
    const fsTool = target.tools.find((t) => t.type === "fs");
    if (!fsTool) die(`Target "${targetId}" has no fs tool configured.`);
    const cfg = validateFsConfig(fsTool.config);
    if (opts?.requireWritable && cfg.readonly) {
        die(`Target "${targetId}" is read-only (config.readonly = true).`);
    }
    return { root: cfg.root };
}

function parseLineRange(range?: string): { start: number; end: number } | undefined {
    if (!range) return undefined;
    const match = /^(\d+)-(\d+)$/.exec(range);
    if (!match) die(`Invalid --lines format "${range}": expected start-end, e.g. 10-50`);
    return { start: parseInt(match![1]), end: parseInt(match![2]) };
}

function parseDays(duration: string): number {
    const match = /^(\d+)d$/.exec(duration.trim());
    if (!match) die(`Invalid --older-than format "${duration}": expected e.g. 7d`);
    return parseInt(match![1]);
}
