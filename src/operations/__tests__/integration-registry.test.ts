import { describe, it, expect, vi } from "vitest";
import { IntegrationOperationRegistry } from "../integration-registry.js";
import type { IntegrationStore } from "../../config/integration-store.js";
import type { IntegrationConfig } from "../../config/integration-schema.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeConfig(
    id: string,
    targets: string[],
    ops: { name: string }[],
    defaultTarget?: string
): IntegrationConfig {
    return {
        version: 1,
        integration: {
            id,
            ...(defaultTarget ? { defaultTarget } : {}),
            targets: targets.map((tid) => ({
                id: tid,
                tools: [{
                    type: "http" as const,
                    config: { base_url: `https://${tid}.example.com` },
                    credential: {
                        kind: "api_token" as const,
                        acquire_strategy: {
                            kind: "shell" as const,
                            command: "echo '{\"token\":\"test\"}'",
                            output_mapping: { kind: "api_token" as const, token_path: "token" },
                        },
                    },
                }],
            })),
            operations: ops.map((op) => ({
                tool: "http" as const,
                name: op.name,
                parameters: [],
                execution: { method: "GET" as const, path: "/ping" },
            })),
        },
    } as unknown as IntegrationConfig;
}

function makeStore(configs: IntegrationConfig[]): IntegrationStore {
    return {
        list: vi.fn(() =>
            configs.map((c) => ({ id: c.integration.id, config_path: "", registered_at: "", validated: true })),
        ),
        get: vi.fn((id: string) => {
            const cfg = configs.find((c) => c.integration.id === id);
            if (!cfg) throw new Error(`Integration "${id}" not found`);
            return cfg;
        }),
    } as unknown as IntegrationStore;
}

// ─── lookupByIntegrationRef ───────────────────────────────────────────────────

describe("IntegrationOperationRegistry.lookupByIntegrationRef", () => {
    it("finds op by integration/op-name ref", () => {
        const store = makeStore([
            makeConfig("bsp", ["bsp-forno", "bsp-staging"], [{ name: "sync" }], "bsp-forno"),
        ]);
        const reg = new IntegrationOperationRegistry(store);
        const entry = reg.lookupByIntegrationRef("bsp/sync");
        expect(entry.targetId).toBe("bsp-forno");
        expect(entry.operation.name).toBe("sync");
        expect(entry.integrationId).toBe("bsp");
    });

    it("returns undefined targetId when integration has no defaultTarget", () => {
        const store = makeStore([
            makeConfig("bsp", ["bsp-forno", "bsp-staging"], [{ name: "sync" }]),
        ]);
        const reg = new IntegrationOperationRegistry(store);
        const entry = reg.lookupByIntegrationRef("bsp/sync");
        expect(entry.targetId).toBeUndefined();
        expect(entry.operation.name).toBe("sync");
    });

    it("throws when op is not found", () => {
        const store = makeStore([
            makeConfig("bsp", ["bsp-forno"], [{ name: "sync" }]),
        ]);
        const reg = new IntegrationOperationRegistry(store);
        expect(() => reg.lookupByIntegrationRef("bsp/nonexistent")).toThrow(/not found/);
    });

    it("throws when integration is not found", () => {
        const store = makeStore([
            makeConfig("bsp", ["bsp-forno"], [{ name: "sync" }]),
        ]);
        const reg = new IntegrationOperationRegistry(store);
        expect(() => reg.lookupByIntegrationRef("other/sync")).toThrow(/not found/);
    });
});

// ─── hasIntegrationRef ────────────────────────────────────────────────────────

describe("IntegrationOperationRegistry.hasIntegrationRef", () => {
    it("returns true for registered ops", () => {
        const store = makeStore([
            makeConfig("bsp", ["bsp-forno"], [{ name: "sync" }]),
        ]);
        const reg = new IntegrationOperationRegistry(store);
        expect(reg.hasIntegrationRef("bsp/sync")).toBe(true);
        expect(reg.hasIntegrationRef("bsp/nonexistent")).toBe(false);
    });
});

