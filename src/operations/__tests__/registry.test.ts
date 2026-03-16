import { describe, it, expect, vi, beforeEach } from "vitest";
import { OperationRegistry } from "../registry.js";
import type { AppStore } from "../../config/app-store.js";
import type { AppConfig } from "../../config/schema.js";

function makeAppConfig(id: string, operations: AppConfig["app"]["operations"]): AppConfig {
    return {
        version: 1,
        app: {
            id,
            environments: [
                {
                    name: "dev",
                    profiles: [
                        {
                            name: "readonly",
                            kind: "db_connection",
                            acquire_strategy: {
                                kind: "shell",
                                command: "echo '{}'",
                                output_mapping: { kind: "db_connection" },
                            },
                            renewal_policy: { ttl: 3600, renew_before_expiry: 300 },
                        },
                    ],
                },
            ],
            operations,
        },
    };
}

function makeAppStore(apps: AppConfig[]): AppStore {
    return {
        list: vi.fn(() => apps.map((a) => ({ id: a.app.id, config_path: "", registered_at: "", validated: true }))),
        get: vi.fn((id: string) => {
            const cfg = apps.find((a) => a.app.id === id);
            if (!cfg) throw new Error(`App "${id}" not found`);
            return cfg;
        }),
    } as unknown as AppStore;
}

describe("OperationRegistry", () => {
    it("loads operations from app configs", () => {
        const store = makeAppStore([
            makeAppConfig("payments-api", [
                { name: "get-order", kind: "api", parameters: [], execution: { method: "GET", path: "/orders" } },
            ]),
        ]);
        const registry = new OperationRegistry(store);
        expect(registry.all()).toHaveLength(1);
        expect(registry.all()[0]!.ref).toBe("payments-api/get-order");
    });

    it("lookup returns operation by qualified ref", () => {
        const store = makeAppStore([
            makeAppConfig("payments-api", [
                { name: "get-order", kind: "api", parameters: [], execution: { method: "GET", path: "/orders/{{ id }}" } },
            ]),
        ]);
        const registry = new OperationRegistry(store);
        const entry = registry.lookup("payments-api/get-order");
        expect(entry.appId).toBe("payments-api");
        expect(entry.operation.name).toBe("get-order");
    });

    it("lookup throws descriptive error for unknown ref", () => {
        const store = makeAppStore([
            makeAppConfig("payments-api", [
                { name: "get-order", kind: "api", parameters: [], execution: { method: "GET", path: "/orders" } },
            ]),
        ]);
        const registry = new OperationRegistry(store);
        expect(() => registry.lookup("payments-api/nonexistent")).toThrow(/nonexistent/);
    });

    it("lookup throws for malformed ref (no slash)", () => {
        const store = makeAppStore([]);
        const registry = new OperationRegistry(store);
        expect(() => registry.lookup("no-slash")).toThrow(/format/);
    });

    it("list filters by app", () => {
        const store = makeAppStore([
            makeAppConfig("app-a", [
                { name: "op-a", kind: "api", parameters: [], execution: { method: "GET", path: "/" } },
            ]),
            makeAppConfig("app-b", [
                { name: "op-b", kind: "api", parameters: [], execution: { method: "GET", path: "/" } },
            ]),
        ]);
        const registry = new OperationRegistry(store);
        expect(registry.list("app-a")).toHaveLength(1);
        expect(registry.list("app-a")[0]!.appId).toBe("app-a");
    });

    it("list filters by text (name, description, tags)", () => {
        const store = makeAppStore([
            makeAppConfig("payments-api", [
                { name: "get-order", description: "Fetch an order", kind: "api", tags: ["orders"], parameters: [], execution: { method: "GET", path: "/" } },
                { name: "list-invoices", description: "List all invoices", kind: "api", parameters: [], execution: { method: "GET", path: "/" } },
            ]),
        ]);
        const registry = new OperationRegistry(store);
        expect(registry.list(undefined, "order")).toHaveLength(1);
        expect(registry.list(undefined, "ORDER")).toHaveLength(1); // case-insensitive
        expect(registry.list(undefined, "invoice")).toHaveLength(1);
        expect(registry.list(undefined, "missing")).toHaveLength(0);
    });

    it("throws on duplicate operation names within an app", () => {
        const store = makeAppStore([
            makeAppConfig("payments-api", [
                { name: "get-order", kind: "api", parameters: [], execution: { method: "GET", path: "/" } },
                { name: "get-order", kind: "api", parameters: [], execution: { method: "GET", path: "/" } },
            ]),
        ]);
        expect(() => new OperationRegistry(store)).toThrow(/[Dd]uplicate/);
    });

    it("gracefully skips apps that fail to load", () => {
        const store = {
            list: vi.fn(() => [
                { id: "bad-app", config_path: "", registered_at: "", validated: false },
                { id: "good-app", config_path: "", registered_at: "", validated: true },
            ]),
            get: vi.fn((id: string) => {
                if (id === "bad-app") throw new Error("corrupt yaml");
                return makeAppConfig("good-app", [
                    { name: "my-op", kind: "api" as const, parameters: [], execution: { method: "GET" as const, path: "/" } },
                ]);
            }),
        } as unknown as AppStore;
        const registry = new OperationRegistry(store);
        expect(registry.all()).toHaveLength(1);
        expect(registry.all()[0]!.appId).toBe("good-app");
    });
});
