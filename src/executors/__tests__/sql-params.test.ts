/**
 * Regression tests for the SQL named-parameter regex used in db-executor.
 *
 * The regex must match `:name` single-colon placeholders but NOT
 * `::type` PostgreSQL cast syntax (double-colon).
 */
import { describe, it, expect } from "vitest";

// Mirror of the exact regex used in db-executor.ts
const SQL_PARAM_REGEX = /(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)/g;

function extractParams(sql: string): string[] {
    const found: string[] = [];
    for (const m of sql.matchAll(SQL_PARAM_REGEX)) {
        found.push(m[1]!);
    }
    return found;
}

describe("SQL named-parameter regex", () => {
    it("matches a plain :name placeholder", () => {
        expect(extractParams("SELECT * FROM t WHERE id = :id")).toEqual(["id"]);
    });

    it("does NOT match ::type PostgreSQL casts", () => {
        expect(extractParams("SELECT id::text FROM t")).toEqual([]);
        expect(extractParams("SELECT val::boolean, val2::bigint FROM t")).toEqual([]);
    });

    it("matches :name but not the :: cast in the same query", () => {
        const params = extractParams("SELECT id::text FROM t WHERE id = :id AND active = :active");
        expect(params).toEqual(["id", "active"]);
        expect(params).not.toContain("text");
    });

    it("handles multiple occurrences of the same param", () => {
        const params = extractParams("SELECT :x + :x AS doubled");
        expect(params).toEqual(["x", "x"]);
    });

    it("does not match :: at the start of a word (e.g. ::boolean)", () => {
        expect(extractParams("SELECT val::boolean FROM t")).toEqual([]);
    });

    it("handles mixed casts and params in a realistic query", () => {
        const sql = `
            SELECT
                id::text,
                created_at::date,
                status
            FROM orders
            WHERE tenant_id = :tenantId
              AND status = :status
              AND amount > :minAmount
        `;
        expect(extractParams(sql)).toEqual(["tenantId", "status", "minAmount"]);
    });

    it("matches :name right after a non-colon character", () => {
        expect(extractParams("a=:x")).toEqual(["x"]);
        expect(extractParams("(:x)")).toEqual(["x"]);
    });
});
