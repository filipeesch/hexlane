import type { AppStore } from "../config/app-store.js";
import type { LoadedOperation } from "./schema.js";

export class OperationRegistry {
    private map: Map<string, LoadedOperation>;

    constructor(private readonly apps: AppStore) {
        this.map = this.load();
    }

    private load(): Map<string, LoadedOperation> {
        const result = new Map<string, LoadedOperation>();
        const appList = this.apps.list();

        for (const { id: appId } of appList) {
            let config;
            try {
                config = this.apps.get(appId);
            } catch {
                // Skip apps that fail to load rather than crashing the whole registry
                continue;
            }

            const operations = config.app.operations ?? [];
            for (const operation of operations) {
                const ref = `${appId}/${operation.name}`;
                if (result.has(ref)) {
                    throw new Error(
                        `Duplicate operation "${ref}": operation names must be unique within an app. ` +
                        `Found duplicate in app "${appId}".`
                    );
                }
                result.set(ref, { appId, operation, ref });
            }
        }

        return result;
    }

    /** Re-load from disk (call after app registry changes). */
    reload(): void {
        this.map = this.load();
    }

    /**
     * Look up an operation by qualified reference ("app-id/operation-name").
     * Throws a descriptive error if not found.
     */
    lookup(ref: string): LoadedOperation {
        const entry = this.map.get(ref);
        if (!entry) {
            const parts = ref.split("/");
            if (parts.length !== 2) {
                throw new Error(
                    `Invalid operation reference "${ref}". Use the format "app-id/operation-name" (e.g. payments-api/get-order).`
                );
            }
            const [appId, opName] = parts;
            // Suggest close matches
            const appOps = [...this.map.keys()].filter((k) => k.startsWith(`${appId}/`));
            const allOps = [...this.map.keys()];
            const candidates = appOps.length > 0 ? appOps : allOps.slice(0, 5);
            const hint = candidates.length > 0
                ? `\nAvailable operations: ${candidates.map((k) => `  ${k}`).join(", ")}`
                : "\nNo operations are registered. Add an 'operations:' key to an app config and re-register it.";
            throw new Error(`Operation "${appId}/${opName}" not found.${hint}`);
        }
        return entry;
    }

    /**
     * List operations, optionally filtered by app ID and/or a text search.
     * Text filter is case-insensitive and matches name, description, and tags.
     */
    list(appFilter?: string, textFilter?: string): LoadedOperation[] {
        let entries = [...this.map.values()];

        if (appFilter) {
            entries = entries.filter((e) => e.appId === appFilter);
        }

        if (textFilter) {
            const needle = textFilter.toLowerCase();
            entries = entries.filter((e) => {
                const op = e.operation;
                return (
                    op.name.toLowerCase().includes(needle) ||
                    (op.description ?? "").toLowerCase().includes(needle) ||
                    (op.tags ?? []).some((t) => t.toLowerCase().includes(needle))
                );
            });
        }

        return entries;
    }

    /** All loaded operations as a flat array. */
    all(): LoadedOperation[] {
        return [...this.map.values()];
    }
}
