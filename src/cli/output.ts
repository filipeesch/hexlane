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
    } else if (typeof data === "string") {
        console.log(data);
    } else {
        process.stdout.write(encode(data) + "\n");
    }
}

export function outputTable(
    rows: Record<string, unknown>[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _columns: string[]
): void {
    output(rows);
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
