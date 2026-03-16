import type { AppStore } from "../config/app-store.js";
import type { Operation } from "./schema.js";
import { extractTemplateVars } from "./renderer.js";

export interface ValidationResult {
    valid: boolean;
    errors: string[];
}

/**
 * Cross-reference validation for a single operation after Zod structural
 * parsing has already succeeded. Catches semantic errors that Zod cannot:
 * - readOnly: false on db operations (hard blocked in v1)
 * - Duplicate parameter names
 * - Profile referenced in op.profile not present in the app config
 * - Template variables in path/body/sql that don't match declared params
 */
export function validateOperation(
    appId: string,
    operation: Operation,
    apps: AppStore,
): ValidationResult {
    const errors: string[] = [];

    // 1. Block readOnly:false on DB operations in v1
    if (operation.kind === "db" && operation.readOnly === false) {
        errors.push(
            `DB operation "${operation.name}" has readOnly: false. ` +
            `Write DB operations are not supported in v1. Remove readOnly: false or set readOnly: true.`
        );
    }

    // 2. Duplicate parameter names
    const seen = new Set<string>();
    for (const param of operation.parameters) {
        if (seen.has(param.name)) {
            errors.push(`Duplicate parameter name "${param.name}" in operation "${operation.name}".`);
        }
        seen.add(param.name);
    }

    // 3. If profile is specified, verify it exists in the app config for at least one env
    if (operation.profile) {
        try {
            const config = apps.get(appId);
            const profileExists = config.app.environments.some((env) =>
                env.profiles.some((p) => p.name === operation.profile)
            );
            if (!profileExists) {
                errors.push(
                    `Operation "${operation.name}" references profile "${operation.profile}" ` +
                    `which does not exist in any environment of app "${appId}".`
                );
            }
        } catch {
            errors.push(`App "${appId}" could not be loaded to validate profile reference.`);
        }
    }

    // 4. Template variable validation — vars in templates must be declared params
    const paramNames = new Set(operation.parameters.map((p) => p.name));

    const templateStrings: Array<{ label: string; template: string }> = [];

    if (operation.kind === "api") {
        templateStrings.push({ label: "execution.path", template: operation.execution.path });
        if (operation.execution.body) {
            templateStrings.push({ label: "execution.body", template: operation.execution.body });
        }
        if (operation.execution.headers) {
            for (const [key, val] of Object.entries(operation.execution.headers)) {
                templateStrings.push({ label: `execution.headers.${key}`, template: val });
            }
        }
    } else {
        templateStrings.push({ label: "execution.sql", template: operation.execution.sql });
    }

    for (const { label, template } of templateStrings) {
        const vars = extractTemplateVars(template);
        for (const varName of vars) {
            if (!paramNames.has(varName)) {
                errors.push(
                    `Template variable "{{ ${varName} }}" in ${label} is not declared as a parameter of operation "${operation.name}".`
                );
            }
        }
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Validate all operations in an app config. Returns an array of results
 * (one per operation), including the operation name for reporting.
 */
export function validateAllOperations(
    appId: string,
    operations: Operation[],
    apps: AppStore,
): Array<ValidationResult & { name: string }> {
    return operations.map((op) => ({
        name: op.name,
        ...validateOperation(appId, op, apps),
    }));
}
