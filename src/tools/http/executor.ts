import type { VaultManager } from "../../vault/vault-manager.js";
import type { CredentialRecord } from "../../metadata/store.js";
import type { ApiTokenSecret } from "../../vault/types.js";
import type { Auth } from "../../config/schema.js";
import type { AuditLogger } from "../../audit/logger.js";
import { debugLog } from "../../cli/debug.js";

export interface HttpCallOptions {
    method: string;
    path: string;
    query?: Record<string, string>;
    body?: string;
    baseUrl: string;
    auth?: Auth;
}

export interface HttpCallResult {
    status: number;
    headers: Record<string, string>;
    body: unknown;
}

export async function executeHttpCall(
    vault: VaultManager,
    credential: CredentialRecord | null,
    audit: AuditLogger,
    options: HttpCallOptions,
): Promise<HttpCallResult> {
    // Build URL — base_url + path (normalise the join so no double-slash appears)
    let url = options.baseUrl.replace(/\/$/, "") + "/" + options.path.replace(/^\//, "");

    // Append rendered query params (skip empty values)
    if (options.query) {
        const qs = Object.entries(options.query)
            .filter(([, v]) => v !== "" && v !== undefined)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join("&");
        if (qs) url += (url.includes("?") ? "&" : "?") + qs;
    }

    debugLog(`http call`, `${options.method.toUpperCase()} ${url}`);

    const requestHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
    };

    if (credential !== null) {
        const secret = vault.read(credential.vault_ref) as ApiTokenSecret;
        if (secret.kind !== "api_token") {
            throw new Error(`Credential is not an API token (kind: ${secret.kind})`);
        }
        const auth = options.auth;
        if (!auth || auth.kind === "bearer") {
            requestHeaders["Authorization"] = `Bearer ${secret.token}`;
        } else if (auth.kind === "header") {
            requestHeaders[auth.name] = secret.token;
        } else if (auth.kind === "query_param") {
            const separator = url.includes("?") ? "&" : "?";
            url += `${separator}${encodeURIComponent(auth.name)}=${encodeURIComponent(secret.token)}`;
        }
    }

    const response = await fetch(url, {
        method: options.method.toUpperCase(),
        headers: requestHeaders,
        body: options.body ?? undefined,
    });

    debugLog(`http response`, `status ${response.status}`);

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    debugLog(`http response headers`, headers);

    let body: unknown;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
        body = await response.json();
    } else {
        body = await response.text();
    }

    audit.log({
        event: "api_call_executed",
        app: credential?.app ?? "public",
        env: credential?.env ?? "public",
        profile: credential?.profile ?? "public",
        status: response.ok ? "ok" : "error",
        credential_id: credential?.id ?? undefined,
        method: options.method.toUpperCase(),
        path: options.path,
        http_status: response.status,
    });

    return { status: response.status, headers, body };
}

/** Validates that an http target config has a required base_url. */
export function validateHttpConfig(config: Record<string, unknown>): void {
    if (!config["base_url"] || typeof config["base_url"] !== "string") {
        throw new Error("http target config must have a base_url string");
    }
}
