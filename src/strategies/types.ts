import type { VaultSecret } from "../vault/types.js";

export interface StrategyResult {
    secret: VaultSecret;
    acquired_at: Date;
    expires_at: Date | null;
    trace_id?: string; // e.g. OPA decision_id or Vault lease ID (safe to log)
}

export interface StrategyError {
    kind: "strategy_failure";
    code:
    | "command_failed"
    | "command_timeout"
    | "http_error"
    | "parse_error"
    | "mapping_error"
    | "application_error";
    message: string; // safe — never contains secret material
    exit_code?: number;
    http_status?: number;
}
