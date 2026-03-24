import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";

export type CredentialStatus = "active" | "expired" | "revoked" | "invalid";
export type CredentialKind = "api_token" | "db_connection";

export interface CredentialRecord {
    id: string;              // internal UUID
    app: string;
    env: string;
    profile: string;
    kind: CredentialKind;
    status: CredentialStatus;
    renewable: boolean;
    vault_ref: string;       // filename in vault/
    created_at: string;      // ISO 8601
    updated_at: string;      // ISO 8601
    expires_at: string | null;
    last_used_at: string | null;
    // Safe display fields (no secrets)
    db_host: string | null;
    db_name: string | null;
    db_engine: string | null;
}

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS credentials (
    id           TEXT PRIMARY KEY,
    app          TEXT NOT NULL,
    env          TEXT NOT NULL,
    profile      TEXT NOT NULL,
    kind         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'active',
    renewable    INTEGER NOT NULL DEFAULT 1,
    vault_ref    TEXT NOT NULL UNIQUE,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    expires_at   TEXT,
    last_used_at TEXT,
    db_host      TEXT,
    db_name      TEXT,
    db_engine    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_credentials_lookup
    ON credentials(app, env, profile, status);
  CREATE INDEX IF NOT EXISTS idx_credentials_expiry
    ON credentials(expires_at, status);
`;

export class MetadataStore {
    private db: Database.Database;

    constructor(hexlaneDir: string) {
        const dataDir = path.join(hexlaneDir, "data");
        fs.mkdirSync(dataDir, { recursive: true });
        this.db = new Database(path.join(dataDir, "credentials.db"));
        this.db.exec(CREATE_TABLE);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("foreign_keys = ON");
    }

    upsert(record: CredentialRecord): void {
        this.db
            .prepare(
                `INSERT INTO credentials
           (id, app, env, profile, kind, status, renewable, vault_ref,
            created_at, updated_at, expires_at, last_used_at,
            db_host, db_name, db_engine)
         VALUES
           (@id, @app, @env, @profile, @kind, @status, @renewable, @vault_ref,
            @created_at, @updated_at, @expires_at, @last_used_at,
            @db_host, @db_name, @db_engine)
         ON CONFLICT(vault_ref) DO UPDATE SET
           id           = excluded.id,
           status       = excluded.status,
           updated_at   = excluded.updated_at,
           expires_at   = excluded.expires_at,
           last_used_at = excluded.last_used_at,
           created_at   = excluded.created_at,
           db_host      = excluded.db_host,
           db_name      = excluded.db_name,
           db_engine    = excluded.db_engine`
            )
            .run({ ...record, renewable: record.renewable ? 1 : 0 });
    }

    findByIdentity(
        app: string,
        env: string,
        profile: string
    ): CredentialRecord | undefined {
        return this.db
            .prepare(
                `SELECT * FROM credentials
         WHERE app = ? AND env = ? AND profile = ? AND status != 'revoked'
         ORDER BY created_at DESC LIMIT 1`
            )
            .get(app, env, profile) as CredentialRecord | undefined;
    }

    findById(id: string): CredentialRecord | undefined {
        return this.db
            .prepare("SELECT * FROM credentials WHERE id = ?")
            .get(id) as CredentialRecord | undefined;
    }

    updateStatus(id: string, status: CredentialStatus): void {
        this.db
            .prepare(
                "UPDATE credentials SET status = ?, updated_at = ? WHERE id = ?"
            )
            .run(status, new Date().toISOString(), id);
    }

    updateAfterRenewal(
        id: string,
        expiresAt: string | null,
        now: string
    ): void {
        this.db
            .prepare(
                "UPDATE credentials SET expires_at = ?, updated_at = ?, status = 'active' WHERE id = ?"
            )
            .run(expiresAt, now, id);
    }

    touchLastUsed(id: string): void {
        this.db
            .prepare("UPDATE credentials SET last_used_at = ? WHERE id = ?")
            .run(new Date().toISOString(), id);
    }

    list(filters: {
        app?: string;
        env?: string;
        status?: CredentialStatus | "all";
    }): CredentialRecord[] {
        let query = "SELECT * FROM credentials WHERE 1=1";
        const params: unknown[] = [];
        if (filters.app) { query += " AND app = ?"; params.push(filters.app); }
        if (filters.env) { query += " AND env = ?"; params.push(filters.env); }
        if (filters.status && filters.status !== "all") {
            query += " AND status = ?"; params.push(filters.status);
        }
        query += " ORDER BY app, env, profile";
        return this.db.prepare(query).all(...params) as CredentialRecord[];
    }

    listExpiredOrRevoked(): CredentialRecord[] {
        return this.db
            .prepare(
                `SELECT * FROM credentials
         WHERE status IN ('expired', 'revoked')
            OR (expires_at IS NOT NULL AND expires_at < ?)`
            )
            .all(new Date().toISOString()) as CredentialRecord[];
    }

    /**
     * List all credential records for a given integration + target (env), regardless of status.
     * Used by credential move to enumerate all entries to relocate.
     */
    listByTarget(app: string, env: string): CredentialRecord[] {
        return this.db
            .prepare("SELECT * FROM credentials WHERE app = ? AND env = ? ORDER BY profile")
            .all(app, env) as CredentialRecord[];
    }

    delete(id: string): void {
        this.db.prepare("DELETE FROM credentials WHERE id = ?").run(id);
    }

    close(): void {
        this.db.close();
    }
}
