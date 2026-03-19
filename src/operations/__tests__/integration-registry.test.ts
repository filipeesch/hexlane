import { describe, it, expect, vi } from "vitest";
import { IntegrationOperationRegistry } from "../integration-registry.js";
import type { IntegrationStore } from "../../config/integration-store.js";
import type { IntegrationConfig } from "../../config/integration-schema.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeConfig(id: string, targets: string[], ops: { name: string; defaultTarget?: string }[]): IntegrationConfig {
    return {
        version: 1,
        integration: {
            id,
            targets: targets.map((tid) => ({
                id: tid,
                tool: "http" as const,
                config: { base_url: `https://${tid}.example.com` },
                credential: {
                    kind: "api_token" as const,
                    acquire_strategy: {
                        kind: "shell" as const,
                        command: "echo '{\"token\":\"test\"}'",
                        output_mapping: { kind: "api_token" as const, token_path: "token" },
                    },
                },
            })),
            operations: ops.map((op) => ({
                tool: "http" as const,
                name: op.name,
                ...(op.defaultTarget ? { defaultTarget: op.defaultTarget } : {}),
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

// ─── lookupByTargetRef — exact match ─────────────────────────────────────────

describe("IntegrationOperationRegistry.lookupByTargetRef — exact match", () => {
    it("finds op by its default target ref", () => {
        const store = makeStore([
            makeConfig("bsp", ["bsp-forno", "bsp-staging"], [{ name: "sync", defaultTarget: "bsp-forno" }]),
        ]);
        const reg = new IntegrationOperationRegistry(store);
        const entry = reg.lookupByTargetRef("bsp-forno/sync");
        expect(entry.targetId).toBe("bsp-forno");
        expect(entry.operation.name).toBe("sync");
        expect(entry.integrationId).toBe("bsp");
    });

    it("uses first target when no defaultTarget is set", () => {
        const store = makeStore([
            makeConfig("bsp", ["bsp-forno", "bsp-staging"], [{ name: "sync" }]),
        ]);
        const reg = new IntegrationOperationRegistry(store);
        const entry = reg.lookupByTargetRef("bsp-forno/sync");
        expect(entry.targetId).toBe("bsp-forno");
    });
});

// ─── lookupByTargetRef — alternate target fallback ───────────────────────────

describe("IntegrationOperationRegistry.lookupByTargetRef — alternate target override", () => {
    it("resolves op by a non-default target in the same integration", () => {
        const store = makeStore([
            makeConfig("bsp", ["bsp-forno", "bsp-staging"], [{ name: "sync", defaultTarget: "bsp-forno" }]),
        ]);
        const reg = new IntegrationOperationRegistry(store);
        // bsp-staging is not the default target, but it belongs to the same integration
        const entry = reg.lookupByTargetRef("bsp-staging/sync");
        expect(entry.targetId).toBe("bsp-staging");
        expect(entry.operation.name).toBe("sync");
        expect(entry.integrationId).toBe("bsp");
        expect(entry.targetRef).toBe("bsp-staging/sync");
    });

    it("hasTargetRef returns true for alternate target refs", () => {
        const store = makeStore([
            makeConfig("bsp", ["bsp-forno", "bsp-staging"], [{ name: "sync", defaultTarget: "bsp-forno" }]),
        ]);
        const reg = new IntegrationOperationRegistry(store);
        expect(reg.hasTargetRef("bsp-staging/sync")).toBe(true);
        expect(reg.hasTargetRef("bsp-forno/sync")).toBe(true);
    });

    it("throws when target does not belong to any integration with that op", () => {
        const store = makeStore([
            makeConfig("bsp", ["bsp-forno", "bsp-staging"], [{ name: "sync", defaultTarget: "bsp-forno" }]),
        ]);
        const reg = new IntegrationOperationRegistry(store);
        expect(() => reg.lookupByTargetRef("unknown-target/sync")).toThrow(/not found/);
    });

    it("throws when op name does not exist in any integration", () => {
        const store = makeStore([
            makeConfig("bsp", ["bsp-forno", "bsp-staging"], [{ name: "sync", defaultTarget: "bsp-forno" }]),
        ]);
        const reg = new IntegrationOperationRegistry(store);
        expect(() => reg.lookupByTargetRef("bsp-staging/nonexistent")).toThrow(/not found/);
    });

    it("throws ambiguity error when two integrations share an op name and the candidate target", () => {
        // Each integration has its own default target; "shared-target" is a secondary
        // target in both. The fallback path (alternate target lookup) must find two
        // candidates and raise an ambiguity error.
        const store = makeStore([
            makeConfig("bsp-1", ["bsp-1-default", "shared-target"], [{ name: "sync", defaultTarget: "bsp-1-default" }]),
            makeConfig("bsp-2", ["bsp-2-default", "shared-target"], [{ name: "sync", defaultTarget: "bsp-2-default" }]),
        ]);
        const reg = new IntegrationOperationRegistry(store);
        // "shared-target/sync" is not the default ref for either integration, but
        // both have that target and op — must be ambiguous
        expect(() => reg.lookupByTargetRef("shared-target/sync")).toThrow(/[Aa]mbiguous/);
    });
});

// ─── lookupWithTargetOverride ─────────────────────────────────────────────────

describe("IntegrationOperationRegistry.lookupWithTargetOverride", () => {
    it("resolves by default targetRef and overrides the executing target", () => {
        const store = makeStore([
            makeConfig("bsp", ["bsp-forno", "bsp-staging"], [{ name: "sync", defaultTarget: "bsp-forno" }]),
        ]);
        const reg = new IntegrationOperationRegistry(store);
        const entry = reg.lookupWithTargetOverride("bsp-forno/sync", "bsp-staging");
        expect(entry.targetId).toBe("bsp-staging");
        expect(entry.operation.name).toBe("sync");
        expect(entry.targetRef).toBe("bsp-staging/sync");
    });

    it("resolves by integrationRef and overrides the executing target", () => {
        const store = makeStore([
            makeConfig("bsp", ["bsp-forno", "bsp-staging"], [{ name: "sync", defaultTarget: "bsp-forno" }]),
        ]);
        const reg = new IntegrationOperationRegistry(store);
        const entry = reg.lookupWithTargetOverride("bsp/sync", "bsp-staging");
        expect(entry.targetId).toBe("bsp-staging");
        expect(entry.integrationId).toBe("bsp");
    });

    it("throws when override target does not belong to the op's integration", () => {
        const store = makeStore([
            makeConfig("bsp", ["bsp-forno", "bsp-staging"], [{ name: "sync", defaultTarget: "bsp-forno" }]),
        ]);
        const reg = new IntegrationOperationRegistry(store);
        expect(() => reg.lookupWithTargetOverride("bsp-forno/sync", "bsp-prod")).toThrow(
            /not part of integration/,
        );
    });

    it("throws when the ref itself does not exist", () => {
        const store = makeStore([
            makeConfig("bsp", ["bsp-forno", "bsp-staging"], [{ name: "sync", defaultTarget: "bsp-forno" }]),
        ]);
        const reg = new IntegrationOperationRegistry(store);
        expect(() => reg.lookupWithTargetOverride("bsp-forno/nonexistent", "bsp-staging")).toThrow(/not found/);
    });

    it("preserves the original operation when overriding target", () => {
        const store = makeStore([
            makeConfig("bsp", ["bsp-forno", "bsp-staging"], [{ name: "sync", defaultTarget: "bsp-forno" }]),
        ]);
        const reg = new IntegrationOperationRegistry(store);
        const entry = reg.lookupWithTargetOverride("bsp-forno/sync", "bsp-staging");
        expect(entry.operation.name).toBe("sync");
        expect(entry.operation.tool).toBe("http");
    });
});

// ─── list ─────────────────────────────────────────────────────────────────────

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

    it("filters by text (name, description, tags)", () => {
        const store = makeStore([
            makeConfig("bsp", ["bsp-forno"], [{ name: "sync" }, { name: "ping" }]),
        ]);
        const reg = new IntegrationOperationRegistry(store);
        expect(reg.list(undefined, "sync")).toHaveLength(1);
        expect(reg.list(undefined, "SYNC")).toHaveLength(1); // case-insensitive
        expect(reg.list(undefined, "missing")).toHaveLength(0);
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
