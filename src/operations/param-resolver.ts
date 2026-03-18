import type { OperationParameter } from "./schema.js";

export type ResolvedParams = Record<string, string | number | boolean>;

/** Minimal interface used by resolveParams — works for both old (Operation) and new (ToolOperation) models. */
export interface OperationLike {
    name: string;
    parameters: OperationParameter[];
}

export class ParamValidationError extends Error {
    constructor(
        public readonly errors: string[],
        public readonly operation: OperationLike,
    ) {
        super(`Parameter validation failed for operation "${operation.name}":\n` + errors.map((e) => `  • ${e}`).join("\n"));
        this.name = "ParamValidationError";
    }
}

/**
 * Resolves, validates, and type-coerces raw CLI --param values against the
 * operation's declared parameters.
 *
 * Rich errors include the parameter name, type, description, and an example
 * --param invocation so both humans and coding agents can self-correct.
 */
export function resolveParams(
    operation: OperationLike,
    rawParams: Record<string, string>,
): ResolvedParams {
    const errors: string[] = [];
    const resolved: ResolvedParams = {};

    for (const param of operation.parameters) {
        const raw = rawParams[param.name];

        if (raw === undefined || raw === "") {
            if (param.required !== false) {
                errors.push(formatMissingError(param));
                continue;
            }
            // Optional with no provided value: skip (not included in resolved map)
            continue;
        }

        const coerced = coerce(raw, param);
        if (coerced instanceof CoercionError) {
            errors.push(formatCoercionError(param, raw, coerced.message));
            continue;
        }

        resolved[param.name] = coerced;
    }

    // Warn about unknown params passed from CLI (non-fatal, but worth knowing)
    const knownNames = new Set(operation.parameters.map((p) => p.name));
    for (const key of Object.keys(rawParams)) {
        if (!knownNames.has(key)) {
            errors.push(
                `Unknown parameter '${key}'. This operation does not declare a parameter with that name.`
            );
        }
    }

    if (errors.length > 0) {
        throw new ParamValidationError(errors, operation);
    }

    return resolved;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

class CoercionError extends Error { }

function coerce(raw: string, param: OperationParameter): string | number | boolean | CoercionError {
    switch (param.type) {
        case "string":
            return raw;
        case "integer": {
            const n = Number(raw);
            if (!Number.isInteger(n) || raw.trim() === "") {
                return new CoercionError(`expected an integer (e.g. 42), got "${raw}"`);
            }
            return n;
        }
        case "number": {
            const n = Number(raw);
            if (Number.isNaN(n) || raw.trim() === "") {
                return new CoercionError(`expected a number (e.g. 3.14), got "${raw}"`);
            }
            return n;
        }
        case "boolean": {
            const lower = raw.toLowerCase();
            if (lower === "true" || lower === "1" || lower === "yes") return true;
            if (lower === "false" || lower === "0" || lower === "no") return false;
            return new CoercionError(`expected a boolean (true/false), got "${raw}"`);
        }
        default:
            return raw;
    }
}

function formatMissingError(param: OperationParameter): string {
    const typePart = `(${param.type})`;
    const descPart = param.description ? `: ${param.description}` : "";
    const example = buildExample(param);
    return `Missing required parameter '${param.name}' ${typePart}${descPart}. Example: --param ${example}`;
}

function formatCoercionError(param: OperationParameter, raw: string, reason: string): string {
    const descPart = param.description ? `: ${param.description}` : "";
    const example = buildExample(param);
    return `Invalid value for '${param.name}' (${param.type})${descPart} — ${reason}. Example: --param ${example}`;
}

function buildExample(param: OperationParameter): string {
    switch (param.type) {
        case "integer": return `${param.name}=42`;
        case "number": return `${param.name}=3.14`;
        case "boolean": return `${param.name}=true`;
        default: return `${param.name}=<value>`;
    }
}
