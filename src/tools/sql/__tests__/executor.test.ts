/**
 * Tests for the SQL tool executor.
 *
 * `buildSqlQuery` is a pure function that builds the final parameterised SQL
 * without touching a database connection, so it can be tested exhaustively.
 * `validateSqlConfig` and the "wrong secret kind" guard are also pure / early-
 * exit paths that don't require a pg connection.
 *
 * Integration tests for the actual pg connection (result rows, audit logging)
 * are out-of-scope for unit tests and require a real database.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildSqlQuery, validateSqlConfig, executeSqlQuery } from "../executor.js";
import type { VaultManager } from "../../../vault/vault-manager.js";
import type { CredentialRecord } from "../../../metadata/store.js";
import type { AuditLogger } from "../../../audit/logger.js";

beforeEach(() => {
    vi.restoreAllMocks();
});

const audit: AuditLogger = { log: vi.fn() } as unknown as AuditLogger;

function makeCredential(): CredentialRecord {
    return {
        id: "cred-1",
        app: "my-app",
        env: "production",
        profile: "default",
        vault_ref: "ref-1",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    } as CredentialRecord;
}

// ─── buildSqlQuery — LIMIT injection ─────────────────────────────────────────

describe("buildSqlQuery — LIMIT injection", () => {
    it("wraps query in a subquery when no LIMIT is present", () => {
        const { safeSql } = buildSqlQuery("SELECT id FROM orders", 100, {});
        expect(safeSql).toContain("SELECT * FROM (");
        expect(safeSql).toContain("LIMIT 100");
    });

    it("passes the sql through unchanged when it already has a LIMIT", () => {
        const { safeSql } = buildSqlQuery("SELECT id FROM orders LIMIT 5", 100, {});
        expect(safeSql).toContain("LIMIT 5");
        expect(safeSql).not.toContain("SELECT * FROM (");
    });

    it("detects LIMIT case-insensitively", () => {
        const { safeSql } = buildSqlQuery("select id from t limit 10", 500, {});
        expect(safeSql).not.toContain("SELECT * FROM (");
        expect(safeSql).toContain("limit 10");
    });

    it("applies the provided limit value in the wrapper", () => {
        const { safeSql } = buildSqlQuery("SELECT * FROM huge_table", 500, {});
        expect(safeSql).toContain("LIMIT 500");
    });
});

// ─── buildSqlQuery — param binding ───────────────────────────────────────────

describe("buildSqlQuery — param binding", () => {
    it("replaces :name placeholders with $n positional params", () => {
        const { safeSql, paramValues } = buildSqlQuery(
            "SELECT * FROM orders WHERE user_id = :userId AND status = :status LIMIT 10",
            500,
            { userId: 1, status: "open" },
        );
        expect(safeSql).toContain("$1");
        expect(safeSql).toContain("$2");
        expect(safeSql).not.toContain(":userId");
        expect(safeSql).not.toContain(":status");
        expect(paramValues).toContain(1);
        expect(paramValues).toContain("open");
    });

    it("reuses the same $n index when a param appears multiple times", () => {
        const { safeSql, paramValues } = buildSqlQuery(
            "SELECT * FROM t WHERE a = :x AND b = :x LIMIT 1",
            500,
            { x: "val" },
        );
        expect(safeSql.match(/\$1/g)).toHaveLength(2);
        expect(paramValues).toHaveLength(1);
    });

    it("returns empty paramValues when there are no :name placeholders", () => {
        const { paramValues } = buildSqlQuery("SELECT 1 LIMIT 1", 500, {});
        expect(paramValues).toHaveLength(0);
    });

    it("throws when a :name placeholder has no matching param value", () => {
        expect(() =>
            buildSqlQuery("SELECT * FROM t WHERE id = :missingParam LIMIT 10", 500, {}),
        ).toThrow(/missingParam/);
    });

    it("does not confuse :: cast syntax with :name params", () => {
        const { safeSql } = buildSqlQuery("SELECT now()::date AS ts LIMIT 1", 500, {});
        expect(safeSql).toContain("::date");
        expect(safeSql).not.toContain("$");
    });

    it("handles a mix of :: casts and :name params in the same query", () => {
        const { safeSql, paramValues } = buildSqlQuery(
            "SELECT id::text FROM t WHERE tenant_id = :tenantId AND amount > :min LIMIT 1",
            500,
            { tenantId: "abc", min: 100 },
        );
        expect(safeSql).toContain("::text");
        expect(safeSql).toContain("$1");
        expect(safeSql).toContain("$2");
        expect(paramValues).toEqual(["abc", 100]);
    });
});

// ─── executeSqlQuery — early guards ──────────────────────────────────────────

describe("executeSqlQuery — early guards", () => {
    it("throws when the vault secret is not a db_connection kind", async () => {
        const wrongSecret = { kind: "api_token", token: "tok" };
        const vault = { read: vi.fn().mockReturnValue(wrongSecret) } as unknown as VaultManager;

        await expect(
            executeSqlQuery(vault, makeCredential(), audit, {
                sql: "SELECT 1 LIMIT 1",
            }),
        ).rejects.toThrow(/db_connection/);
    });
});

// ─── Config validation ────────────────────────────────────────────────────────

describe("validateSqlConfig", () => {
    it("accepts a config with engine and host", () => {
        expect(() => validateSqlConfig({ engine: "postgresql", host: "db.example.com" })).not.toThrow();
    });

    it("throws when engine is missing", () => {
        expect(() => validateSqlConfig({ host: "db.example.com" })).toThrow(/engine/);
    });

    it("throws when host is missing", () => {
        expect(() => validateSqlConfig({ engine: "postgresql" })).toThrow(/host/);
    });

    it("accepts all supported engines", () => {
        const engines = ["postgresql", "mysql", "sqlserver", "oracle"];
        for (const engine of engines) {
            expect(() => validateSqlConfig({ engine, host: "db.example.com" })).not.toThrow();
        }
    });

    it("throws for an unknown engine", () => {
        expect(() => validateSqlConfig({ engine: "mongodb", host: "db.example.com" })).toThrow(/engine/);
    });
});