// ─── lookupWithTargetOverride ─────────────────────────────────────────────────

describe("IntegrationOperationRegistry.lookupWithTargetOverride", () => {
    it("resolves by integrationRef and overrides the executing target", () => {
        const store = makeStore([
            makeConfig("bsp", ["bsp-forno", "bsp-staging"], [{ name: "sync" }], "bsp-forno"),
        ]);
        const reg = new IntegrationOperationRegistry(store);
        const entry = reg.lookupWithTargetOverride("bsp/sync", "bsp-staging");
        expect(entry.targetId).toBe("bsp-staging");
        expect(entry.integrationId).toBe("bsp");
    });

    it("throws when override target does not belong to the op's integration", () => {
        const store = makeStore([
            makeConfig("bsp", ["bsp-forno", "bsp-staging"], [{ name: "sync" }], "bsp-forno"),
        ]);
        const reg = new IntegrationOperationRegistry(store);
        expect(() => reg.lookupWithTargetOverride("bsp/sync", "bsp-prod")).toThrow(
            /not part of integration/,
        );
    });

    it("throws when the ref itself does not exist", () => {
        const store = makeStore([
            makeConfig("bsp", ["bsp-forno", "bsp-staging"], [{ name: "sync" }]),
        ]);
        const reg = new IntegrationOperationRegistry(store);
        expect(() => reg.lookupWithTargetOverride("bsp/nonexistent", "bsp-staging")).toThrow(/not found/);
    });

    it("preserves the original operation when overriding target", () => {
        const store = makeStore([
            makeConfig("bsp", ["bsp-forno", "bsp-staging"], [{ name: "sync" }], "bsp-forno"),
        ]);
        const reg = new IntegrationOperationRegistry(store);
        const entry = reg.lookupWithTargetOverride("bsp/sync", "bsp-staging");
        expect(entry.operation.name).toBe("sync");
        expect(entry.operation.tool).toBe("http");
    });
});

// ─── integration-level defaultTarget ────────────────────────────────────────

describe("IntegrationOperationRegistry — integration-level defaultTarget", () => {
    it("uses integration.defaultTarget for ops when set", () => {
        const config: IntegrationConfig = {
            version: 1,
            integration: {
                id: "bsp",
                defaultTarget: "bsp-staging",
                targets: [
                    { id: "bsp-forno", tools: [{ type: "http" as const, config: { base_url: "https://bsp-forno.example.com" } }] },
                    { id: "bsp-staging", tools: [{ type: "http" as const, config: { base_url: "https://bsp-staging.example.com" } }] },
                ],
                operations: [{
                    tool: "http" as const,
                    name: "sync",
                    parameters: [],
                    execution: { method: "GET" as const, path: "/ping" },
                }],
            },
        } as unknown as IntegrationConfig;
        const store = makeStore([config]);
        const reg = new IntegrationOperationRegistry(store);
        const entry = reg.lookupByIntegrationRef("bsp/sync");
        expect(entry.targetId).toBe("bsp-staging");
    });

    it("returns undefined targetId when integration has no defaultTarget", () => {
        const config: IntegrationConfig = {
            version: 1,
            integration: {
                id: "bsp",
                targets: [
                    { id: "bsp-forno", tools: [{ type: "http" as const, config: { base_url: "https://bsp-forno.example.com" } }] },
                    { id: "bsp-staging", tools: [{ type: "http" as const, config: { base_url: "https://bsp-staging.example.com" } }] },
                ],
                operations: [{
                    tool: "http" as const,
                    name: "sync",
                    parameters: [],
                    execution: { method: "GET" as const, path: "/ping" },
                }],
            },
        } as unknown as IntegrationConfig;
        const store = makeStore([config]);
        const reg = new IntegrationOperationRegistry(store);
        const entry = reg.lookupByIntegrationRef("bsp/sync");
        expect(entry.targetId).toBeUndefined();
    });
});

