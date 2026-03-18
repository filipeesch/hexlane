import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { TargetConfigSchema, type TargetConfig } from "./schema.js";

export interface TargetRegistryEntry {
    config_path: string;
    tool: string;
    app: string;
    registered_at: string;
}

export interface TargetRegistry {
    version: 1;
    targets: Record<string, TargetRegistryEntry>;
}

export class TargetStore {
    private registryPath: string;
    private targetsDir: string;

    constructor(hexlaneDir: string) {
        this.registryPath = path.join(hexlaneDir, "config", "targets-registry.json");
        this.targetsDir = path.join(hexlaneDir, "config", "targets");
    }

    private readRegistry(): TargetRegistry {
        if (!fs.existsSync(this.registryPath)) {
            return { version: 1, targets: {} };
        }
        return JSON.parse(fs.readFileSync(this.registryPath, "utf8")) as TargetRegistry;
    }

    private writeRegistry(registry: TargetRegistry): void {
        fs.mkdirSync(path.dirname(this.registryPath), { recursive: true });
        fs.writeFileSync(this.registryPath, JSON.stringify(registry, null, 2), "utf8");
    }

    /** Parses and validates a YAML file into a TargetConfig. */
    private loadTargetConfig(filePath: string): TargetConfig {
        if (!fs.existsSync(filePath)) {
            throw new Error(`Target config file not found: ${filePath}`);
        }
        let parsed: unknown;
        try {
            parsed = yaml.load(fs.readFileSync(filePath, "utf8"));
        } catch (e: unknown) {
            throw new Error(`Failed to parse target YAML: ${(e as Error).message}`);
        }
        const result = TargetConfigSchema.safeParse(parsed);
        if (!result.success) {
            const issues = result.error.issues
                .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
                .join("\n");
            throw new Error(`Invalid target config:\n${issues}`);
        }
        return result.data;
    }

    /**
     * Registers a target from a YAML file.
     * Validates the config, copies it to the targets directory, and records
     * it in the registry. Overwrites any existing registration with the same id.
     */
    register(sourceFilePath: string): TargetConfig {
        const config = this.loadTargetConfig(sourceFilePath);
        const { id, tool, app } = config.target;

        fs.mkdirSync(this.targetsDir, { recursive: true });

        const destPath = path.join(this.targetsDir, `${id}.yaml`);
        fs.copyFileSync(sourceFilePath, destPath);

        const registry = this.readRegistry();
        registry.targets[id] = {
            config_path: destPath,
            tool,
            app,
            registered_at: new Date().toISOString(),
        };
        this.writeRegistry(registry);

        return config;
    }

    /** Returns the parsed config for a registered target. */
    get(targetId: string): TargetConfig {
        const registry = this.readRegistry();
        const entry = registry.targets[targetId];
        if (!entry) {
            throw new Error(`Target "${targetId}" is not registered. Run: hexlane target add <file>`);
        }
        return this.loadTargetConfig(entry.config_path);
    }

    list(): Array<TargetRegistryEntry & { id: string }> {
        const registry = this.readRegistry();
        return Object.entries(registry.targets).map(([id, entry]) => ({ id, ...entry }));
    }

    /** Deregisters a target and removes its stored config file. */
    remove(targetId: string): void {
        const registry = this.readRegistry();
        const entry = registry.targets[targetId];
        if (!entry) {
            throw new Error(`Target "${targetId}" is not registered`);
        }
        if (fs.existsSync(entry.config_path)) {
            fs.rmSync(entry.config_path);
        }
        delete registry.targets[targetId];
        this.writeRegistry(registry);
    }
}
