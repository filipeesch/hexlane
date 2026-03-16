import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateOperation } from "../validator.js";
import type { AppStore } from "../../config/app-store.js";
import type { AppConfig } from "../../config/schema.js";
import type { Operation } from "../schema.js";

function makeAppStore(profileNames: string[] = ["readonly", "support-user"]): AppStore {
    const config: AppConfig = {
        version: 1,
        app: {
            id: "payments-api",
            environments: [
                {
                    name: "dev",
                    profiles: profileNames.map((name) => ({
                        name,
                        kind: "api_token" as const,
                        acquire_strategy: {
                            kind: "shell" as const,
                            command: "echo",
                            output_mapping: { kind: "api_token" as const, token_path: "token" },
                        },
                        renewal_policy: { ttl: 3600, renew_before_expiry: 300 },
                    })),
                },
            ],
        },
    };
    return {
        get: vi.fn(() => config),
    } as unknown as AppStore;
}

describe("validateOperation", () => {
    it("returns valid for a well-formed API operation", () => {
        const op: Operation = {
            kind: "api",
            name: "get-order",
            profile: "support-user",
            parameters: [{ name: "orderId", type: "string", required: true }],
            execution: { method: "GET", path: "/orders/{{ orderId }}" },
        };
        const result = validateOperation("payments-api", op, makeAppStore());
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    it("returns valid for a well-formed DB operation", () => {
        const op: Operation = {
            kind: "db",
            name: "find-order",
            readOnly: true,
            parameters: [{ name: "orderId", type: "integer", required: true }],
            execution: { sql: "SELECT * FROM orders WHERE id = :orderId" },
        };
        const result = validateOperation("payments-api", op, makeAppStore());
        expect(result.valid).toBe(true);
    });

    it("rejects DB operation with readOnly: false", () => {
        const op: Operation = {
            kind: "db",
            name: "delete-order",
            readOnly: false,
            parameters: [],
            execution: { sql: "DELETE FROM orders WHERE id = :id" },
        };
        const result = validateOperation("payments-api", op, makeAppStore());
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /readOnly/.test(e))).toBe(true);
    });

    it("rejects duplicate parameter names", () => {
        const op: Operation = {
            kind: "api",
            name: "bad-op",
            parameters: [
                { name: "id", type: "string", required: true },
                { name: "id", type: "integer", required: false },
            ],
            execution: { method: "GET", path: "/orders/{{ id }}" },
        };
        const result = validateOperation("payments-api", op, makeAppStore());
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /[Dd]uplicate/.test(e))).toBe(true);
    });

    it("rejects undefined profile reference", () => {
        const op: Operation = {
            kind: "api",
            name: "get-order",
            profile: "nonexistent-profile",
            parameters: [],
            execution: { method: "GET", path: "/orders" },
        };
        const result = validateOperation("payments-api", op, makeAppStore());
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /nonexistent-profile/.test(e))).toBe(true);
    });

    it("rejects undeclared template variable in path", () => {
        const op: Operation = {
            kind: "api",
            name: "get-order",
            parameters: [], // orderId not declared
            execution: { method: "GET", path: "/orders/{{ orderId }}" },
        };
        const result = validateOperation("payments-api", op, makeAppStore());
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /orderId/.test(e))).toBe(true);
    });

    it("rejects undeclared template variable in body", () => {
        const op: Operation = {
            kind: "api",
            name: "create-order",
            parameters: [{ name: "item", type: "string", required: true }],
            execution: { method: "POST", path: "/orders", body: '{"item":"{{ item }}","user":"{{ userId }}"}' },
        };
        const result = validateOperation("payments-api", op, makeAppStore());
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /userId/.test(e))).toBe(true);
    });

    it("accumulates multiple errors", () => {
        const op: Operation = {
            kind: "db",
            name: "bad",
            readOnly: false,
            parameters: [
                { name: "x", type: "string", required: true },
                { name: "x", type: "string", required: true }, // duplicate
            ],
            execution: { sql: "SELECT {{ y }} FROM t" }, // y undeclared
        };
        const result = validateOperation("payments-api", op, makeAppStore());
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThanOrEqual(3);
    });
});
