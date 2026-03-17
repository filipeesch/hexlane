import type { VaultManager } from "../vault/vault-manager.js";
import type { CredentialRecord } from "../metadata/store.js";
import type { ApiTokenSecret } from "../vault/types.js";
import type { Auth } from "../config/schema.js";
import type { AuditLogger } from "../audit/logger.js";
import { debugLog } from "../cli/debug.js";

interface ApiCallOptions {
    method: string;
    path: string;
    query?: Record<string, string>;  // rendered query params (empty values omitted)
    body?: string;
    baseUrl: string;
    // How the token is injected. Omit entirely for public profiles.
    auth?: Auth;
}

export interface ApiCallResult {
    status: number;
    headers: Record<string, string>;
    body: unknown;
}

export async function executeApiCall(
    vault: VaultManager,
    credential: CredentialRecord | null,
    audit: AuditLogger,
    options: ApiCallOptions,
): Promise<ApiCallResult> {
    // Build URL — base_url + path
    let url = options.baseUrl.replace(/\/$/, "") + "/" + options.path.replace(/^\//, "");

    // Append rendered query params (skip empty values)
    if (options.query) {
        const qs = Object.entries(options.query)
            .filter(([, v]) => v !== "" && v !== undefined)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join("&");
        if (qs) url += (url.includes("?") ? "&" : "?") + qs;
    }

    debugLog(`api call`, `${options.method.toUpperCase()} ${url}`);

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

    debugLog(`api response`, `status ${response.status}`);

    // Collect response headers (safe metadata, not secrets)
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    debugLog(`api response headers`, headers);

    // Read response (safe application data, not a credential)
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
