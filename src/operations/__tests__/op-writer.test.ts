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
    addIntegrationOperationFromRaw,
    editIntegrationOperation,
    deleteIntegrationOperation,
    getIntegrationOperationYaml,
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

// ─── Integration YAML helpers ─────────────────────────────────────────────────

function makeIntegrationYaml(ops: unknown[] = []): string {
    return yaml.dump({
        version: 1,
        integration: {
            id: "test-integ",
            targets: [
                {
                    id: "prod",
                    tools: [{ type: "http", config: { base_url: "https://api.example.com" } }],
                },
            ],
            operations: ops,
        },
    });
}

const VALID_OP_YAML = yaml.dump({
    name: "list-items",
    tool: "http",
    parameters: [],
    execution: { method: "GET", path: "/items" },
});

const SECOND_OP_YAML = yaml.dump({
    name: "get-item",
    tool: "http",
    parameters: [{ name: "id", type: "string", required: true }],
    execution: { method: "GET", path: "/items/{{ id }}" },
});

// ─── getIntegrationOperationYaml ──────────────────────────────────────────────

describe("getIntegrationOperationYaml", () => {
    let tmpDir: string;
    let configPath: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hexlane-integ-test-"));
        configPath = path.join(tmpDir, "test-integ.yaml");
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true });
    });

    it("returns raw YAML of an existing operation", () => {
        const op = { name: "list-items", tool: "http", parameters: [], execution: { method: "GET", path: "/items" } };
        fs.writeFileSync(configPath, makeIntegrationYaml([op]), "utf8");

        const result = getIntegrationOperationYaml(configPath, "list-items");

        const parsed = yaml.load(result) as Record<string, unknown>;
        expect(parsed["name"]).toBe("list-items");
        expect(parsed["tool"]).toBe("http");
    });

    it("throws when operation is not found", () => {
        fs.writeFileSync(configPath, makeIntegrationYaml(), "utf8");
        expect(() => getIntegrationOperationYaml(configPath, "ghost")).toThrow(/not found/);
    });

    it("returned string is valid YAML", () => {
        const op = { name: "list-items", tool: "http", parameters: [], execution: { method: "GET", path: "/items" } };
        fs.writeFileSync(configPath, makeIntegrationYaml([op]), "utf8");

        const result = getIntegrationOperationYaml(configPath, "list-items");
        expect(() => yaml.load(result)).not.toThrow();
    });
});

// ─── addIntegrationOperationFromRaw ──────────────────────────────────────────

describe("addIntegrationOperationFromRaw", () => {
    let tmpDir: string;
    let configPath: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hexlane-integ-test-"));
        configPath = path.join(tmpDir, "test-integ.yaml");
        fs.writeFileSync(configPath, makeIntegrationYaml(), "utf8");
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true });
    });

    it("appends the operation to an empty list", () => {
        addIntegrationOperationFromRaw(configPath, VALID_OP_YAML);

        const raw = yaml.load(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
        const integration = raw["integration"] as Record<string, unknown>;
        const ops = integration["operations"] as Array<Record<string, unknown>>;
        expect(ops).toHaveLength(1);
        expect(ops[0]!["name"]).toBe("list-items");
    });

    it("returns the validated ToolOperation", () => {
        const result = addIntegrationOperationFromRaw(configPath, VALID_OP_YAML);
        expect(result.name).toBe("list-items");
        expect(result.tool).toBe("http");
    });

    it("appends when operations already exist", () => {
        addIntegrationOperationFromRaw(configPath, VALID_OP_YAML);
        addIntegrationOperationFromRaw(configPath, SECOND_OP_YAML);

        const raw = yaml.load(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
        const integration = raw["integration"] as Record<string, unknown>;
        const ops = integration["operations"] as Array<Record<string, unknown>>;
        expect(ops).toHaveLength(2);
        expect(ops[1]!["name"]).toBe("get-item");
    });

    it("throws on duplicate operation name", () => {
        addIntegrationOperationFromRaw(configPath, VALID_OP_YAML);
        expect(() => addIntegrationOperationFromRaw(configPath, VALID_OP_YAML)).toThrow(/already exists/);
    });

    it("throws on invalid YAML", () => {
        expect(() => addIntegrationOperationFromRaw(configPath, "{ bad yaml: [}")).toThrow(/Invalid YAML/);
    });

    it("throws on schema validation failure", () => {
        const badOp = yaml.dump({ name: "bad-op", tool: "http" }); // missing execution
        expect(() => addIntegrationOperationFromRaw(configPath, badOp)).toThrow(/Invalid operation/);
    });
});

