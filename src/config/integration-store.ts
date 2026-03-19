import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { IntegrationConfigSchema, type IntegrationConfig, type IntegrationTarget } from "./integration-schema.js";

export interface IntegrationRegistryEntry {
    config_path: string;
    registered_at: string;
    validated: boolean;
}

export interface IntegrationRegistry {
    version: 1;
    integrations: Record<string, IntegrationRegistryEntry>;
}

function loadIntegrationConfig(filePath: string): IntegrationConfig {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
        throw new Error(`Config file not found: ${resolved}`);
    }
    const raw = fs.readFileSync(resolved, "utf8");
    let parsed: unknown;
    try {
        parsed = yaml.load(raw);
    } catch (e: unknown) {
        throw new Error(`Failed to parse YAML: ${(e as Error).message}`);
    }
    const result = IntegrationConfigSchema.safeParse(parsed);
    if (!result.success) {
        const issues = result.error.issues
            .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
            .join("\n");
        throw new Error(`Invalid integration config:\n${issues}`);
    }
    return result.data;
}

export class IntegrationStore {
    private registryPath: string;
    private integrationsDir: string;

    constructor(hexlaneDir: string) {
        this.registryPath = path.join(hexlaneDir, "config", "integrations-registry.json");
        this.integrationsDir = path.join(hexlaneDir, "config", "integrations");
    }

    private readRegistry(): IntegrationRegistry {
        if (!fs.existsSync(this.registryPath)) {
            return { version: 1, integrations: {} };
        }
        return JSON.parse(fs.readFileSync(this.registryPath, "utf8")) as IntegrationRegistry;
    }

    private writeRegistry(registry: IntegrationRegistry): void {
        fs.mkdirSync(path.dirname(this.registryPath), { recursive: true });
        fs.writeFileSync(this.registryPath, JSON.stringify(registry, null, 2), "utf8");
    }

    register(sourceFilePath: string): IntegrationConfig {
        const config = loadIntegrationConfig(sourceFilePath);
        const integrationId = config.integration.id;

        fs.mkdirSync(this.integrationsDir, { recursive: true });
        const destPath = path.join(this.integrationsDir, `${integrationId}.yaml`);
        fs.copyFileSync(path.resolve(sourceFilePath), destPath);

        const registry = this.readRegistry();
        registry.integrations[integrationId] = {
            config_path: destPath,
            registered_at: new Date().toISOString(),
            validated: true,
        };
        this.writeRegistry(registry);
        return config;
    }

    get(integrationId: string): IntegrationConfig {
        const registry = this.readRegistry();
        const entry = registry.integrations[integrationId];
        if (!entry) {
            throw new Error(`Integration "${integrationId}" is not registered. Use 'hexlane integration add --file <path>'`);
        }
        return loadIntegrationConfig(entry.config_path);
    }

    list(): Array<{ id: string } & IntegrationRegistryEntry> {
        const registry = this.readRegistry();
        return Object.entries(registry.integrations).map(([id, entry]) => ({ id, ...entry }));
    }

    remove(integrationId: string): void {
        const registry = this.readRegistry();
        if (!registry.integrations[integrationId]) {
            throw new Error(`Integration "${integrationId}" is not registered`);
        }
        const configPath = registry.integrations[integrationId].config_path;
        if (fs.existsSync(configPath)) {
            fs.unlinkSync(configPath);
        }
        delete registry.integrations[integrationId];
        this.writeRegistry(registry);
    }

    /**
     * Find which integration owns a given target ID.
     * Scans all registered integrations.
     */
    findByTargetId(targetId: string): { integrationId: string; target: IntegrationTarget } | undefined {
        const registry = this.readRegistry();
        for (const [integrationId, entry] of Object.entries(registry.integrations)) {
            try {
                const config = loadIntegrationConfig(entry.config_path);
                const target = config.integration.targets.find((t) => t.id === targetId);
                if (target) {
                    return { integrationId, target };
                }
            } catch {
                // Skip integrations that fail to load
            }
        }
        return undefined;
    }
}
