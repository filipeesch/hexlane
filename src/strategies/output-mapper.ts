import type {
    OutputMapping,
    ApiTokenMapping,
    DbConnectionMapping,
} from "../config/schema.js";
import type { VaultSecret } from "../vault/types.js";

/**
 * Resolves a dot-notation path (e.g. "result.token") from an object.
 * Supports array indexing via first-element unwrap (see unwrap_array flag).
 */
function resolvePath(obj: unknown, dotPath: string): unknown {
    const parts = dotPath.split(".");
    let current: unknown = obj;
    for (const part of parts) {
        if (current === null || current === undefined || typeof current !== "object") {
            return undefined;
        }
        current = (current as Record<string, unknown>)[part];
    }
    return current;
}

function asString(val: unknown, fieldName: string): string {
    if (val === null || val === undefined) {
        throw new Error(`Mapping error: field "${fieldName}" is missing from strategy output`);
    }
    return String(val);
}

function asInt(val: unknown, fieldName: string): number {
    if (val === null || val === undefined) {
        throw new Error(`Mapping error: field "${fieldName}" is missing from strategy output`);
    }
    const n = Number(val);
    if (!Number.isFinite(n)) {
        throw new Error(`Mapping error: field "${fieldName}" is not a number (got: ${String(val)})`);
    }
    return Math.round(n);
}

/**
 * Normalizes an expiry value to a Date.
 *  - ISO 8601 string → parsed directly
 *  - Unix epoch seconds (large int) → converted
 *  - Unix epoch ms (very large int) → converted
 *  - Seconds-from-now (small int, < 1e9) → acquired_at + N seconds
 *  - Go duration strings ("2d", "1h30m") → NOT supported; returns null
 */
export function normalizeExpiry(
    val: unknown,
    acquiredAt: Date
): Date | null {
    if (val === null || val === undefined || val === "") return null;
    if (typeof val === "string") {
        // ISO 8601
        if (/^\d{4}-/.test(val)) {
            const d = new Date(val);
            return isNaN(d.getTime()) ? null : d;
        }
        // Pure numeric string
        const n = Number(val);
        if (Number.isFinite(n)) return secondsOrEpoch(n, acquiredAt);
        // Go duration strings and other formats → not supported
        return null;
    }
    if (typeof val === "number") return secondsOrEpoch(val, acquiredAt);
    return null;
}

function secondsOrEpoch(n: number, acquiredAt: Date): Date {
    // Unix epoch ms: > year 2001 in ms (978307200000)
    if (n > 1e12) return new Date(n);
    // Unix epoch seconds: > year 2001 in seconds (978307200)
    if (n > 1e9) return new Date(n * 1000);
    // Seconds from now
    return new Date(acquiredAt.getTime() + n * 1000);
}

/**
 * Decodes the JWT payload (no verification — claims are not encrypted) and
 * returns the `exp` claim as a Date, or null if not present or not a valid JWT.
 */
