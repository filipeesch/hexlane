import { z } from "zod";
import {
    StrategySchema,
    AuthSchema,
    RenewalPolicySchema,
} from "../config/schema.js";

// ─── Target Credential ────────────────────────────────────────────────────────
// Replaces the profile concept. A target owns exactly one credential (or none
// for public targets). The credential kind drives vault storage and resolution.

const TargetPublicCredentialSchema = z.object({
    kind: z.literal("public"),
});

const TargetApiTokenCredentialSchema = z.object({
    kind: z.literal("api_token"),
    acquire_strategy: StrategySchema,
    // How the token is injected into requests. Defaults to Bearer if omitted.
    auth: AuthSchema.optional(),
    renewal_policy: RenewalPolicySchema.optional(),
}).refine(
    (c) => {
        if (c.acquire_strategy.kind === "static") return true;
        return (c.acquire_strategy as { output_mapping: { kind: string } }).output_mapping.kind === "api_token";
    },
    { message: "output_mapping.kind must be 'api_token'" },
);

const TargetDbConnectionCredentialSchema = z.object({
    kind: z.literal("db_connection"),
    acquire_strategy: StrategySchema,
    renewal_policy: RenewalPolicySchema.optional(),
}).refine(
    (c) => {
        if (c.acquire_strategy.kind === "static") return true;
        return (c.acquire_strategy as { output_mapping: { kind: string } }).output_mapping.kind === "db_connection";
    },
    { message: "output_mapping.kind must be 'db_connection'" },
);

export const TargetCredentialSchema = z.discriminatedUnion("kind", [
    TargetPublicCredentialSchema,
    TargetApiTokenCredentialSchema,
    TargetDbConnectionCredentialSchema,
]);

export type TargetCredential = z.infer<typeof TargetCredentialSchema>;
export type TargetPublicCredential = z.infer<typeof TargetPublicCredentialSchema>;
export type TargetApiTokenCredential = z.infer<typeof TargetApiTokenCredentialSchema>;
export type TargetDbConnectionCredential = z.infer<typeof TargetDbConnectionCredentialSchema>;

// ─── Target Config ────────────────────────────────────────────────────────────
// A target is a named, registered instance of a tool pointing at a specific
// system (an API, a database, a file root, etc.).
//
//   id          — unique name used in CLI: op run <id>/<op-name>, http call <id>
//   app         — app spec ID that owns operations for this target
//   tool        — tool type: "http" | "sql" | (future: "kafka" | "fs" | ...)
//   config      — tool-specific config (each tool validates its own required keys)
//   credential  — how hexlane acquires the secret for this target (optional for public)

export const TargetConfigSchema = z.object({
    version: z.literal(1),
    target: z.object({
        id: z.string().min(1).regex(
            /^[a-z0-9-]+$/,
            "Target ID must be lowercase alphanumeric with dashes",
        ),
        description: z.string().optional(),
        app: z.string().min(1).regex(
            /^[a-z0-9-]+$/,
            "App ID must be lowercase alphanumeric with dashes",
        ),
        tool: z.string().min(1),
        // Tool-specific config: base_url for http, engine/host/dbname for sql, etc.
        // Each tool validates required keys at runtime.
        config: z.record(z.string(), z.unknown()).default({}),
        credential: TargetCredentialSchema.optional(),
    }),
});

export type TargetConfig = z.infer<typeof TargetConfigSchema>;
export type TargetBlock = TargetConfig["target"];
