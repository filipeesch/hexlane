/**
 * Core logic for adding and deleting operations in a registered app YAML.
 * Extracted from the CLI command so it can be unit-tested without running
 * Commander.
 */
import * as fs from "fs";
import * as yaml from "js-yaml";
import { OperationSchema, ToolOperationSchema } from "./schema.js";
import type { Operation, ToolOperation } from "./schema.js";

// ─── Param spec parsing ───────────────────────────────────────────────────────

export interface RawParam {
    name: string;
    type: string;
    required: boolean;
    description?: string;
}

/**
 * Parse a single `--param` spec string: `name:type:required:description`
 *
 * - `type` defaults to `"string"` when omitted.
 * - `required` is `true` unless the third part is `"optional"` (case-insensitive).
 * - `description` is everything after the third colon (colons allowed in description).
 *
 * @throws if `name` is empty.
 */
export function parseParamSpec(spec: string): RawParam {
    const parts = spec.split(":");
    const name = parts[0] ?? "";
    if (!name) throw new Error(`Invalid --param "${spec}": name is required`);
    const type = parts[1] ?? "string";
    const requiredStr = parts[2] ?? "required";
    const description = parts.length > 3 ? parts.slice(3).join(":") : undefined;
    return {
        name,
        type,
        required: requiredStr.toLowerCase() !== "optional",
        ...(description !== undefined && { description }),
    };
}

// ─── Operation building ────────────────────────────────────────────────────────

export interface BuildApiOperationOpts {
    kind: "api";
    name: string;
    method: string;
    path: string;
    body?: string;
    params?: RawParam[];
    profile?: string;
    defaultEnv?: string;
    tags?: string[];
    readOnly?: boolean;
    description?: string;
}

export interface BuildDbOperationOpts {
    kind: "db";
    name: string;
    sql: string;
    params?: RawParam[];
    profile?: string;
    defaultEnv?: string;
    tags?: string[];
    description?: string;
}

export type BuildOperationOpts = BuildApiOperationOpts | BuildDbOperationOpts;

/**
 * Build and validate an Operation from raw flag values.
 * Returns the Zod-parsed Operation on success, or throws a descriptive Error.
 */
export function buildOperation(opts: BuildOperationOpts): Operation {
    const parameters = opts.params ?? [];

    let raw: Record<string, unknown>;
    if (opts.kind === "api") {
        raw = {
            kind: "api",
            name: opts.name,
            ...(opts.description && { description: opts.description }),
            ...(opts.profile && { profile: opts.profile }),
            ...(opts.defaultEnv && { defaultEnv: opts.defaultEnv }),
            ...(opts.tags && opts.tags.length > 0 && { tags: opts.tags }),
            ...(opts.readOnly !== undefined && { readOnly: opts.readOnly }),
            parameters,
            execution: { method: opts.method.toUpperCase(), path: opts.path, ...(opts.body !== undefined && { body: opts.body }) },
        };
    } else {
        raw = {
            kind: "db",
            name: opts.name,
            ...(opts.description && { description: opts.description }),
            ...(opts.profile && { profile: opts.profile }),
            ...(opts.defaultEnv && { defaultEnv: opts.defaultEnv }),
            ...(opts.tags && opts.tags.length > 0 && { tags: opts.tags }),
            parameters,
            execution: { sql: opts.sql },
        };
    }

    const result = OperationSchema.safeParse(raw);
    if (!result.success) {
        const issues = result.error.issues.map((e) => `  ${e.path.join(".")}: ${e.message}`).join("\n");
        throw new Error(`Invalid operation:\n${issues}`);
    }
    return result.data;
}

// ─── YAML read/write helpers ───────────────────────────────────────────────────

