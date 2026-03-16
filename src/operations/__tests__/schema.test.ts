import { describe, it, expect } from "vitest";
import { OperationSchema, ApiOperationSchema, DbOperationSchema } from "../schema.js";

describe("OperationSchema", () => {
    it("parses a valid API operation", () => {
        const result = OperationSchema.safeParse({
            name: "get-order",
            description: "Fetch order by ID",
            kind: "api",
            profile: "support-user",
            defaultEnv: "dev",
            tags: ["orders", "read"],
            readOnly: true,
            parameters: [
                { name: "orderId", type: "string", required: true, description: "Order ID" },
            ],
            execution: { method: "GET", path: "/orders/{{ orderId }}" },
            examples: [{ description: "Fetch order 123", command: "hexlane op run payments-api/get-order --param orderId=123" }],
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.kind).toBe("api");
            expect(result.data.name).toBe("get-order");
        }
    });

    it("parses a valid DB operation", () => {
        const result = DbOperationSchema.safeParse({
            name: "find-order-row",
            kind: "db",
            profile: "readonly",
            parameters: [{ name: "orderId", type: "integer", required: true }],
            execution: { sql: "SELECT * FROM orders WHERE id = :orderId" },
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.readOnly).toBe(true); // default
        }
    });

    it("rejects an operation with an invalid name (uppercase)", () => {
        const result = OperationSchema.safeParse({
            name: "GetOrder",
            kind: "api",
            parameters: [],
            execution: { method: "GET", path: "/orders" },
        });
        expect(result.success).toBe(false);
    });

    it("rejects an API operation missing execution.method", () => {
        const result = ApiOperationSchema.safeParse({
            name: "get-order",
            kind: "api",
            parameters: [],
            execution: { path: "/orders" },
        });
        expect(result.success).toBe(false);
    });

    it("rejects a DB operation missing execution.sql", () => {
        const result = DbOperationSchema.safeParse({
            name: "find-order",
            kind: "db",
            parameters: [],
            execution: {},
        });
        expect(result.success).toBe(false);
    });

    it("defaults parameter type to 'string' and required to true", () => {
        const result = OperationSchema.safeParse({
            name: "my-op",
            kind: "api",
            parameters: [{ name: "foo" }],
            execution: { method: "GET", path: "/" },
        });
        expect(result.success).toBe(true);
        if (result.success && result.data.kind === "api") {
            expect(result.data.parameters[0]!.type).toBe("string");
            expect(result.data.parameters[0]!.required).toBe(true);
        }
    });

    it("rejects a parameter with an invalid name (starts with digit)", () => {
        const result = OperationSchema.safeParse({
            name: "my-op",
            kind: "api",
            parameters: [{ name: "1bad" }],
            execution: { method: "GET", path: "/" },
        });
        expect(result.success).toBe(false);
    });
});