// ─── getCompatibleTargets ────────────────────────────────────────────────────

describe("IntegrationOperationRegistry.getCompatibleTargets", () => {
    it("returns targets that have the specified tool type", () => {
        const config: IntegrationConfig = {
            version: 1,
            integration: {
                id: "bsp",
                targets: [
                    { id: "bsp-api", tools: [{ type: "http" as const, config: {} }] },
                    { id: "bsp-db", tools: [{ type: "sql" as const, config: {} }] },
                    { id: "bsp-multi", tools: [{ type: "http" as const, config: {} }, { type: "sql" as const, config: {} }] },
                ],
                operations: [{
                    tool: "http" as const,
                    name: "sync",
                    parameters: [],
                    execution: { method: "GET" as const, path: "/ping" },
                }],
            },
        } as unknown as IntegrationConfig;
        const store = makeStore([config]);
        const reg = new IntegrationOperationRegistry(store);
        expect(reg.getCompatibleTargets("bsp", "http")).toEqual(["bsp-api", "bsp-multi"]);
        expect(reg.getCompatibleTargets("bsp", "sql")).toEqual(["bsp-db", "bsp-multi"]);
        expect(reg.getCompatibleTargets("bsp", "fs")).toEqual([]);
    });

    it("returns empty array for unknown integration", () => {
        const store = makeStore([makeConfig("bsp", ["bsp-forno"], [{ name: "sync" }])]);
        const reg = new IntegrationOperationRegistry(store);
        expect(reg.getCompatibleTargets("unknown", "http")).toEqual([]);
    });
});

// ─── list ────────────────────────────────────────────────────────────────────

describe("IntegrationOperationRegistry.list", () => {
    it("lists all operations across integrations", () => {
        const store = makeStore([
            makeConfig("bsp", ["bsp-forno"], [{ name: "sync" }, { name: "ping" }]),
            makeConfig("company", ["company-api"], [{ name: "list-products" }]),
        ]);
        const reg = new IntegrationOperationRegistry(store);
        expect(reg.list()).toHaveLength(3);
    });

    it("filters by integration ID", () => {
        const store = makeStore([
            makeConfig("bsp", ["bsp-forno"], [{ name: "sync" }]),
            makeConfig("company", ["company-api"], [{ name: "list-products" }]),
        ]);
        const reg = new IntegrationOperationRegistry(store);
        expect(reg.list("bsp")).toHaveLength(1);
        expect(reg.list("bsp")[0]!.integrationId).toBe("bsp");
    });

    it("filters by text (name, description, tags, ref, tool)", () => {
        const store = makeStore([
            makeConfig("bsp", ["bsp-forno"], [{ name: "sync" }, { name: "ping" }]),
        ]);
        const reg = new IntegrationOperationRegistry(store);
        expect(reg.list(undefined, "sync")).toHaveLength(1);
        expect(reg.list(undefined, "SYNC")).toHaveLength(1); // case-insensitive
        expect(reg.list(undefined, "missing")).toHaveLength(0);
        expect(reg.list(undefined, "http")).toHaveLength(2); // filter by tool
        expect(reg.list(undefined, "bsp/sync")).toHaveLength(1); // filter by integrationRef
    });

    it("gracefully skips integrations that fail to load", () => {
        const store = {
            list: vi.fn(() => [
                { id: "bad", config_path: "", registered_at: "", validated: false },
                { id: "good", config_path: "", registered_at: "", validated: true },
            ]),
            get: vi.fn((id: string) => {
                if (id === "bad") throw new Error("corrupt yaml");
                return makeConfig("good", ["good-target"], [{ name: "ping" }]);
            }),
        } as unknown as IntegrationStore;
        const reg = new IntegrationOperationRegistry(store);
        expect(reg.list()).toHaveLength(1);
        expect(reg.list()[0]!.integrationId).toBe("good");
    });
});
