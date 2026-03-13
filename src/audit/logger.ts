import * as fs from "fs";
import * as path from "path";

export type AuditEventName =
    | "credential_acquired"
    | "credential_renewed"
    | "credential_revoked"
    | "renewal_failed"
    | "strategy_failed"
    | "api_call_executed"
    | "db_query_executed"
    | "credential_cleanup";

export interface AuditEvent {
    event: AuditEventName;
    app: string;
    env: string;
    profile: string;
    status: "ok" | "error";
    credential_id?: string;
    trace_id?: string;
    error_message?: string; // safe — never contains secrets
    // For api/db events
    method?: string;
    path?: string;
    http_status?: number;
    db_engine?: string;
    rows_returned?: number;
}

export class AuditLogger {
    private logPath: string;

    constructor(hexlaneDir: string) {
        const auditDir = path.join(hexlaneDir, "audit");
        fs.mkdirSync(auditDir, { recursive: true });
        this.logPath = path.join(auditDir, "audit.jsonl");
    }

    log(event: AuditEvent): void {
        const entry = {
            timestamp: new Date().toISOString(),
            ...event,
        };
        fs.appendFileSync(this.logPath, JSON.stringify(entry) + "\n", "utf8");
    }

    read(filters: { app?: string; limit?: number }): Array<Record<string, unknown>> {
        if (!fs.existsSync(this.logPath)) return [];
        const lines = fs.readFileSync(this.logPath, "utf8").split("\n").filter(Boolean);
        const events = lines
            .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
            .filter((e): e is Record<string, unknown> => e !== null);

        const filtered = filters.app
            ? events.filter((e) => e["app"] === filters.app)
            : events;

        const limit = filters.limit ?? 100;
        return filtered.slice(-limit).reverse();
    }
}
