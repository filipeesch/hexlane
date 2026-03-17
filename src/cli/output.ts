/**
 * Output helpers: respects --json / --machine flags for all commands.
 *
 * Default output:
 *   - API responses  → pretty-printed JSON { status, body } (headers hidden unless --http-headers)
 *   - Table data     → text table (with column headers and separator)
 *   - Other objects  → pretty-printed JSON
 *
 * --machine  → TOON (structured, token-efficient; for AI/scripting consumption)
 * --json     → raw JSON (arrays, envelopes, etc.)
 */
import { encode } from "@toon-format/toon";

let jsonMode = false;
let machineMode = false;

export function setJsonMode(value: boolean): void {
    jsonMode = value;
}

export function setMachineMode(value: boolean): void {
    machineMode = value;
}

export function isJsonMode(): boolean {
    return jsonMode;
}

export function isMachineMode(): boolean {
    return machineMode;
}

/** General-purpose output. Default: pretty JSON. --machine: TOON. */
export function output(data: unknown): void {
    if (machineMode) {
        process.stdout.write(encode(data) + "\n");
    } else if (typeof data === "string") {
        console.log(data);
    } else {
        process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    }
}

/**
 * API response output.
 * Default and --json: pretty JSON { status, body }; headers included only when showHeaders is true.
 * --machine: TOON.
 */
export function outputApiResponse(
    result: { status: number; headers: Record<string, string>; body: unknown },
    showHeaders: boolean,
): void {
    const data: Record<string, unknown> = { status: result.status, body: result.body };
    if (showHeaders) data["headers"] = result.headers;
    if (machineMode) {
        process.stdout.write(encode(data) + "\n");
    } else {
        process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    }
}

/**
 * Table output.
 * Default: rendered text table with header row and separator.
 * --machine: TOON. --json: JSON array.
 */
export function outputTable(
    rows: Record<string, unknown>[],
    columns?: string[],
): void {
    if (machineMode) {
        process.stdout.write(encode(rows) + "\n");
        return;
    }
    if (jsonMode) {
        process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
        return;
    }
    if (rows.length === 0) {
        console.log("(no results)");
        return;
    }
    const cols = columns ?? Object.keys(rows[0]);
    const widths = cols.map((col) =>
        Math.max(col.length, ...rows.map((r) => String(r[col] ?? "").length)),
    );
    const pad = (s: string, w: number) => s.padEnd(w);
    console.log(cols.map((col, i) => pad(col.toUpperCase(), widths[i])).join("  "));
    console.log(widths.map((w) => "-".repeat(w)).join("  "));
    for (const row of rows) {
        console.log(cols.map((col, i) => pad(String(row[col] ?? ""), widths[i])).join("  "));
    }
}

export function die(message: string, exitCode = 1): never {
    if (jsonMode) {
        process.stderr.write(JSON.stringify({ error: message }) + "\n");
    } else if (machineMode) {
        process.stderr.write(encode({ error: message }) + "\n");
    } else {
        console.error(`Error: ${message}`);
    }
    process.exit(exitCode);
}
