import * as crypto from "crypto";
import type { Profile } from "../config/schema.js";
import { VaultManager } from "../vault/vault-manager.js";
import { MetadataStore, type CredentialRecord } from "../metadata/store.js";
import { LockManager } from "./lock-manager.js";
import { runStrategy } from "../strategies/runner.js";
import type { AuditLogger } from "../audit/logger.js";
import type { DbConnectionSecret } from "../vault/types.js";
import { debugLog } from "../cli/debug.js";

export class CredentialResolver {
    constructor(
        private vault: VaultManager,
        private metadata: MetadataStore,
        private locks: LockManager,
        private audit: AuditLogger,
    ) { }

    /**
     * Resolves a valid credential for the given identity.
     * Acquires or renews automatically as needed.
     */
    async resolve(
        app: string,
        env: string,
        profile: Profile,
    ): Promise<CredentialRecord> {
        const existing = this.metadata.findByIdentity(app, env, profile.name);

        if (existing && existing.status === "active") {
            if (this.needsRenewal(existing, profile)) {
                if (profile.acquire_strategy.kind === "static") {
                    throw new Error(
                        `Static credential for ${app}/${env}/${profile.name} has expired. ` +
                        `Run: hexlane credential set --app ${app} --env ${env} --profile ${profile.name}`
                    );
                }
                debugLog(`credential`, `renewing ${app}/${env}/${profile.name} (expires ${existing.expires_at})`);
                return this.renew(app, env, profile, existing);
            }
            debugLog(`credential`, `cache hit for ${app}/${env}/${profile.name} (expires ${existing.expires_at})`);
            this.metadata.touchLastUsed(existing.id);
            return existing;
        }

        if (profile.acquire_strategy.kind === "static") {
            throw new Error(
                `No credential found for ${app}/${env}/${profile.name}. ` +
                `Run: hexlane credential set --app ${app} --env ${env} --profile ${profile.name}`
            );
        }

        debugLog(`credential`, `acquiring new credential for ${app}/${env}/${profile.name}`);
        return this.acquire(app, env, profile);
    }

    private needsRenewal(record: CredentialRecord, profile: Profile): boolean {
        if (!record.expires_at) return false;
        const renewBeforeMs = (profile.renewal_policy?.renew_before_expiry ?? 300) * 1000;
        const expiresAt = new Date(record.expires_at).getTime();
        return Date.now() >= expiresAt - renewBeforeMs;
    }

    private async acquire(
        app: string,
        env: string,
        profile: Profile,
    ): Promise<CredentialRecord> {
        const vaultRef = VaultManager.vaultRef(app, env, profile.name);
        await this.locks.acquire(vaultRef);
        try {
            const result = await runStrategy(profile.acquire_strategy);
            const now = new Date();

            // Compute expires_at: prefer strategy output, fall back to renewal_policy.ttl
            let expiresAt: string | null = null;
            if (result.expires_at) {
                expiresAt = result.expires_at.toISOString();
            } else if (profile.renewal_policy?.ttl) {
                expiresAt = new Date(now.getTime() + profile.renewal_policy.ttl * 1000).toISOString();
            }

            // Write encrypted secret to vault
            this.vault.write(vaultRef, result.secret);

            // Write safe metadata to SQLite
            const record: CredentialRecord = {
                id: crypto.randomUUID(),
                app,
                env,
                profile: profile.name,
                kind: profile.kind,
                status: "active",
                renewable: true,
                vault_ref: vaultRef,
                created_at: now.toISOString(),
                updated_at: now.toISOString(),
                expires_at: expiresAt,
                last_used_at: now.toISOString(),
                db_host: result.secret.kind === "db_connection"
                    ? (result.secret as DbConnectionSecret).host
                    : null,
                db_name: result.secret.kind === "db_connection"
                    ? (result.secret as DbConnectionSecret).dbname
                    : null,
                db_engine: result.secret.kind === "db_connection" ? "postgresql" : null,
            };
            this.metadata.upsert(record);

            this.audit.log({
                event: "credential_acquired",
                app, env, profile: profile.name,
                status: "ok",
                credential_id: record.id,
                trace_id: result.trace_id,
            });

            return record;
        } catch (e: unknown) {
            this.audit.log({
                event: "strategy_failed",
                app, env, profile: profile.name,
                status: "error",
                error_message: (e as Error).message ?? String(e),
            });
            throw e;
        } finally {
            this.locks.release(vaultRef);
        }
    }

    private async renew(
        app: string,
        env: string,
        profile: Profile,
        existing: CredentialRecord,
    ): Promise<CredentialRecord> {
        const vaultRef = existing.vault_ref;
        await this.locks.acquire(vaultRef);
        try {
            const result = await runStrategy(profile.acquire_strategy);
            const now = new Date();

            let expiresAt: string | null = null;
            if (result.expires_at) {
                expiresAt = result.expires_at.toISOString();
            } else if (profile.renewal_policy?.ttl) {
                expiresAt = new Date(now.getTime() + profile.renewal_policy.ttl * 1000).toISOString();
            }

            // Atomic vault replace: write new → update metadata → done
            this.vault.write(vaultRef, result.secret);
            this.metadata.updateAfterRenewal(existing.id, expiresAt, now.toISOString());
            this.metadata.touchLastUsed(existing.id);

            this.audit.log({
                event: "credential_renewed",
                app, env, profile: profile.name,
                status: "ok",
                credential_id: existing.id,
                trace_id: result.trace_id,
            });

            return this.metadata.findById(existing.id)!;
        } catch (e: unknown) {
            this.metadata.updateStatus(existing.id, "invalid");
            this.audit.log({
                event: "renewal_failed",
                app, env, profile: profile.name,
                status: "error",
                error_message: (e as Error).message ?? String(e),
                credential_id: existing.id,
            });
            throw new Error(
                `Credential renewal failed for ${app}/${env}/${profile.name}: ` +
                `${(e as Error).message ?? String(e)}`
            );
        } finally {
            this.locks.release(vaultRef);
        }
    }

    async revoke(app: string, env: string, profileName: string): Promise<void> {
        const record = this.metadata.findByIdentity(app, env, profileName);
        if (!record) {
            throw new Error(`No active credential found for ${app}/${env}/${profileName}`);
        }
        this.metadata.updateStatus(record.id, "revoked");
        this.vault.delete(record.vault_ref);
        this.audit.log({
            event: "credential_revoked",
            app, env, profile: profileName,
            status: "ok",
            credential_id: record.id,
        });
    }

    cleanup(): { removed: number } {
        const stale = this.metadata.listExpiredOrRevoked();
        for (const record of stale) {
            this.vault.delete(record.vault_ref);
            this.metadata.delete(record.id);
        }
        return { removed: stale.length };
    }
}
