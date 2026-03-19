import { Client } from "pg";
import type { VaultManager } from "../../vault/vault-manager.js";
import type { CredentialRecord } from "../../metadata/store.js";
import type { DbConnectionSecret } from "../../vault/types.js";
import type { AuditLogger } from "../../audit/logger.js";
import { debugLog } from "../../cli/debug.js";

export interface SqlQueryOptions {
    sql: string;
    limit?: number;
    params?: Record<string, string | number | boolean>;
}

export interface SqlQueryResult {
    rows: Record<string, unknown>[];
    row_count: number;
    fields: string[];
}

const SUPPORTED_ENGINES = ["postgresql", "mysql", "sqlserver", "oracle"] as const;
type SqlEngine = (typeof SUPPORTED_ENGINES)[number];

function resolveSsl(mode?: string): object | boolean | undefined {
    if (!mode || mode === "disable") return false;
    if (mode === "require") return { rejectUnauthorized: false };
    if (mode === "verify-full") return { rejectUnauthorized: true };
    return undefined;
}

/**
 * Sanitizes a pg error to remove any connection details that may have
 * been embedded by the driver (host, user, password, etc.).
 */
function sanitizeDbError(err: unknown): Error {
    const original = err instanceof Error ? err.message : String(err);
    const safe = original
        .replace(/password=[^\s]*/gi, "password=[REDACTED]")
        .replace(/user=[^\s]*/gi, "user=[REDACTED]")
        .replace(/host=[^\s]*/gi, "host=[REDACTED]");
    return new Error(safe);
}

/**
 * Builds the final parameterised SQL to send to pg.
 *
 * Applies LIMIT injection (when no LIMIT clause is present) and converts
 * `:name` placeholders to `$n` positional params for pg's parameterised query.
 *
 * Exported for unit testing without requiring a database connection.
 */
export function buildSqlQuery(
    sql: string,
    limit: number,
    params: Record<string, string | number | boolean>,
): { safeSql: string; paramValues: (string | number | boolean)[] } {
    const normalizedSql = sql.trim();
    const hasLimit = /\blimit\b/i.test(normalizedSql);
    const limitedSql = hasLimit
        ? normalizedSql
        : `SELECT * FROM (${normalizedSql}) _q LIMIT ${limit}`;

    const paramValues: (string | number | boolean)[] = [];
    const paramIndex: Record<string, number> = {};
    const safeSql = limitedSql.replace(/(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name: string) => {
        if (!(name in params)) {
            throw new Error(`SQL parameter ":${name}" has no value. Pass --param ${name}=<value>`);
        }
        if (!(name in paramIndex)) {
            paramValues.push(params[name]!);
            paramIndex[name] = paramValues.length; // 1-based
        }
        return `$${paramIndex[name]}`;
    });

    return { safeSql, paramValues };
}

export async function executeSqlQuery(
    vault: VaultManager,
    credential: CredentialRecord,
    audit: AuditLogger,
    options: SqlQueryOptions,
): Promise<SqlQueryResult> {
    const secret = vault.read(credential.vault_ref) as DbConnectionSecret;
    if (secret.kind !== "db_connection") {
        throw new Error(`Credential is not a db_connection secret (kind: ${secret.kind})`);
    }

    const limit = options.limit ?? 500;
    const { safeSql, paramValues } = buildSqlQuery(options.sql, limit, options.params ?? {});

    debugLog(`sql connect`, `${secret.host}:${secret.port}/${secret.dbname} as ${secret.user}`);
    debugLog(`sql query`, safeSql);
    if (paramValues.length > 0) {
        debugLog(`sql params`, paramValues.map((v, i) => `$${i + 1}=${v}`).join(", "));
    }

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

    let result: SqlQueryResult;
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
        rows_returned: result.row_count,
    });

    return result;
}

/** Validates that a sql target config has the required engine and host fields. */
export function validateSqlConfig(config: Record<string, unknown>): void {
    if (!config["engine"] || typeof config["engine"] !== "string") {
        throw new Error("sql target config must have an engine string");
    }
    if (!(SUPPORTED_ENGINES as readonly string[]).includes(config["engine"])) {
        throw new Error(
            `sql target config engine must be one of: ${SUPPORTED_ENGINES.join(", ")}. Got: "${config["engine"]}"`,
        );
    }
    if (!config["host"] || typeof config["host"] !== "string") {
        throw new Error("sql target config must have a host string");
    }
}
