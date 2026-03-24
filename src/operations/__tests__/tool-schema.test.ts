/**
 * Tests for the new tool-based operation schemas (HttpOperation, SqlOperation).
 *
 * These test the `tool: "http" | "sql"` discriminated union that replaces
 * the old `kind: "api" | "db"` union. The old kind-based types are NOT
 * tested here — they have their own tests in schema.test.ts.
 */
import { describe, it, expect } from "vitest";
import {
    HttpOperationSchema,
    SqlOperationSchema,
    ToolOperationSchema,
} from "../schema.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseHttp(obj: unknown) {
    return HttpOperationSchema.parse(obj);
}

function parseSql(obj: unknown) {
    return SqlOperationSchema.parse(obj);
}

function safeParseTool(obj: unknown) {
    return ToolOperationSchema.safeParse(obj);
}

// ─── HttpOperation ────────────────────────────────────────────────────────────

describe("HttpOperationSchema", () => {
    it("parses a minimal GET operation", () => {
        const result = parseHttp({
            tool: "http",
            name: "get-order",
            execution: { method: "GET", path: "/orders/:orderId" },
        });
        expect(result.tool).toBe("http");
        expect(result.name).toBe("get-order");
        expect(result.execution.method).toBe("GET");
    });

    it("parses a POST operation with body and readOnly false", () => {
        const result = parseHttp({
            tool: "http",
            name: "create-order",
            readOnly: false,
            execution: {
                method: "POST",
                path: "/orders",
                body: '{"item":":itemId"}',
            },
        });
        expect(result.readOnly).toBe(false);
        expect(result.execution.body).toContain(":itemId");
    });

    it("parses an operation with query params in execution", () => {
        const result = parseHttp({
            tool: "http",
            name: "list-issues",
            execution: {
                method: "GET",
                path: "/repos/:owner/:repo/issues",
                query: { state: ":state", per_page: ":perPage" },
            },
        });
        expect(result.execution.query?.["state"]).toBe(":state");
    });

    it("defaults parameters to an empty array", () => {
        const result = parseHttp({
            tool: "http",
            name: "health-check",
            execution: { method: "GET", path: "/health" },
        });
        expect(result.parameters).toEqual([]);
    });

    it("parses an operation with parameters defined", () => {
        const result = parseHttp({
            tool: "http",
            name: "get-user",
            parameters: [
                { name: "userId", type: "integer", required: true },
            ],
            execution: { method: "GET", path: "/users/:userId" },
        });
        expect(result.parameters).toHaveLength(1);
        expect(result.parameters[0]?.name).toBe("userId");
    });

    it("ignores unknown fields like defaultTarget (no per-op defaults)", () => {
        const result = parseHttp({
            tool: "http",
            name: "get-order",
            execution: { method: "GET", path: "/orders/:id" },
        });
        expect("defaultTarget" in result).toBe(false);
    });

    it("rejects when name has uppercase letters", () => {
        const result = safeParseTool({
            tool: "http",
            name: "GetOrder",
            execution: { method: "GET", path: "/orders" },
        });
        expect(result.success).toBe(false);
    });

    it("rejects when execution method is not a valid HTTP verb", () => {
        const result = safeParseTool({
            tool: "http",
            name: "bad-method",
            execution: { method: "CONNECT", path: "/resource" },
        });
        expect(result.success).toBe(false);
    });

    it("rejects when execution path is empty", () => {
        const result = safeParseTool({
            tool: "http",
            name: "no-path",
            execution: { method: "GET", path: "" },
        });
        expect(result.success).toBe(false);
    });
});

// ─── SqlOperation ─────────────────────────────────────────────────────────────

describe("SqlOperationSchema", () => {
    it("parses a minimal SELECT operation", () => {
        const result = parseSql({
            tool: "sql",
            name: "get-orders",
            execution: { sql: "SELECT * FROM orders WHERE user_id = :userId" },
        });
        expect(result.tool).toBe("sql");
        expect(result.name).toBe("get-orders");
        expect(result.execution.sql).toContain("orders");
    });

    it("defaults readOnly to true", () => {
        const result = parseSql({
            tool: "sql",
            name: "list-users",
            execution: { sql: "SELECT id FROM users" },
        });
        expect(result.readOnly).toBe(true);
    });

    it("allows readOnly to be set to false for write operations", () => {
        const result = parseSql({
            tool: "sql",
            name: "update-status",
            readOnly: false,
            execution: { sql: "UPDATE orders SET status = :status WHERE id = :id" },
        });
        expect(result.readOnly).toBe(false);
    });

    it("parses with tags and description", () => {
        const result = parseSql({
            tool: "sql",
            name: "report-orders",
            description: "Returns daily order summary",
            tags: ["reporting", "orders"],
            execution: { sql: "SELECT date, COUNT(*) FROM orders GROUP BY date" },
        });
        expect(result.tags).toContain("reporting");
        expect(result.description).toBeDefined();
    });

    it("rejects when sql string is empty", () => {
        const result = safeParseTool({
            tool: "sql",
            name: "empty-sql",
            execution: { sql: "" },
        });
        expect(result.success).toBe(false);
    });

    it("rejects when name contains underscores (dashes only)", () => {
        const result = safeParseTool({
            tool: "sql",
            name: "get_orders",
            execution: { sql: "SELECT 1" },
        });
        expect(result.success).toBe(false);
    });
});

// ─── ToolOperationSchema dispatch ─────────────────────────────────────────────

describe("ToolOperationSchema — discriminated union", () => {
    it("dispatches to http when tool is 'http'", () => {
        const result = safeParseTool({
            tool: "http",
            name: "get-resource",
            execution: { method: "GET", path: "/resource" },
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.tool).toBe("http");
        }
    });

    it("dispatches to sql when tool is 'sql'", () => {
        const result = safeParseTool({
            tool: "sql",
            name: "query-data",
            execution: { sql: "SELECT 1" },
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.tool).toBe("sql");
        }
    });

    it("rejects when tool is an unknown value", () => {
        const result = safeParseTool({
            tool: "kafka",
            name: "consume-events",
            execution: {},
        });
        expect(result.success).toBe(false);
    });

    it("rejects when tool field is missing", () => {
        const result = safeParseTool({
            name: "no-tool",
            execution: { method: "GET", path: "/" },
        });
        expect(result.success).toBe(false);
    });
});
