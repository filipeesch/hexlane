/**
 * Tests for the HTTP tool executor.
 *
 * Covers: URL construction, auth injection (bearer/header/query_param),
 * public (no-auth) calls, response body parsing, and the response envelope shape.
 *
 * `fetch` is stubbed globally per test — no real network calls.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { executeHttpCall, validateHttpConfig } from "../executor.js";
import type { HttpCallOptions } from "../executor.js";
import type { VaultManager } from "../../../vault/vault-manager.js";
import type { CredentialRecord } from "../../../metadata/store.js";
import type { AuditLogger } from "../../../audit/logger.js";
import type { ApiTokenSecret } from "../../../vault/types.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────

function makeVault(token: string): VaultManager {
    const secret: ApiTokenSecret = { kind: "api_token", token };
    return { read: vi.fn().mockReturnValue(secret) } as unknown as VaultManager;
}

function makeCredential(vaultRef = "ref-1"): CredentialRecord {
    return {
        id: "cred-1",
        app: "my-app",
        env: "production",
        profile: "default",
        vault_ref: vaultRef,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    } as CredentialRecord;
}

const audit: AuditLogger = { log: vi.fn() } as unknown as AuditLogger;

function mockFetch(status: number, body: unknown, contentType = "application/json"): Mock {
    const mockHeaders = new Map([["content-type", contentType]]);
    const mockResponse = {
        status,
        ok: status >= 200 && status < 300,
        headers: {
            get: (key: string) => mockHeaders.get(key) ?? null,
            forEach: (cb: (value: string, key: string) => void) => {
                mockHeaders.forEach((v, k) => cb(v, k));
            },
        },
        json: vi.fn().mockResolvedValue(body),
        text: vi.fn().mockResolvedValue(String(body)),
    };
    const fetchMock = vi.fn().mockResolvedValue(mockResponse);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

beforeEach(() => {
    vi.restoreAllMocks();
});

// ─── URL construction ─────────────────────────────────────────────────────────

describe("executeHttpCall — URL construction", () => {
    it("concatenates base_url and path correctly", async () => {
        const fetchMock = mockFetch(200, { id: 1 });
        const vault = makeVault("tok");
        const cred = makeCredential();

        const opts: HttpCallOptions = {
            method: "GET",
            path: "/orders/123",
            baseUrl: "https://api.myapp.com",
        };

        await executeHttpCall(vault, cred, audit, opts);

        const calledUrl = (fetchMock.mock.calls[0] as [string])[0];
        expect(calledUrl).toContain("https://api.myapp.com/orders/123");
    });

    it("handles trailing slash on base_url and leading slash on path", async () => {
        const fetchMock = mockFetch(200, {});
        const vault = makeVault("tok");

        await executeHttpCall(vault, makeCredential(), audit, {
            method: "GET",
            path: "/users/1",
            baseUrl: "https://api.myapp.com/",
        });

        const calledUrl = (fetchMock.mock.calls[0] as [string])[0];
        expect(calledUrl).not.toContain("//users");
        expect(calledUrl).toContain("/users/1");
    });

    it("appends query params to the URL", async () => {
        const fetchMock = mockFetch(200, []);
        const vault = makeVault("tok");

        await executeHttpCall(vault, makeCredential(), audit, {
            method: "GET",
            path: "/issues",
            baseUrl: "https://api.github.com",
            query: { state: "open", per_page: "10" },
        });

        const calledUrl = (fetchMock.mock.calls[0] as [string])[0];
        expect(calledUrl).toContain("state=open");
        expect(calledUrl).toContain("per_page=10");
    });

    it("omits empty string query param values", async () => {
        const fetchMock = mockFetch(200, []);
        const vault = makeVault("tok");

        await executeHttpCall(vault, makeCredential(), audit, {
            method: "GET",
            path: "/issues",
            baseUrl: "https://api.github.com",
            query: { state: "open", labels: "" },  // labels is empty — should be omitted
        });

        const calledUrl = (fetchMock.mock.calls[0] as [string])[0];
        expect(calledUrl).toContain("state=open");
        expect(calledUrl).not.toContain("labels");
    });
});

// ─── Auth injection ───────────────────────────────────────────────────────────

describe("executeHttpCall — auth injection", () => {
    it("injects Authorization: Bearer <token> by default (no auth config)", async () => {
        const fetchMock = mockFetch(200, {});
        const vault = makeVault("my-secret-token");

        await executeHttpCall(vault, makeCredential(), audit, {
            method: "GET",
            path: "/resource",
            baseUrl: "https://api.myapp.com",
            // no auth — defaults to bearer
        });

        const requestInit = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
        expect((requestInit.headers as Record<string, string>)["Authorization"]).toBe("Bearer my-secret-token");
    });

    it("injects Authorization: Bearer when auth.kind is bearer", async () => {
        const fetchMock = mockFetch(200, {});
        const vault = makeVault("jwt-token");

        await executeHttpCall(vault, makeCredential(), audit, {
            method: "GET",
            path: "/resource",
            baseUrl: "https://api.myapp.com",
            auth: { kind: "bearer" },
        });

        const requestInit = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
        expect((requestInit.headers as Record<string, string>)["Authorization"]).toBe("Bearer jwt-token");
    });

    it("injects a custom header when auth.kind is header", async () => {
        const fetchMock = mockFetch(200, {});
        const vault = makeVault("raw-api-key");

        await executeHttpCall(vault, makeCredential(), audit, {
            method: "GET",
            path: "/resource",
            baseUrl: "https://api.myapp.com",
            auth: { kind: "header", name: "X-Api-Key" },
        });

        const requestInit = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
        expect((requestInit.headers as Record<string, string>)["X-Api-Key"]).toBe("raw-api-key");
        expect((requestInit.headers as Record<string, string>)["Authorization"]).toBeUndefined();
    });

    it("appends query_param auth without Authorization header", async () => {
        const fetchMock = mockFetch(200, []);
        const vault = makeVault("api-key-value");

        await executeHttpCall(vault, makeCredential(), audit, {
            method: "GET",
            path: "/search",
            baseUrl: "https://api.myapp.com",
            auth: { kind: "query_param", name: "api_key" },
        });

        const calledUrl = (fetchMock.mock.calls[0] as [string])[0];
        expect(calledUrl).toContain("api_key=api-key-value");
        const requestInit = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
        expect((requestInit.headers as Record<string, string>)["Authorization"]).toBeUndefined();
    });

    it("skips all auth when credential is null (public target)", async () => {
        const fetchMock = mockFetch(200, {});
        const vault = { read: vi.fn() } as unknown as VaultManager;

        await executeHttpCall(vault, null, audit, {
            method: "GET",
            path: "/public-resource",
            baseUrl: "https://api.github.com",
        });

        const requestInit = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
        expect((requestInit.headers as Record<string, string>)["Authorization"]).toBeUndefined();
        expect(vault.read).not.toHaveBeenCalled();
    });
});

// ─── Response parsing ─────────────────────────────────────────────────────────

describe("executeHttpCall — response parsing", () => {
    it("parses JSON body when Content-Type is application/json", async () => {
        mockFetch(200, { id: 42, name: "test" }, "application/json");
        const vault = makeVault("tok");

        const result = await executeHttpCall(vault, makeCredential(), audit, {
            method: "GET",
            path: "/resource",
            baseUrl: "https://api.myapp.com",
        });

        expect(result.body).toEqual({ id: 42, name: "test" });
        expect(result.status).toBe(200);
    });

    it("returns body as string when Content-Type is not JSON", async () => {
        mockFetch(200, "<html>ok</html>", "text/html");
        const vault = makeVault("tok");

        const result = await executeHttpCall(vault, makeCredential(), audit, {
            method: "GET",
            path: "/resource",
            baseUrl: "https://api.myapp.com",
        });

        expect(typeof result.body).toBe("string");
        expect(result.body).toContain("<html>");
    });

    it("returns the response envelope with status, headers, and body", async () => {
        mockFetch(201, { created: true }, "application/json");
        const vault = makeVault("tok");

        const result = await executeHttpCall(vault, makeCredential(), audit, {
            method: "POST",
            path: "/orders",
            baseUrl: "https://api.myapp.com",
            body: '{"item":"widget"}',
        });

        expect(result.status).toBe(201);
        expect(result.headers).toBeDefined();
        expect(result.body).toEqual({ created: true });
    });

    it("returns non-2xx status in the envelope without throwing", async () => {
        mockFetch(404, { error: "not found" }, "application/json");
        const vault = makeVault("tok");

        const result = await executeHttpCall(vault, makeCredential(), audit, {
            method: "GET",
            path: "/notfound",
            baseUrl: "https://api.myapp.com",
        });

        expect(result.status).toBe(404);
        expect((result.body as { error: string }).error).toBe("not found");
    });
});

// ─── Config validation ────────────────────────────────────────────────────────

describe("validateHttpConfig", () => {
    it("accepts a config with a base_url string", () => {
        expect(() => validateHttpConfig({ base_url: "https://api.example.com" })).not.toThrow();
    });

    it("throws when base_url is missing", () => {
        expect(() => validateHttpConfig({})).toThrow(/base_url/);
    });

    it("throws when base_url is not a string", () => {
        expect(() => validateHttpConfig({ base_url: 42 })).toThrow(/base_url/);
    });
});
