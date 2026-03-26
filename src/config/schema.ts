import { z } from "zod";

// ─── Output Mapping ──────────────────────────────────────────────────────────

const ApiTokenMappingSchema = z.object({
    kind: z.literal("api_token"),
    token_path: z.string(),
    expires_at_path: z.string().optional(),
    error_path: z.string().optional(),
    trace_id_path: z.string().optional(),
});

const DbConnectionMappingSchema = z.object({
    kind: z.literal("db_connection"),
    // Dynamic paths (extracted from strategy output)
    host_path: z.string().optional(),
    port_path: z.string().optional(),
    user_path: z.string().optional(),
    password_path: z.string().optional(),
    dbname_path: z.string().optional(),
    auth_token_path: z.string().optional(),
    expires_at_path: z.string().optional(),
    lease_id_path: z.string().optional(),
    // When the entire output is a single raw string (e.g. AWS RDS auth token)
    auth_token_value: z.literal("raw").optional(),
    // Static overrides (used when strategy doesn't output connection metadata)
    host: z.string().optional(),
    port: z.number().int().optional(),
    user: z.string().optional(),
    dbname: z.string().optional(),
    ssl_mode: z.enum(["disable", "require", "verify-full"]).optional(),
    // Array unwrap: strategy output is [{...}] — unwrap to first element
    unwrap_array: z.boolean().optional(),
    error_path: z.string().optional(),
    trace_id_path: z.string().optional(),
});

const OutputMappingSchema = z.discriminatedUnion("kind", [
    ApiTokenMappingSchema,
    DbConnectionMappingSchema,
]);

// ─── Strategies ──────────────────────────────────────────────────────────────

const ShellStrategySchema = z.object({
    kind: z.literal("shell"),
    command: z.string().min(1),
    output_mapping: OutputMappingSchema,
});

const HttpStrategySchema = z.object({
    kind: z.literal("http"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
    output_mapping: OutputMappingSchema,
});

// Static strategy — token is stored in the vault via `hexlane credential set`.
// No acquisition happens automatically; the token must be pre-loaded.
const StaticStrategySchema = z.object({
    kind: z.literal("static"),
});

export const StrategySchema = z.discriminatedUnion("kind", [
    ShellStrategySchema,
    HttpStrategySchema,
    StaticStrategySchema,
]);

// ─── Auth Injection ──────────────────────────────────────────────────────────
// Controls how the token is injected into outgoing API requests.
// Defaults to Bearer if omitted.

const BearerAuthSchema = z.object({
    kind: z.literal("bearer"),
});

const HeaderAuthSchema = z.object({
    kind: z.literal("header"),
    name: z.string().min(1),  // e.g. "X-Api-Key"
});

const QueryParamAuthSchema = z.object({
    kind: z.literal("query_param"),
    name: z.string().min(1),  // e.g. "api_key"
});

export const AuthSchema = z.discriminatedUnion("kind", [
    BearerAuthSchema,
    HeaderAuthSchema,
    QueryParamAuthSchema,
]);

// ─── Renewal Policy ──────────────────────────────────────────────────────────

export const RenewalPolicySchema = z.object({
    // Mandatory when strategy output has no parseable expiry
    ttl: z.number().int().positive().optional(),
    // Seconds before expiry to trigger proactive renewal (default: 300)
    renew_before_expiry: z.number().int().nonnegative().default(300),
}).refine(
    (p) => p.ttl !== undefined || p.renew_before_expiry !== undefined,
    { message: "renewal_policy must define at least ttl" }
);

// ─── Profile ─────────────────────────────────────────────────────────────────
// Used internally by the credential resolver (resolveForTarget constructs a
// synthetic AuthenticatedProfile from IntegrationTargetCredential).

const PublicProfileSchema = z.object({
    name: z.string().min(1).regex(/^[a-z0-9-]+$/, "Profile name must be lowercase alphanumeric with dashes"),
    kind: z.literal("public"),
});

const AuthenticatedProfileSchema = z.object({
    name: z.string().min(1).regex(/^[a-z0-9-]+$/, "Profile name must be lowercase alphanumeric with dashes"),
    kind: z.enum(["api_token", "db_connection"]),
    acquire_strategy: StrategySchema,
    // auth controls how the token is injected into requests (api_token only).
    auth: AuthSchema.optional(),
    // renewal_policy is optional for static profiles (token has no auto-renewal).
    renewal_policy: RenewalPolicySchema.optional(),
}).refine(
    (p) => {
        if (p.acquire_strategy.kind === "static") return true;
        return (p.acquire_strategy as { output_mapping: { kind: string } }).output_mapping.kind === p.kind;
    },
    { message: "output_mapping.kind must match profile kind" }
);

const ProfileSchema = z.union([PublicProfileSchema, AuthenticatedProfileSchema]);

export type Strategy = z.infer<typeof StrategySchema>;
export type ShellStrategy = z.infer<typeof ShellStrategySchema>;
export type HttpStrategy = z.infer<typeof HttpStrategySchema>;
export type StaticStrategy = z.infer<typeof StaticStrategySchema>;
export type Auth = z.infer<typeof AuthSchema>;
export type OutputMapping = z.infer<typeof OutputMappingSchema>;
export type ApiTokenMapping = z.infer<typeof ApiTokenMappingSchema>;
export type DbConnectionMapping = z.infer<typeof DbConnectionMappingSchema>;
export type RenewalPolicy = z.infer<typeof RenewalPolicySchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type PublicProfile = z.infer<typeof PublicProfileSchema>;
export type AuthenticatedProfile = z.infer<typeof AuthenticatedProfileSchema>;
