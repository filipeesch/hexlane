import type { IntegrationStore } from "../config/integration-store.js";
import type { ToolOperation } from "../operations/schema.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LoadedIntegrationOperation {
    integrationId: string;
    targetId: string;
    operation: ToolOperation;
    /** "target-id/op-name" — used with `op run` */
    targetRef: string;
    /** "integration-id/op-name" — used with `op list/delete` */
    integrationRef: string;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export class IntegrationOperationRegistry {
    private byTargetRef = new Map<string, LoadedIntegrationOperation>();
    private byIntegrationRef = new Map<string, LoadedIntegrationOperation>();

    constructor(store: IntegrationStore) {
        for (const entry of store.list()) {
            try {
                const config = store.get(entry.id);
                const integrationId = config.integration.id;
                const operations = config.integration.operations ?? [];
                const firstTargetId = config.integration.targets[0]?.id;

                for (const operation of operations) {
                    const targetId = operation.defaultTarget ?? firstTargetId;
                    if (!targetId) continue;

                    const targetRef = `${targetId}/${operation.name}`;
                    const integrationRef = `${integrationId}/${operation.name}`;

                    const loaded: LoadedIntegrationOperation = {
                        integrationId,
                        targetId,
                        operation,
                        targetRef,
                        integrationRef,
                    };

                    this.byTargetRef.set(targetRef, loaded);
                    this.byIntegrationRef.set(integrationRef, loaded);
                }
            } catch {
                // Skip integrations that fail to load
            }
        }
    }

    lookupByTargetRef(ref: string): LoadedIntegrationOperation {
        const entry = this.byTargetRef.get(ref);
        if (!entry) {
            throw new Error(`Operation "${ref}" not found. Use 'hexlane op list' to see available operations.`);
        }
        return entry;
    }

    lookupByIntegrationRef(ref: string): LoadedIntegrationOperation {
        const entry = this.byIntegrationRef.get(ref);
        if (!entry) {
            throw new Error(`Operation "${ref}" not found.`);
        }
        return entry;
    }

    hasTargetRef(ref: string): boolean {
        return this.byTargetRef.has(ref);
    }

    hasIntegrationRef(ref: string): boolean {
        return this.byIntegrationRef.has(ref);
    }

    list(integrationId?: string, filter?: string): LoadedIntegrationOperation[] {
        let entries = Array.from(this.byTargetRef.values());
        if (integrationId) {
            entries = entries.filter((e) => e.integrationId === integrationId);
        }
        if (filter) {
            const lc = filter.toLowerCase();
            entries = entries.filter(
                (e) =>
                    e.operation.name.toLowerCase().includes(lc) ||
                    (e.operation.description ?? "").toLowerCase().includes(lc) ||
                    (e.operation.tags ?? []).some((t) => t.toLowerCase().includes(lc))
            );
        }
        return entries;
    }
}
