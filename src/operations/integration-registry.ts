import type { IntegrationStore } from "../config/integration-store.js";
import type { ToolOperation } from "../operations/schema.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LoadedIntegrationOperation {
    integrationId: string;
    /** Resolved default target ID from integration.defaultTarget, or undefined */
    targetId: string | undefined;
    operation: ToolOperation;
    /** "integration-id/op-name" */
    integrationRef: string;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export class IntegrationOperationRegistry {
    private byIntegrationRef = new Map<string, LoadedIntegrationOperation>();
    /** integrationId → set of valid target IDs */
    private targetsByIntegration = new Map<string, Set<string>>();
    /** integrationId → toolType → targetIds[] */
    private compatibleTargets = new Map<string, Map<string, string[]>>();

    constructor(store: IntegrationStore) {
        for (const entry of store.list()) {
            try {
                const config = store.get(entry.id);
                const integrationId = config.integration.id;
                const operations = config.integration.operations ?? [];
                const integrationDefaultTarget = config.integration.defaultTarget;

                this.targetsByIntegration.set(
                    integrationId,
                    new Set(config.integration.targets.map((t) => t.id)),
                );

                // Build tool → targetIds map for this integration
                const toolTargetMap = new Map<string, string[]>();
                for (const target of config.integration.targets) {
                    for (const tool of target.tools) {
                        if (!toolTargetMap.has(tool.type)) toolTargetMap.set(tool.type, []);
                        toolTargetMap.get(tool.type)!.push(target.id);
                    }
                }
                this.compatibleTargets.set(integrationId, toolTargetMap);

                for (const operation of operations) {
                    const integrationRef = `${integrationId}/${operation.name}`;
                    const loaded: LoadedIntegrationOperation = {
                        integrationId,
                        targetId: integrationDefaultTarget,
                        operation,
                        integrationRef,
                    };
                    this.byIntegrationRef.set(integrationRef, loaded);
                }
            } catch {
                // Skip integrations that fail to load
            }
        }
    }

    lookupByIntegrationRef(ref: string): LoadedIntegrationOperation {
        const entry = this.byIntegrationRef.get(ref);
        if (!entry) {
            throw new Error(`Operation "${ref}" not found. Use 'hexlane op list' to see available operations.`);
        }
        return entry;
    }

    /**
     * Look up an operation by integrationRef and override the executing target.
     * The targetOverride must be a valid target within the resolved operation's integration.
     */
    lookupWithTargetOverride(ref: string, targetOverride: string): LoadedIntegrationOperation {
        const base = this.byIntegrationRef.get(ref);
        if (!base) {
            throw new Error(`Operation "${ref}" not found. Use 'hexlane op list' to see available operations.`);
        }

        const validTargets = this.targetsByIntegration.get(base.integrationId);
        if (!validTargets?.has(targetOverride)) {
            const list = validTargets ? [...validTargets].join(", ") : "(none)";
            throw new Error(
                `Target "${targetOverride}" is not part of integration "${base.integrationId}". ` +
                `Valid targets: ${list}`,
            );
        }

        return { ...base, targetId: targetOverride };
    }

    hasIntegrationRef(ref: string): boolean {
        return this.byIntegrationRef.has(ref);
    }

    /** Returns target IDs within an integration that support the given tool type */
    getCompatibleTargets(integrationId: string, toolType: string): string[] {
        return this.compatibleTargets.get(integrationId)?.get(toolType) ?? [];
    }

    list(integrationId?: string, filter?: string): LoadedIntegrationOperation[] {
        let entries = Array.from(this.byIntegrationRef.values());
        if (integrationId) {
            entries = entries.filter((e) => e.integrationId === integrationId);
        }
        if (filter) {
            const lc = filter.toLowerCase();
            entries = entries.filter(
                (e) =>
                    e.integrationRef.toLowerCase().includes(lc) ||
                    e.operation.name.toLowerCase().includes(lc) ||
                    e.operation.tool.toLowerCase().includes(lc) ||
                    (e.operation.description ?? "").toLowerCase().includes(lc) ||
                    (e.operation.tags ?? []).some((t) => t.toLowerCase().includes(lc))
            );
        }
        return entries;
    }
}
