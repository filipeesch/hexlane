/**
 * Output helpers: respects --json / --toon flags for all commands.
 */
import { encode } from "@toon-format/toon";

let jsonMode = false;
let toonMode = false;

export function setJsonMode(value: boolean): void {
    jsonMode = value;
}

export function setToonMode(value: boolean): void {
    toonMode = value;
}

export function isJsonMode(): boolean {
    return jsonMode;
}

export function isToonMode(): boolean {
    return toonMode;
}

export function output(data: unknown): void {
    if (jsonMode) {
        process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    } else if (toonMode) {
        process.stdout.write(encode(data) + "\n");
    } else {
        if (typeof data === "string") {
            console.log(data);
        } else {
            console.log(JSON.stringify(data, null, 2));
        }
    }
}

export function outputTable(
    rows: Record<string, unknown>[],
    columns: string[]
): void {
    if (jsonMode || toonMode || rows.length === 0) {
        output(rows);
        return;
    }
    // Simple column-aligned table
    const widths = columns.map((col) =>
        Math.max(col.length, ...rows.map((r) => String(r[col] ?? "").length))
    );
    const header = columns.map((c, i) => c.padEnd(widths[i]!)).join("  ");
    const divider = widths.map((w) => "-".repeat(w)).join("  ");
    console.log(header);
    console.log(divider);
    for (const row of rows) {
        console.log(columns.map((c, i) => String(row[c] ?? "").padEnd(widths[i]!)).join("  "));
    }
}

export function die(message: string, exitCode = 1): never {
    if (jsonMode) {
        process.stderr.write(JSON.stringify({ error: message }) + "\n");
    } else if (toonMode) {
        process.stderr.write(encode({ error: message }) + "\n");
    } else {
        console.error(`Error: ${message}`);
    }
    process.exit(exitCode);
}
