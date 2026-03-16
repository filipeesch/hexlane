import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "js-yaml";
import {
    parseParamSpec,
    buildOperation,
    addOperationToFile,
    deleteOperationFromFile,
} from "../op-writer.js";

// ─── parseParamSpec ───────────────────────────────────────────────────────────

describe("parseParamSpec", () => {
    it("parses full spec: name:type:required:description", () => {
        const result = parseParamSpec("orderId:string:required:Unique order ID");
        expect(result).toEqual({ name: "orderId", type: "string", required: true, description: "Unique order ID" });
    });

    it("parses optional param", () => {
        const result = parseParamSpec("cursor:string:optional:Pagination cursor");
        expect(result.required).toBe(false);
        expect(result.description).toBe("Pagination cursor");
    });

    it("defaults type to string when omitted", () => {
        const result = parseParamSpec("orderId");
        expect(result.type).toBe("string");
        expect(result.required).toBe(true);
    });

    it("preserves colons in description", () => {
        const result = parseParamSpec("token:string:required:Format is abc:xyz");
        expect(result.description).toBe("Format is abc:xyz");
    });

    it("treats any value other than 'optional' as required", () => {
        expect(parseParamSpec("x:string:true").required).toBe(true);
        expect(parseParamSpec("x:string:yes").required).toBe(true);
        expect(parseParamSpec("x:string:optional").required).toBe(false);
        expect(parseParamSpec("x:string:OPTIONAL").required).toBe(false);
    });

    it("throws when name is empty", () => {
        expect(() => parseParamSpec("")).toThrow(/name is required/);
    });

    it("omits description key when no description part present", () => {
        const result = parseParamSpec("orderId:integer:optional");
        expect(result.description).toBeUndefined();
        expect("description" in result).toBe(false);
    });
});

// ─── buildOperation ───────────────────────────────────────────────────────────

describe("buildOperation — api", () => {
    it("builds a minimal api operation", () => {
        const op = buildOperation({ kind: "api", name: "get-order", method: "GET", path: "/orders/{{ id }}" });
        expect(op.kind).toBe("api");
        expect(op.name).toBe("get-order");
        expect(op.parameters).toEqual([]);
        if (op.kind === "api") {
            expect(op.execution.method).toBe("GET");
            expect(op.execution.path).toBe("/orders/{{ id }}");
        }
    });

    it("upcases method", () => {
        const op = buildOperation({ kind: "api", name: "ping", method: "post", path: "/ping" });
        if (op.kind === "api") expect(op.execution.method).toBe("POST");
    });

    it("includes optional fields when provided", () => {
        const op = buildOperation({
            kind: "api",
            name: "list-orders",
            method: "GET",
            path: "/orders",
            profile: "reader",
            defaultEnv: "prod",
            tags: ["orders", "read"],
            readOnly: true,
            description: "List all orders",
            params: [{ name: "page", type: "integer", required: false }],
        });
        expect(op.description).toBe("List all orders");
        expect(op.profile).toBe("reader");
        expect(op.defaultEnv).toBe("prod");
        expect(op.tags).toEqual(["orders", "read"]);
        expect(op.parameters).toHaveLength(1);
    });

    it("throws on invalid method", () => {
        expect(() =>
            buildOperation({ kind: "api", name: "bad", method: "CONNECT", path: "/x" })
        ).toThrow(/Invalid operation/);
    });

    it("includes body in execution when provided", () => {
        const op = buildOperation({
            kind: "api",
            name: "create-order",
            method: "POST",
            path: "/orders",
            body: '{"type": "{{ orderType }}"}',
        });
        if (op.kind === "api") {
            expect(op.execution.body).toBe('{"type": "{{ orderType }}"}');
        }
    });

    it("omits body from execution when not provided", () => {
        const op = buildOperation({ kind: "api", name: "ping", method: "GET", path: "/ping" });
        if (op.kind === "api") {
            expect(op.execution.body).toBeUndefined();
        }
    });

    it("throws on invalid operation name (uppercase)", () => {
        expect(() =>
            buildOperation({ kind: "api", name: "GetOrder", method: "GET", path: "/orders" })
        ).toThrow(/Invalid operation/);
    });
});

describe("buildOperation — db", () => {
    it("builds a minimal db operation", () => {
        const op = buildOperation({ kind: "db", name: "find-order", sql: "SELECT * FROM orders" });
        expect(op.kind).toBe("db");
        if (op.kind === "db") {
            expect(op.readOnly).toBe(true); // Zod default
            expect(op.execution.sql).toBe("SELECT * FROM orders");
        }
    });

    it("includes optional fields", () => {
        const op = buildOperation({
            kind: "db",
            name: "find-by-id",
            sql: "SELECT * FROM t WHERE id = :id",
            profile: "readonly",
            tags: ["db"],
            params: [{ name: "id", type: "integer", required: true, description: "Row ID" }],
        });
        expect(op.profile).toBe("readonly");
        expect(op.parameters).toHaveLength(1);
        expect(op.parameters[0]!.type).toBe("integer");
    });
});

