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
    /** integrationId → set of valid target IDs for that integration */
    private targetsByIntegration = new Map<string, Set<string>>();

    constructor(store: IntegrationStore) {
        for (const entry of store.list()) {
            try {
                const config = store.get(entry.id);
                const integrationId = config.integration.id;
                const operations = config.integration.operations ?? [];
                const firstTargetId = config.integration.targets[0]?.id;

                // Record all targets for this integration for runtime override validation
                this.targetsByIntegration.set(
                    integrationId,
                    new Set(config.integration.targets.map((t) => t.id)),
                );

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

    /**
     * Look up an operation by `<target-id>/<op-name>`.
     *
     * If no exact match is found, it attempts a target-override fallback:
     * it searches for an operation named `<op-name>` whose integration also
     * owns `<target-id>` as a valid target, allowing any target in the same
     * integration to be used at runtime instead of the default.
     */
    lookupByTargetRef(ref: string): LoadedIntegrationOperation {
        const direct = this.byTargetRef.get(ref);
        if (direct) return direct;

        // Fallback: candidate is "<targetId>/<opName>" where targetId is an
        // alternate (non-default) target in the same integration.
        const slash = ref.lastIndexOf("/");
        if (slash < 1) {
            throw new Error(`Operation "${ref}" not found. Use 'hexlane op list' to see available operations.`);
        }
        const candidateTargetId = ref.slice(0, slash);
        const opName = ref.slice(slash + 1);

        const matches = Array.from(this.byIntegrationRef.values()).filter(
            (e) =>
                e.operation.name === opName &&
                (this.targetsByIntegration.get(e.integrationId)?.has(candidateTargetId) ?? false),
        );

        if (matches.length === 1) {
            const base = matches[0]!;
            return {
                ...base,
                targetId: candidateTargetId,
                targetRef: ref,
            };
        }

        if (matches.length > 1) {
            const ids = matches.map((m) => m.integrationId).join(", ");
            throw new Error(
                `Ambiguous: operation "${opName}" with target "${candidateTargetId}" exists in multiple integrations (${ids}). ` +
                `Use --target flag with an integration-scoped ref instead.`,
            );
        }

        throw new Error(`Operation "${ref}" not found. Use 'hexlane op list' to see available operations.`);
    }

    /**
     * Look up an operation by ref, then override the executing target.
     * The ref may be either a targetRef (`<target-id>/<op-name>`) or an
     * integrationRef (`<integration-id>/<op-name>`). The `targetOverride`
     * must be a valid target within the resolved operation's integration.
     */
    lookupWithTargetOverride(ref: string, targetOverride: string): LoadedIntegrationOperation {
        // Try targetRef first, then integrationRef
        let base: LoadedIntegrationOperation | undefined = this.byTargetRef.get(ref) ?? this.byIntegrationRef.get(ref);

        if (!base) {
            // Try the fallback resolution (alternate target ref) and then re-key by override
            const slash = ref.lastIndexOf("/");
            if (slash > 0) {
                const opName = ref.slice(slash + 1);
                const candidate = Array.from(this.byIntegrationRef.values()).find(
                    (e) => e.operation.name === opName,
                );
                if (candidate) base = candidate;
            }
        }

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

        return {
            ...base,
            targetId: targetOverride,
            targetRef: `${targetOverride}/${base.operation.name}`,
        };
    }

    lookupByIntegrationRef(ref: string): LoadedIntegrationOperation {
        const entry = this.byIntegrationRef.get(ref);
        if (!entry) {
            throw new Error(`Operation "${ref}" not found.`);
        }
        return entry;
    }

    hasTargetRef(ref: string): boolean {
        // Also accept alternate-target refs via the fallback resolution
        if (this.byTargetRef.has(ref)) return true;
        const slash = ref.lastIndexOf("/");
        if (slash < 1) return false;
        const candidateTargetId = ref.slice(0, slash);
        const opName = ref.slice(slash + 1);
        return Array.from(this.byIntegrationRef.values()).some(
            (e) =>
                e.operation.name === opName &&
                (this.targetsByIntegration.get(e.integrationId)?.has(candidateTargetId) ?? false),
        );
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
