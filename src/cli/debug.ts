/**
 * Global debug flag. Enabled by --debug on any command.
 * Writes to stderr so it never pollutes stdout pipes.
 */

let debugMode = false;

export function setDebugMode(value: boolean): void {
    debugMode = value;
}

export function isDebugMode(): boolean {
    return debugMode;
}

export function debugLog(label: string, data?: unknown): void {
    if (!debugMode) return;
    const prefix = `\x1b[2m[debug] ${label}\x1b[0m`;
    if (data !== undefined) {
        const formatted = typeof data === "string" ? data : JSON.stringify(data, null, 2);
        process.stderr.write(`${prefix}: ${formatted}\n`);
    } else {
        process.stderr.write(`${prefix}\n`);
    }
}
