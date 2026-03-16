import { Client } from "pg";
import type { VaultManager } from "../vault/vault-manager.js";
import type { CredentialRecord } from "../metadata/store.js";
import type { DbConnectionSecret } from "../vault/types.js";
import type { AuditLogger } from "../audit/logger.js";
import { debugLog } from "../cli/debug.js";

export interface DbQueryResult {
    rows: Record<string, unknown>[];
    row_count: number;
    fields: string[];
}

function resolveSsl(mode?: string): object | boolean | undefined {
    if (!mode || mode === "disable") return false;
    if (mode === "require") return { rejectUnauthorized: false };
    if (mode === "verify-full") return { rejectUnauthorized: true };
    return undefined;
}

/**
 * Sanitizes a pg error to remove any connection details that may have
 * been embedded by the driver (host, user, etc.) from the error message.
 */
function sanitizeDbError(err: unknown): Error {
    const original = err instanceof Error ? err.message : String(err);
    // Strip common pg connection detail patterns
    const safe = original
        .replace(/password=[^\s]*/gi, "password=[REDACTED]")
        .replace(/user=[^\s]*/gi, "user=[REDACTED]")
        .replace(/host=[^\s]*/gi, "host=[REDACTED]");
    return new Error(safe);
}

export async function executeDbQuery(
    vault: VaultManager,
    credential: CredentialRecord,
    audit: AuditLogger,
    sql: string,
    limit: number = 500,
    params: Record<string, string | number | boolean> = {},
): Promise<DbQueryResult> {
    const secret = vault.read(credential.vault_ref) as DbConnectionSecret;
    if (secret.kind !== "db_connection") {
        throw new Error(`Credential is not a DB connection (kind: ${secret.kind})`);
    }

    // Enforce a safety limit by wrapping in a subquery if no LIMIT present
    const normalizedSql = sql.trim();
    const hasLimit = /\blimit\b/i.test(normalizedSql);
    const limitedSql = hasLimit ? normalizedSql : `SELECT * FROM (${normalizedSql}) _q LIMIT ${limit}`;

    // Bind :name placeholders → $1, $2, ... using pg parameterized queries (injection-safe)
    const paramValues: (string | number | boolean)[] = [];
    const paramIndex: Record<string, number> = {};
    const safeSql = limitedSql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name: string) => {
        if (!(name in params)) {
            throw new Error(`SQL parameter ":${name}" has no value. Pass --param ${name}=<value>`);
        }
        if (!(name in paramIndex)) {
            paramValues.push(params[name]!);
            paramIndex[name] = paramValues.length; // 1-based
        }
        return `$${paramIndex[name]}`;
    });

    debugLog(`db connect`, `${secret.host}:${secret.port}/${secret.dbname} as ${secret.user}`);
    debugLog(`db query`, safeSql);
    if (paramValues.length > 0) debugLog(`db params`, paramValues.map((v, i) => `$${i + 1}=${v}`).join(', '));

    const client = new Client({
        host: secret.host,
        port: secret.port,
        user: secret.user,
        password: secret.password,
        database: secret.dbname,
        ssl: resolveSsl(secret.ssl_mode) as never,
        connectionTimeoutMillis: 10_000,
        query_timeout: 30_000,
    });

    let result: DbQueryResult;
    try {
        await client.connect();
        const pgResult = await client.query(safeSql, paramValues.length > 0 ? paramValues : undefined);
        const fields = pgResult.fields.map((f) => f.name);
        result = {
            rows: pgResult.rows as Record<string, unknown>[],
            row_count: pgResult.rowCount ?? pgResult.rows.length,
            fields,
        };
    } catch (err: unknown) {
        await client.end().catch(() => { });
        audit.log({
            event: "db_query_executed",
            app: credential.app,
            env: credential.env,
            profile: credential.profile,
            status: "error",
            credential_id: credential.id,
            db_engine: "postgresql",
            error_message: sanitizeDbError(err).message,
        });
        throw sanitizeDbError(err);
    }

    await client.end();

    audit.log({
        event: "db_query_executed",
        app: credential.app,
        env: credential.env,
        profile: credential.profile,
        status: "ok",
        credential_id: credential.id,
        db_engine: "postgresql",
        rows_returned: result.row_count,
    });

    return result;
}