// ─── addOperationToFile / deleteOperationFromFile ─────────────────────────────

function makeAppYaml(operations: unknown[] = []): string {
    return yaml.dump({
        version: 1,
        app: {
            id: "test-app",
            environments: [],
            operations,
        },
    });
}

describe("addOperationToFile", () => {
    let tmpDir: string;
    let configPath: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hexlane-test-"));
        configPath = path.join(tmpDir, "test-app.yaml");
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true });
    });

    it("adds an operation to an empty operations array", () => {
        fs.writeFileSync(configPath, makeAppYaml(), "utf8");
        const op = buildOperation({ kind: "api", name: "ping", method: "GET", path: "/ping" });

        addOperationToFile(configPath, op);

        const result = yaml.load(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
        const app = result["app"] as Record<string, unknown>;
        const ops = app["operations"] as Array<Record<string, unknown>>;
        expect(ops).toHaveLength(1);
        expect(ops[0]!["name"]).toBe("ping");
    });

    it("adds an operation to a file that has existing operations", () => {
        const existing = [{ name: "existing-op", kind: "api", parameters: [], execution: { method: "GET", path: "/x" } }];
        fs.writeFileSync(configPath, makeAppYaml(existing), "utf8");

        const op = buildOperation({ kind: "api", name: "new-op", method: "POST", path: "/y" });
        addOperationToFile(configPath, op);

        const result = yaml.load(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
        const app = result["app"] as Record<string, unknown>;
        const ops = app["operations"] as Array<Record<string, unknown>>;
        expect(ops).toHaveLength(2);
        expect(ops.map((o) => o["name"])).toEqual(["existing-op", "new-op"]);
    });

    it("throws on name collision", () => {
        const existing = [{ name: "ping", kind: "api", parameters: [], execution: { method: "GET", path: "/ping" } }];
        fs.writeFileSync(configPath, makeAppYaml(existing), "utf8");

        const op = buildOperation({ kind: "api", name: "ping", method: "GET", path: "/ping" });
        expect(() => addOperationToFile(configPath, op)).toThrow(/already exists/);
    });

    it("persists all Zod-defaulted fields correctly", () => {
        fs.writeFileSync(configPath, makeAppYaml(), "utf8");
        const op = buildOperation({ kind: "db", name: "find-row", sql: "SELECT 1" });
        addOperationToFile(configPath, op);

        const result = yaml.load(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
        const app = result["app"] as Record<string, unknown>;
        const ops = app["operations"] as Array<Record<string, unknown>>;
        expect(ops[0]!["readOnly"]).toBe(true);
        expect(ops[0]!["kind"]).toBe("db");
    });

    it("persists body when provided", () => {
        fs.writeFileSync(configPath, makeAppYaml(), "utf8");
        const op = buildOperation({
            kind: "api",
            name: "create-order",
            method: "POST",
            path: "/orders",
            body: '{"type": "{{ orderType }}"}',
        });
        addOperationToFile(configPath, op);

        const result = yaml.load(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
        const app = result["app"] as Record<string, unknown>;
        const ops = app["operations"] as Array<Record<string, unknown>>;
        const exec = ops[0]!["execution"] as Record<string, unknown>;
        expect(exec["body"]).toBe('{"type": "{{ orderType }}"}');
    });
});

describe("deleteOperationFromFile", () => {
    let tmpDir: string;
    let configPath: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hexlane-test-"));
        configPath = path.join(tmpDir, "test-app.yaml");
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true });
    });

    it("removes an operation by name", () => {
        const ops = [
            { name: "alpha", kind: "api", parameters: [], execution: { method: "GET", path: "/a" } },
            { name: "beta", kind: "api", parameters: [], execution: { method: "GET", path: "/b" } },
        ];
        fs.writeFileSync(configPath, makeAppYaml(ops), "utf8");

        deleteOperationFromFile(configPath, "alpha");

        const result = yaml.load(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
        const app = result["app"] as Record<string, unknown>;
        const remaining = app["operations"] as Array<Record<string, unknown>>;
        expect(remaining).toHaveLength(1);
        expect(remaining[0]!["name"]).toBe("beta");
    });

    it("throws when operation name is not found", () => {
        fs.writeFileSync(configPath, makeAppYaml(), "utf8");
        expect(() => deleteOperationFromFile(configPath, "ghost")).toThrow(/not found/);
    });

    it("results in an empty array when the last operation is removed", () => {
        const ops = [{ name: "only-op", kind: "api", parameters: [], execution: { method: "GET", path: "/x" } }];
        fs.writeFileSync(configPath, makeAppYaml(ops), "utf8");

        deleteOperationFromFile(configPath, "only-op");

        const result = yaml.load(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
        const app = result["app"] as Record<string, unknown>;
        expect((app["operations"] as unknown[]).length).toBe(0);
    });
});
