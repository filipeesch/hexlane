import { z } from "zod";

// ─── Parameter ───────────────────────────────────────────────────────────────

export const OperationParameterSchema = z.object({
    name: z.string().min(1).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "Parameter name must be alphanumeric/underscore"),
    type: z.enum(["string", "integer", "number", "boolean"]).default("string"),
    required: z.boolean().default(true),
    description: z.string().optional(),
});

export type OperationParameter = z.infer<typeof OperationParameterSchema>;

// ─── Execution ────────────────────────────────────────────────────────────────

export const ApiExecutionSchema = z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().min(1),
    query: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
});

export const DbExecutionSchema = z.object({
    sql: z.string().min(1),
});

export type ApiExecution = z.infer<typeof ApiExecutionSchema>;
export type DbExecution = z.infer<typeof DbExecutionSchema>;

// ─── Example ─────────────────────────────────────────────────────────────────

export const OperationExampleSchema = z.object({
    description: z.string(),
    command: z.string(),
});

export type OperationExample = z.infer<typeof OperationExampleSchema>;

// ─── Operation (discriminated union on kind) ─────────────────────────────────

const OperationBaseSchema = z.object({
    name: z.string().min(1).regex(/^[a-z0-9-]+$/, "Operation name must be lowercase alphanumeric with dashes"),
    description: z.string().optional(),
    profile: z.string().optional(),
    defaultEnv: z.string().optional(),
    tags: z.array(z.string()).optional(),
    parameters: z.array(OperationParameterSchema).default([]),
    examples: z.array(OperationExampleSchema).optional(),
});

export const ApiOperationSchema = OperationBaseSchema.extend({
    kind: z.literal("api"),
    readOnly: z.boolean().optional(),
    execution: ApiExecutionSchema,
});

export const DbOperationSchema = OperationBaseSchema.extend({
    kind: z.literal("db"),
    readOnly: z.boolean().default(true),
    execution: DbExecutionSchema,
});

export const OperationSchema = z.discriminatedUnion("kind", [
    ApiOperationSchema,
    DbOperationSchema,
]);

export type ApiOperation = z.infer<typeof ApiOperationSchema>;
export type DbOperation = z.infer<typeof DbOperationSchema>;
export type Operation = z.infer<typeof OperationSchema>;

// ─── Loaded operation (operation + its parent app id) ────────────────────────

export interface LoadedOperation {
    appId: string;
    operation: Operation;
    /** Qualified reference: "appId/name" */
    ref: string;
}

// ─── New operations (discriminated union on tool) ─────────────────────────────
// These replace the kind-based operations above. Operations reference a `tool`
// instead of a `kind`, and the `defaultTarget` field replaces `defaultEnv` +
// `profile`. The old kind-based types are preserved for backward compatibility
// while the migration is in progress.

const NewOperationBaseSchema = z.object({
    name: z.string().min(1).regex(/^[a-z0-9-]+$/, "Operation name must be lowercase alphanumeric with dashes"),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    parameters: z.array(OperationParameterSchema).default([]),
    examples: z.array(OperationExampleSchema).optional(),
});

export const HttpOperationSchema = NewOperationBaseSchema.extend({
    tool: z.literal("http"),
    readOnly: z.boolean().optional(),
    execution: ApiExecutionSchema,
});

export const SqlOperationSchema = NewOperationBaseSchema.extend({
    tool: z.literal("sql"),
    readOnly: z.boolean().default(true),
    execution: DbExecutionSchema,
});

export const ToolOperationSchema = z.discriminatedUnion("tool", [
    HttpOperationSchema,
    SqlOperationSchema,
]);

export type HttpOperation = z.infer<typeof HttpOperationSchema>;
export type SqlOperation = z.infer<typeof SqlOperationSchema>;
export type ToolOperation = z.infer<typeof ToolOperationSchema>;

// ─── Loaded tool operation (operation + its parent app id) ───────────────────

export interface LoadedToolOperation {
    appId: string;
    operation: ToolOperation;
    /** Qualified reference: "appId/name" */
    ref: string;
}
