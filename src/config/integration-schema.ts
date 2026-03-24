import { z } from "zod";
import { StrategySchema, AuthSchema, RenewalPolicySchema } from "./schema.js";
import { ToolOperationSchema } from "../operations/schema.js";

// ─── Target Credential ────────────────────────────────────────────────────────

const PublicCredentialSchema = z.object({
    kind: z.literal("public"),
});

const ApiTokenCredentialSchema = z.object({
    kind: z.literal("api_token"),
    acquire_strategy: StrategySchema,
    auth: AuthSchema.optional(),
    renewal_policy: RenewalPolicySchema.optional(),
}).refine(
    (c) => {
        if (c.acquire_strategy.kind === "static") return true;
        return (c.acquire_strategy as { output_mapping: { kind: string } }).output_mapping.kind === "api_token";
    },
    { message: "output_mapping.kind must be 'api_token' for api_token credentials" }
);

const DbConnectionCredentialSchema = z.object({
    kind: z.literal("db_connection"),
    acquire_strategy: StrategySchema,
    renewal_policy: RenewalPolicySchema.optional(),
}).refine(
    (c) => {
        if (c.acquire_strategy.kind === "static") return true;
        return (c.acquire_strategy as { output_mapping: { kind: string } }).output_mapping.kind === "db_connection";
    },
    { message: "output_mapping.kind must be 'db_connection' for db_connection credentials" }
);

export const IntegrationTargetCredentialSchema = z.discriminatedUnion("kind", [
    PublicCredentialSchema,
    ApiTokenCredentialSchema,
    DbConnectionCredentialSchema,
]);

// ─── Target Tool ──────────────────────────────────────────────────────────────

export const TargetToolSchema = z.object({
    type: z.enum(["http", "sql", "fs"]),
    config: z.record(z.string(), z.unknown()).default({}),
    credential: IntegrationTargetCredentialSchema.optional(),
});

// ─── Target ───────────────────────────────────────────────────────────────────

export const IntegrationTargetSchema = z.object({
    id: z.string().min(1).regex(/^[a-z0-9-]+$/, "Target ID must be lowercase alphanumeric with dashes"),
    params: z.record(z.string(), z.string()).optional(),
    tools: z.array(TargetToolSchema).min(1),
});

// ─── Integration Config ───────────────────────────────────────────────────────

export const IntegrationConfigSchema = z.object({
    version: z.literal(1),
    integration: z.object({
        id: z.string().min(1).regex(/^[a-z0-9-]+$/, "Integration ID must be lowercase alphanumeric with dashes"),
        description: z.string().optional(),
        defaultTarget: z.string().optional(),
        targets: z.array(IntegrationTargetSchema).min(1),
        operations: z.array(ToolOperationSchema).optional(),
    }),
});

export type IntegrationConfig = z.infer<typeof IntegrationConfigSchema>;
export type IntegrationTarget = z.infer<typeof IntegrationTargetSchema>;
export type TargetTool = z.infer<typeof TargetToolSchema>;
export type IntegrationTargetCredential = z.infer<typeof IntegrationTargetCredentialSchema>;
export type ApiTokenCredential = z.infer<typeof ApiTokenCredentialSchema>;
export type DbConnectionCredential = z.infer<typeof DbConnectionCredentialSchema>;