export function tryDecodeJwtExp(token: string): Date | null {
    try {
        const parts = token.split(".");
        if (parts.length !== 3) return null;
        // Base64url → base64 → Buffer
        const base64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
        const json = Buffer.from(base64, "base64").toString("utf8");
        const payload = JSON.parse(json) as Record<string, unknown>;
        const exp = payload["exp"];
        if (typeof exp === "number" && exp > 0) {
            return new Date(exp * 1000);
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Maps raw strategy output (parsed JSON) to a VaultSecret.
 * This is the only place where secret field values are touched.
 * No secret values are ever passed to logging or error messages.
 */
export function mapOutput(
    rawOutput: unknown,
    mapping: OutputMapping,
    acquiredAt: Date
): { secret: VaultSecret; expires_at: Date | null; trace_id?: string } {
    // Unwrap single-element array if requested
    let data: unknown = rawOutput;
    if (
        mapping.kind === "db_connection" &&
        (mapping as DbConnectionMapping).unwrap_array
    ) {
        if (!Array.isArray(data) || data.length === 0) {
            throw new Error("Mapping error: expected array output but got non-array or empty array");
        }
        data = data[0];
    }

    if (mapping.kind === "api_token") {
        return mapApiToken(data, mapping as ApiTokenMapping, acquiredAt);
    } else {
        return mapDbConnection(data, mapping as DbConnectionMapping, acquiredAt);
    }
}

function mapApiToken(
    data: unknown,
    mapping: ApiTokenMapping,
    acquiredAt: Date
): { secret: VaultSecret; expires_at: Date | null; trace_id?: string } {
    // Check application-level error field before extracting credentials
    if (mapping.error_path) {
        const errVal = resolvePath(data, mapping.error_path);
        if (errVal !== null && errVal !== undefined && errVal !== "") {
            throw new Error(`Strategy returned application error: ${String(errVal)}`);
        }
    }

    const token = asString(resolvePath(data, mapping.token_path), mapping.token_path);
    const expiryRaw = mapping.expires_at_path
        ? resolvePath(data, mapping.expires_at_path)
        : null;
    // If no explicit expiry path configured, try decoding the JWT exp claim
    const expires_at = normalizeExpiry(expiryRaw, acquiredAt) ?? tryDecodeJwtExp(token);

    const trace_id = mapping.trace_id_path
        ? String(resolvePath(data, mapping.trace_id_path) ?? "")
        : undefined;

    const leaseId = mapping.trace_id_path
        ? String(resolvePath(data, mapping.trace_id_path) ?? "")
        : undefined;

    return {
        secret: {
            kind: "api_token",
            token,
            vault_lease_id: leaseId,
        },
        expires_at,
        trace_id,
    };
}

function mapDbConnection(
    data: unknown,
    mapping: DbConnectionMapping,
    acquiredAt: Date
): { secret: VaultSecret; expires_at: Date | null; trace_id?: string } {
    // Check application-level error field
    if (mapping.error_path) {
        const errVal = resolvePath(data, mapping.error_path);
        if (errVal !== null && errVal !== undefined && errVal !== "") {
            throw new Error(`Strategy returned application error: ${String(errVal)}`);
        }
    }

    // Handle raw single-value output (e.g. AWS RDS auth token is a plain token string)
    if (mapping.auth_token_value === "raw") {
        if (typeof data !== "string") {
            throw new Error("Mapping error: auth_token_value=raw expects strategy output to be a plain string");
        }
        const host = mapping.host;
        const port = mapping.port;
        const user = mapping.user;
        const dbname = mapping.dbname;
        if (!host || !port || !user || !dbname) {
            throw new Error(
                "Mapping error: auth_token_value=raw requires static host, port, user, dbname in output_mapping"
            );
        }
        return {
            secret: {
                kind: "db_connection",
                engine: "postgresql",
                host,
                port,
                user,
                password: data,
                dbname,
                ssl_mode: mapping.ssl_mode,
                vault_lease_id: undefined,
            },
            expires_at: null,
        };
    }

    // Dynamic field extraction
    const host = mapping.host_path
        ? asString(resolvePath(data, mapping.host_path), mapping.host_path)
        : mapping.host ?? (() => { throw new Error('Mapping error: host is required (use host_path or static host)'); })();

    const portRaw = mapping.port_path
        ? resolvePath(data, mapping.port_path)
        : mapping.port;
    const port = asInt(portRaw, "port");

    const user = mapping.user_path
        ? asString(resolvePath(data, mapping.user_path), mapping.user_path)
        : mapping.user ?? (() => { throw new Error('Mapping error: user is required (use user_path or static user)'); })();

    const password = asString(
        resolvePath(data, mapping.password_path!),
        mapping.password_path ?? "password"
    );

    const dbname = mapping.dbname_path
        ? asString(resolvePath(data, mapping.dbname_path), mapping.dbname_path)
        : mapping.dbname ?? (() => { throw new Error('Mapping error: dbname is required (use dbname_path or static dbname)'); })();

    const expiryRaw = mapping.expires_at_path
        ? resolvePath(data, mapping.expires_at_path)
        : null;
    const expires_at = normalizeExpiry(expiryRaw, acquiredAt);

    const vault_lease_id = mapping.lease_id_path
        ? String(resolvePath(data, mapping.lease_id_path) ?? "")
        : undefined;

    const trace_id = mapping.trace_id_path
        ? String(resolvePath(data, mapping.trace_id_path) ?? "")
        : undefined;

    return {
        secret: {
            kind: "db_connection",
            engine: "postgresql",
            host,
            port,
            user,
            password,
            dbname,
            ssl_mode: mapping.ssl_mode,
            vault_lease_id,
        },
        expires_at,
        trace_id,
    };
}
