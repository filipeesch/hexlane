/**
 * Target schema tests — verifies all valid shapes parse correctly and
 * invalid configs are rejected before touching the file system or vault.
 */
import { describe, it, expect } from "vitest";
import { TargetConfigSchema } from "../schema.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parse(obj: unknown) {
    return TargetConfigSchema.parse(obj);
}

function safeParse(obj: unknown) {
    return TargetConfigSchema.safeParse(obj);
}

// ─── HTTP target ──────────────────────────────────────────────────────────────

describe("TargetConfigSchema — http tool", () => {
    it("parses a public http target (no credential)", () => {
        const result = parse({
            version: 1,
            target: {
                id: "github",
                app: "github",
                tool: "http",
                config: { base_url: "https://api.github.com" },
                credential: { kind: "public" },
            },
        });
        expect(result.target.id).toBe("github");
        expect(result.target.tool).toBe("http");
        expect(result.target.credential?.kind).toBe("public");
    });

    it("parses an authenticated http target with static api_token credential", () => {
        const result = parse({
            version: 1,
            target: {
                id: "my-app-api-prod",
                app: "my-app",
                tool: "http",
                config: { base_url: "https://api.myapp.com" },
                credential: {
                    kind: "api_token",
                    acquire_strategy: { kind: "static" },
                    auth: { kind: "bearer" },
                },
            },
        });
        expect(result.target.credential?.kind).toBe("api_token");
    });

    it("parses an http target with http acquire strategy", () => {
        const result = parse({
            version: 1,
            target: {
                id: "my-app-api-prod",
                app: "my-app",
                tool: "http",
                config: { base_url: "https://api.myapp.com" },
                credential: {
                    kind: "api_token",
                    acquire_strategy: {
                        kind: "http",
                        method: "POST",
                        url: "https://auth.myapp.com/token",
                        output_mapping: {
                            kind: "api_token",
                            token_path: "access_token",
                        },
                    },
                    renewal_policy: { ttl: 3600, renew_before_expiry: 300 },
                },
            },
        });
        expect(result.target.credential?.kind).toBe("api_token");
    });

    it("parses an http target with header auth injection", () => {
        const result = parse({
            version: 1,
            target: {
                id: "my-service-prod",
                app: "my-service",
                tool: "http",
                config: { base_url: "https://api.myservice.com" },
                credential: {
                    kind: "api_token",
                    acquire_strategy: { kind: "static" },
                    auth: { kind: "header", name: "X-Api-Key" },
                },
            },
        });
        if (result.target.credential?.kind === "api_token") {
            expect(result.target.credential.auth?.kind).toBe("header");
        }
    });

    it("parses an http target with no credential field at all", () => {
        const result = parse({
            version: 1,
            target: {
                id: "open-api",
                app: "open-api",
                tool: "http",
                config: { base_url: "https://api.open.com" },
            },
        });
        expect(result.target.credential).toBeUndefined();
    });

    it("defaults config to empty object when not specified", () => {
        const result = parse({
            version: 1,
            target: {
                id: "my-app",
                app: "my-app",
                tool: "http",
            },
        });
        expect(result.target.config).toEqual({});
    });
});

// ─── SQL target ───────────────────────────────────────────────────────────────

describe("TargetConfigSchema — sql tool", () => {
    it("parses a sql target with shell acquire strategy", () => {
        const result = parse({
            version: 1,
            target: {
                id: "my-app-db-prod",
                app: "my-app",
                tool: "sql",
                config: {
                    engine: "postgresql",
                    host: "db.myapp.com",
                    port: 5432,
                    dbname: "myapp",
                },
                credential: {
                    kind: "db_connection",
                    acquire_strategy: {
                        kind: "shell",
                        command: "vault-cli get-db-creds --env prod",
                        output_mapping: {
                            kind: "db_connection",
                            host_path: "hostname",
                            port_path: "port",
                            user_path: "username",
                            password_path: "password",
                            dbname_path: "database",
                        },
                    },
                    renewal_policy: { ttl: 172800, renew_before_expiry: 3600 },
                },
            },
        });
        expect(result.target.tool).toBe("sql");
        expect(result.target.credential?.kind).toBe("db_connection");
        expect(result.target.config["engine"]).toBe("postgresql");
    });

    it("parses a sql target with static db_connection credential", () => {
        const result = parse({
            version: 1,
            target: {
                id: "my-app-db-dev",
                app: "my-app",
                tool: "sql",
                config: { engine: "postgresql" },
                credential: {
                    kind: "db_connection",
                    acquire_strategy: { kind: "static" },
                },
            },
        });
        expect(result.target.credential?.kind).toBe("db_connection");
    });
});

// ─── Validation errors ────────────────────────────────────────────────────────

describe("TargetConfigSchema — validation errors", () => {
    it("rejects an id with uppercase characters", () => {
        const result = safeParse({
            version: 1,
            target: { id: "MyApp", app: "my-app", tool: "http" },
        });
        expect(result.success).toBe(false);
    });

    it("rejects an id with underscores", () => {
        const result = safeParse({
            version: 1,
            target: { id: "my_app", app: "my-app", tool: "http" },
        });
        expect(result.success).toBe(false);
    });

    it("rejects a missing tool field", () => {
        const result = safeParse({
            version: 1,
            target: { id: "my-app", app: "my-app" },
        });
        expect(result.success).toBe(false);
    });

    it("rejects version other than 1", () => {
        const result = safeParse({
            version: 2,
            target: { id: "my-app", app: "my-app", tool: "http" },
        });
        expect(result.success).toBe(false);
    });

    it("rejects an api_token credential with db_connection output_mapping", () => {
        const result = safeParse({
            version: 1,
            target: {
                id: "my-app",
                app: "my-app",
                tool: "http",
                credential: {
                    kind: "api_token",
                    acquire_strategy: {
                        kind: "shell",
                        command: "get-creds",
                        output_mapping: {
                            kind: "db_connection",  // wrong kind
                            host_path: "host",
                        },
                    },
                },
            },
        });
        expect(result.success).toBe(false);
    });
});