// ─── editIntegrationOperation ─────────────────────────────────────────────────

describe("editIntegrationOperation", () => {
    let tmpDir: string;
    let configPath: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hexlane-integ-test-"));
        configPath = path.join(tmpDir, "test-integ.yaml");
        const op = { name: "list-items", tool: "http", parameters: [], execution: { method: "GET", path: "/items" } };
        fs.writeFileSync(configPath, makeIntegrationYaml([op]), "utf8");
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true });
    });

    it("replaces an existing operation in-place", () => {
        const updated = yaml.dump({
            name: "list-items",
            tool: "http",
            parameters: [],
            execution: { method: "GET", path: "/v2/items" },
        });

        editIntegrationOperation(configPath, "list-items", updated);

        const raw = yaml.load(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
        const integration = raw["integration"] as Record<string, unknown>;
        const ops = integration["operations"] as Array<Record<string, unknown>>;
        expect(ops).toHaveLength(1);
        const exec = ops[0]!["execution"] as Record<string, unknown>;
        expect(exec["path"]).toBe("/v2/items");
    });

    it("returns the updated ToolOperation", () => {
        const updated = yaml.dump({
            name: "list-items",
            tool: "http",
            description: "Updated description",
            parameters: [],
            execution: { method: "GET", path: "/items" },
        });

        const result = editIntegrationOperation(configPath, "list-items", updated);
        expect(result.description).toBe("Updated description");
    });

    it("preserves other operations when editing", () => {
        const secondOp = { name: "get-item", tool: "http", parameters: [], execution: { method: "GET", path: "/items/1" } };
        const raw2 = yaml.load(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
        const integration2 = raw2["integration"] as Record<string, unknown>;
        (integration2["operations"] as unknown[]).push(secondOp);
        fs.writeFileSync(configPath, yaml.dump(raw2), "utf8");

        const updated = yaml.dump({
            name: "list-items",
            tool: "http",
            parameters: [],
            execution: { method: "GET", path: "/v2/items" },
        });
        editIntegrationOperation(configPath, "list-items", updated);

        const result = yaml.load(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
        const ops = ((result["integration"] as Record<string, unknown>)["operations"]) as Array<Record<string, unknown>>;
        expect(ops).toHaveLength(2);
        expect(ops[1]!["name"]).toBe("get-item");
    });

    it("throws when operation is not found", () => {
        expect(() => editIntegrationOperation(configPath, "ghost", VALID_OP_YAML)).toThrow(/not found/);
    });

    it("throws on invalid YAML", () => {
        expect(() => editIntegrationOperation(configPath, "list-items", "{ bad yaml: [}")).toThrow(/Invalid YAML/);
    });

    it("throws on schema validation failure", () => {
        const badOp = yaml.dump({ name: "list-items", tool: "http" }); // missing execution
        expect(() => editIntegrationOperation(configPath, "list-items", badOp)).toThrow(/Invalid operation/);
    });
});

// ─── deleteIntegrationOperation ──────────────────────────────────────────────

describe("deleteIntegrationOperation", () => {
    let tmpDir: string;
    let configPath: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hexlane-integ-test-"));
        configPath = path.join(tmpDir, "test-integ.yaml");
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true });
    });

    it("removes an operation by name", () => {
        const ops = [
            { name: "alpha", tool: "http", parameters: [], execution: { method: "GET", path: "/a" } },
            { name: "beta", tool: "http", parameters: [], execution: { method: "GET", path: "/b" } },
        ];
        fs.writeFileSync(configPath, makeIntegrationYaml(ops), "utf8");

        deleteIntegrationOperation(configPath, "alpha");

        const raw = yaml.load(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
        const integration = raw["integration"] as Record<string, unknown>;
        const remaining = integration["operations"] as Array<Record<string, unknown>>;
        expect(remaining).toHaveLength(1);
        expect(remaining[0]!["name"]).toBe("beta");
    });

    it("throws when operation name is not found", () => {
        fs.writeFileSync(configPath, makeIntegrationYaml(), "utf8");
        expect(() => deleteIntegrationOperation(configPath, "ghost")).toThrow(/not found/);
    });

    it("results in an empty array when the last operation is removed", () => {
        const ops = [{ name: "only-op", tool: "http", parameters: [], execution: { method: "GET", path: "/x" } }];
        fs.writeFileSync(configPath, makeIntegrationYaml(ops), "utf8");

        deleteIntegrationOperation(configPath, "only-op");

        const raw = yaml.load(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
        const integration = raw["integration"] as Record<string, unknown>;
        expect((integration["operations"] as unknown[]).length).toBe(0);
    });
});
