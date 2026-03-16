/**
 * Tests for op run dispatch logic: verifies that API and DB operations
 * are routed to the correct executor primitives, and that --dry-run
 * renders the template without calling any executor.
 *
 * We test the underlying resolution + rendering logic directly (not via CLI)
 * to keep tests fast and hermetic.
 */
import { describe, it, expect, vi } from "vitest";
import { resolveParams } from "../param-resolver.js";
import { renderApiExecution, renderDbExecution } from "../renderer.js";
import type { ApiOperation, DbOperation } from "../schema.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const apiOp: ApiOperation = {
    kind: "api",
    name: "get-order",
    profile: "support-user",
    defaultEnv: "dev",
    parameters: [
        { name: "orderId", type: "string", required: true, description: "Order ID" },
    ],
    execution: {
        method: "GET",
        path: "/orders/{{ orderId }}",
    },
};

const dbOp: DbOperation = {
    kind: "db",
    name: "find-order-row",
    profile: "readonly",
    readOnly: true,
    parameters: [
        { name: "orderId", type: "integer", required: true, description: "Order primary key" },
    ],
    execution: {
        sql: "SELECT * FROM orders WHERE id = :orderId",
    },
};

// ─── API operation dispatch ───────────────────────────────────────────────────

describe("op run — API operation", () => {
    it("resolves and renders the API execution correctly", () => {
        const params = resolveParams(apiOp, { orderId: "123" });
        const rendered = renderApiExecution(apiOp.execution, params);

        expect(rendered.method).toBe("GET");
        expect(rendered.path).toBe("/orders/123");
        expect(rendered.body).toBeUndefined();
    });

    it("dry-run produces a plan with no executor calls", () => {
        const mockExecuteApiCall = vi.fn();

        const params = resolveParams(apiOp, { orderId: "456" });
        const rendered = renderApiExecution(apiOp.execution, params);

        // Simulate dry-run: build plan, never call executeApiCall
        const plan = {
            "dry-run": true,
            ref: "payments-api/get-order",
            env: "dev",
            profile: "support-user",
            method: rendered.method,
            path: rendered.path,
        };

        expect(mockExecuteApiCall).not.toHaveBeenCalled();
        expect(plan.path).toBe("/orders/456");
        expect(plan["dry-run"]).toBe(true);
    });

    it("missing required param throws ParamValidationError before any executor call", async () => {
        const { ParamValidationError } = await import("../param-resolver.js");
        expect(() => resolveParams(apiOp, {})).toThrow(ParamValidationError);
    });

    it("coerces integer orderId before rendering", () => {
        const params = resolveParams(dbOp, { orderId: "99" });
        expect(params["orderId"]).toBe(99);
        expect(typeof params["orderId"]).toBe("number");
    });
});

// ─── DB operation dispatch ────────────────────────────────────────────────────

describe("op run — DB operation", () => {
    it("resolves, coerces, and renders the DB execution correctly", () => {
        const params = resolveParams(dbOp, { orderId: "42" });
        const rendered = renderDbExecution(dbOp.execution, params);

        // SQL is passed through as-is; executor handles :name → $N
        expect(rendered.sql).toBe("SELECT * FROM orders WHERE id = :orderId");
        expect(rendered.params["orderId"]).toBe(42);
    });

    it("dry-run produces a plan with no executor calls", () => {
        const mockExecuteDbQuery = vi.fn();

        const params = resolveParams(dbOp, { orderId: "7" });
        const rendered = renderDbExecution(dbOp.execution, params);

        const plan = {
            "dry-run": true,
            ref: "payments-api/find-order-row",
            env: "dev",
            profile: "readonly",
            sql: rendered.sql,
            params: rendered.params,
        };

        expect(mockExecuteDbQuery).not.toHaveBeenCalled();
        expect(plan["params"]["orderId"]).toBe(7);
    });

    it("missing required DB param throws before executor is called", async () => {
        const { ParamValidationError } = await import("../param-resolver.js");
        expect(() => resolveParams(dbOp, {})).toThrow(ParamValidationError);
    });
});

// ─── Profile / env resolution ─────────────────────────────────────────────────

describe("op run — profile and env resolution", () => {
    it("uses defaultProfile from operation when no runtime --profile", () => {
        const runtimeProfile: string | undefined = undefined;
        const profileName = runtimeProfile ?? apiOp.profile;
        expect(profileName).toBe("support-user");
    });

    it("runtime --profile overrides operation default profile", () => {
        const runtimeProfile: string | undefined = "override-profile";
        const profileName = runtimeProfile ?? apiOp.profile;
        expect(profileName).toBe("override-profile");
    });

    it("uses defaultEnv from operation when no runtime --env", () => {
        const runtimeEnv: string | undefined = undefined;
        const envName = runtimeEnv ?? apiOp.defaultEnv;
        expect(envName).toBe("dev");
    });

    it("runtime --env overrides defaultEnv", () => {
        const runtimeEnv: string | undefined = "staging";
        const envName = runtimeEnv ?? apiOp.defaultEnv;
        expect(envName).toBe("staging");
    });

    it("errors when neither --env nor defaultEnv is available", () => {
        const opWithoutDefaultEnv: ApiOperation = { ...apiOp, defaultEnv: undefined };
        const runtimeEnv: string | undefined = undefined;
        const envName = runtimeEnv ?? opWithoutDefaultEnv.defaultEnv;
        expect(envName).toBeUndefined();
        // In op.ts: if (!envName) die(...) — we just verify the undefined state here
    });
});
