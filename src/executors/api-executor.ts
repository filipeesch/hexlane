import type { VaultManager } from "../vault/vault-manager.js";
import type { CredentialRecord } from "../metadata/store.js";
import type { ApiTokenSecret } from "../vault/types.js";
import type { Auth } from "../config/schema.js";
import type { AuditLogger } from "../audit/logger.js";
import { debugLog } from "../cli/debug.js";

interface ApiCallOptions {
    method: string;
    path: string;
    body?: string;
    baseUrl: string;
    // How the token is injected. Defaults to Bearer if omitted.
    auth?: Auth;
}

export interface ApiCallResult {
    status: number;
    headers: Record<string, string>;
    body: unknown;
}

export async function executeApiCall(
    vault: VaultManager,
    credential: CredentialRecord,
    audit: AuditLogger,
    options: ApiCallOptions,
): Promise<ApiCallResult> {
    const secret = vault.read(credential.vault_ref) as ApiTokenSecret;
    if (secret.kind !== "api_token") {
        throw new Error(`Credential is not an API token (kind: ${secret.kind})`);
    }

    // Build URL — base_url + path
    let url = options.baseUrl.replace(/\/$/, "") + "/" + options.path.replace(/^\//, "");
    debugLog(`api call`, `${options.method.toUpperCase()} ${url}`);

    // Inject auth based on configured mode (defaults to Bearer)
    const requestHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
    };
    const auth = options.auth;
    if (!auth || auth.kind === "bearer") {
        requestHeaders["Authorization"] = `Bearer ${secret.token}`;
    } else if (auth.kind === "header") {
        requestHeaders[auth.name] = secret.token;
    } else if (auth.kind === "query_param") {
        const separator = url.includes("?") ? "&" : "?";
        url += `${separator}${encodeURIComponent(auth.name)}=${encodeURIComponent(secret.token)}`;
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
        app: credential.app,
        env: credential.env,
        profile: credential.profile,
        status: response.ok ? "ok" : "error",
        credential_id: credential.id,
        method: options.method.toUpperCase(),
        path: options.path,
        http_status: response.status,
    });

    return { status: response.status, headers, body };
}
