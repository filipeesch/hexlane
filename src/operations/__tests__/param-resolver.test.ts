import { describe, it, expect } from "vitest";
import { resolveParams, ParamValidationError } from "../param-resolver.js";
import type { Operation } from "../schema.js";

function makeApiOp(params: Operation["parameters"]): Operation {
    return {
        kind: "api",
        name: "test-op",
        parameters: params,
        execution: { method: "GET", path: "/test" },
    };
}

describe("resolveParams", () => {
    it("passes through a valid string param", () => {
        const op = makeApiOp([{ name: "id", type: "string", required: true }]);
        const result = resolveParams(op, { id: "abc123" });
        expect(result["id"]).toBe("abc123");
    });

    it("coerces integer param from string", () => {
        const op = makeApiOp([{ name: "orderId", type: "integer", required: true }]);
        const result = resolveParams(op, { orderId: "42" });
        expect(result["orderId"]).toBe(42);
        expect(typeof result["orderId"]).toBe("number");
    });

    it("coerces number (float) param from string", () => {
        const op = makeApiOp([{ name: "amount", type: "number", required: true }]);
        const result = resolveParams(op, { amount: "3.14" });
        expect(result["amount"]).toBeCloseTo(3.14);
    });

    it("coerces boolean true values", () => {
        const op = makeApiOp([{ name: "flag", type: "boolean", required: true }]);
        expect(resolveParams(op, { flag: "true" })["flag"]).toBe(true);
        expect(resolveParams(op, { flag: "1" })["flag"]).toBe(true);
        expect(resolveParams(op, { flag: "yes" })["flag"]).toBe(true);
    });

    it("coerces boolean false values", () => {
        const op = makeApiOp([{ name: "flag", type: "boolean", required: true }]);
        expect(resolveParams(op, { flag: "false" })["flag"]).toBe(false);
        expect(resolveParams(op, { flag: "0" })["flag"]).toBe(false);
        expect(resolveParams(op, { flag: "no" })["flag"]).toBe(false);
    });

    it("skips optional param when not provided", () => {
        const op = makeApiOp([{ name: "cursor", type: "string", required: false }]);
        const result = resolveParams(op, {});
        expect("cursor" in result).toBe(false);
    });

    it("throws ParamValidationError for missing required param with rich message", () => {
        const op = makeApiOp([{ name: "orderId", type: "string", required: true, description: "Unique order ID" }]);
        expect(() => resolveParams(op, {})).toThrow(ParamValidationError);
        try {
            resolveParams(op, {});
        } catch (err) {
            expect(err).toBeInstanceOf(ParamValidationError);
            const e = err as ParamValidationError;
            expect(e.message).toContain("orderId");
            expect(e.message).toContain("string");
            expect(e.message).toContain("Unique order ID");
            expect(e.message).toContain("--param orderId=");
        }
    });

    it("throws for invalid integer value with example in message", () => {
        const op = makeApiOp([{ name: "count", type: "integer", required: true }]);
        expect(() => resolveParams(op, { count: "not-a-number" })).toThrow(ParamValidationError);
        try {
            resolveParams(op, { count: "not-a-number" });
        } catch (err) {
            const e = err as ParamValidationError;
            expect(e.message).toContain("--param count=42");
        }
    });

    it("throws for unknown param passed via CLI", () => {
        const op = makeApiOp([{ name: "id", type: "string", required: true }]);
        expect(() => resolveParams(op, { id: "1", unknown: "oops" })).toThrow(ParamValidationError);
    });

});