function readAppYaml(configPath: string): Record<string, unknown> {
    return yaml.load(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
}

function writeAppYaml(configPath: string, raw: Record<string, unknown>): void {
    fs.writeFileSync(configPath, yaml.dump(raw, { lineWidth: 120, noRefs: true }), "utf8");
}

// ─── Public write operations ───────────────────────────────────────────────────

/**
 * Add an operation to a registered app YAML file.
 * Throws if an operation with the same name already exists.
 */
export function addOperationToFile(configPath: string, operation: Operation): void {
    const raw = readAppYaml(configPath);
    const app = raw["app"] as Record<string, unknown>;
    const ops = ((app["operations"] ?? []) as Array<Record<string, unknown>>);

    if (ops.some((op) => op["name"] === operation.name)) {
        throw new Error(
            `Operation "${operation.name}" already exists. Remove it first with: hexlane op delete <app>/${operation.name}`
        );
    }

    ops.push(operation as unknown as Record<string, unknown>);
    app["operations"] = ops;
    raw["app"] = app;
    writeAppYaml(configPath, raw);
}

/**
 * Remove an operation by name from a registered app YAML file.
 * Throws if no operation with that name exists.
 */
export function deleteOperationFromFile(configPath: string, opName: string): void {
    const raw = readAppYaml(configPath);
    const app = raw["app"] as Record<string, unknown>;
    const ops = ((app["operations"] ?? []) as Array<Record<string, unknown>>);

    const idx = ops.findIndex((op) => op["name"] === opName);
    if (idx < 0) {
        throw new Error(`Operation "${opName}" not found.`);
    }

    ops.splice(idx, 1);
    app["operations"] = ops;
    raw["app"] = app;
    writeAppYaml(configPath, raw);
}

// ─── Integration YAML helpers ─────────────────────────────────────────────────

function readIntegrationYaml(configPath: string): Record<string, unknown> {
    return yaml.load(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
}

function writeIntegrationYaml(configPath: string, raw: Record<string, unknown>): void {
    fs.writeFileSync(configPath, yaml.dump(raw, { lineWidth: 120, noRefs: true }), "utf8");
}

/**
 * Return the raw YAML text of a single operation from an integration config file.
 * Throws if the operation is not found.
 */
export function getIntegrationOperationYaml(configPath: string, opName: string): string {
    const raw = readIntegrationYaml(configPath);
    const integration = raw["integration"] as Record<string, unknown>;
    const ops = ((integration["operations"] ?? []) as Array<Record<string, unknown>>);
    const op = ops.find((o) => o["name"] === opName);
    if (!op) {
        throw new Error(`Operation "${opName}" not found in ${configPath}.`);
    }
    return yaml.dump(op, { lineWidth: 120, noRefs: true });
}

/**
 * Add a new operation to an integration YAML from a raw YAML string.
 * Validates against ToolOperationSchema before writing.
 * Throws on name collision or schema validation failure.
 */
export function addIntegrationOperationFromRaw(configPath: string, rawOpYaml: string): ToolOperation {
    let parsed: unknown;
    try {
        parsed = yaml.load(rawOpYaml);
    } catch (e: unknown) {
        throw new Error(`Invalid YAML: ${(e as Error).message}`);
    }

    const result = ToolOperationSchema.safeParse(parsed);
    if (!result.success) {
        const issues = result.error.issues.map((e) => `  ${e.path.join(".")}: ${e.message}`).join("\n");
        throw new Error(`Invalid operation:\n${issues}`);
    }
    const operation = result.data;

    const raw = readIntegrationYaml(configPath);
    const integration = raw["integration"] as Record<string, unknown>;
    const ops = ((integration["operations"] ?? []) as Array<Record<string, unknown>>);

    if (ops.some((op) => op["name"] === operation.name)) {
        throw new Error(
            `Operation "${operation.name}" already exists. Use 'hexlane op edit' to update it.`
        );
    }

    ops.push(operation as unknown as Record<string, unknown>);
    integration["operations"] = ops;
    raw["integration"] = integration;
    writeIntegrationYaml(configPath, raw);
    return operation;
}

/**
 * Replace an existing operation in an integration YAML from a raw YAML string.
 * Validates against ToolOperationSchema before writing.
 * Throws if the operation is not found or schema validation fails.
 */
export function editIntegrationOperation(configPath: string, opName: string, rawOpYaml: string): ToolOperation {
    let parsed: unknown;
    try {
        parsed = yaml.load(rawOpYaml);
    } catch (e: unknown) {
        throw new Error(`Invalid YAML: ${(e as Error).message}`);
    }

    const result = ToolOperationSchema.safeParse(parsed);
    if (!result.success) {
        const issues = result.error.issues.map((e) => `  ${e.path.join(".")}: ${e.message}`).join("\n");
        throw new Error(`Invalid operation:\n${issues}`);
    }
    const operation = result.data;

    const raw = readIntegrationYaml(configPath);
    const integration = raw["integration"] as Record<string, unknown>;
    const ops = ((integration["operations"] ?? []) as Array<Record<string, unknown>>);

    const idx = ops.findIndex((op) => op["name"] === opName);
    if (idx < 0) {
        throw new Error(`Operation "${opName}" not found in ${configPath}.`);
    }

    ops[idx] = operation as unknown as Record<string, unknown>;
    integration["operations"] = ops;
    raw["integration"] = integration;
    writeIntegrationYaml(configPath, raw);
    return operation;
}

/**
 * Delete an operation by name from an integration YAML file.
 * Throws if no operation with that name exists.
 */
export function deleteIntegrationOperation(configPath: string, opName: string): void {
    const raw = readIntegrationYaml(configPath);
    const integration = raw["integration"] as Record<string, unknown>;
    const ops = ((integration["operations"] ?? []) as Array<Record<string, unknown>>);

    const idx = ops.findIndex((op) => op["name"] === opName);
    if (idx < 0) {
        throw new Error(`Operation "${opName}" not found.`);
    }

    ops.splice(idx, 1);
    integration["operations"] = ops;
    raw["integration"] = integration;
    writeIntegrationYaml(configPath, raw);
}
