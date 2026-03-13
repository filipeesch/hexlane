/**
 * Vault secret payloads — stored encrypted, never in SQLite.
 */

export interface ApiTokenSecret {
    kind: "api_token";
    token: string;
    vault_lease_id?: string; // e.g. OPA decision_id or Vault lease ID
}

export interface DbConnectionSecret {
    kind: "db_connection";
    engine: "postgresql";
    host: string;
    port: number;
    user: string;
    password: string;
    dbname: string;
    ssl_mode?: "disable" | "require" | "verify-full";
    vault_lease_id?: string; // e.g. Vault lease ID for v2 native renewal
}

export type VaultSecret = ApiTokenSecret | DbConnectionSecret;
