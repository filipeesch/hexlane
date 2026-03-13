import * as fs from "fs";
import * as path from "path";
import { loadAppConfig } from "./loader.js";
import type { AppConfig } from "./schema.js";

export interface AppRegistryEntry {
    config_path: string;
    registered_at: string;
    validated: boolean;
}

export interface AppRegistry {
    version: 1;
    apps: Record<string, AppRegistryEntry>;
}

export class AppStore {
    private registryPath: string;
    private appsDir: string;

    constructor(hexlaneDir: string) {
        this.registryPath = path.join(hexlaneDir, "config", "registry.json");
        this.appsDir = path.join(hexlaneDir, "config", "apps");
    }

    private readRegistry(): AppRegistry {
        if (!fs.existsSync(this.registryPath)) {
            return { version: 1, apps: {} };
        }
        return JSON.parse(fs.readFileSync(this.registryPath, "utf8")) as AppRegistry;
    }

    private writeRegistry(registry: AppRegistry): void {
        fs.mkdirSync(path.dirname(this.registryPath), { recursive: true });
        fs.writeFileSync(this.registryPath, JSON.stringify(registry, null, 2), "utf8");
    }

    register(sourceFilePath: string): AppConfig {
        const config = loadAppConfig(sourceFilePath);
        const appId = config.app.id;

        fs.mkdirSync(this.appsDir, { recursive: true });
        const destPath = path.join(this.appsDir, `${appId}.yaml`);
        fs.copyFileSync(path.resolve(sourceFilePath), destPath);

        const registry = this.readRegistry();
        registry.apps[appId] = {
            config_path: destPath,
            registered_at: new Date().toISOString(),
            validated: true,
        };
        this.writeRegistry(registry);
        return config;
    }

    get(appId: string): AppConfig {
        const registry = this.readRegistry();
        const entry = registry.apps[appId];
        if (!entry) {
            throw new Error(`App "${appId}" is not registered. Use 'hexlane app add --file <path>'`);
        }
        return loadAppConfig(entry.config_path);
    }

    getProfile(appId: string, envName: string, profileName: string) {
        const config = this.get(appId);
        const env = config.app.environments.find((e: { name: string }) => e.name === envName);
        if (!env) {
            throw new Error(`Environment "${envName}" not found in app "${appId}"`);
        }
        const profile = env.profiles.find((p: { name: string }) => p.name === profileName);
        if (!profile) {
            throw new Error(`Profile "${profileName}" not found in app "${appId}" env "${envName}"`);
        }
        return { config, env, profile };
    }

    list(): Array<{ id: string } & AppRegistryEntry> {
        const registry = this.readRegistry();
        return Object.entries(registry.apps).map(([id, entry]) => ({ id, ...entry }));
    }

    remove(appId: string): void {
        const registry = this.readRegistry();
        if (!registry.apps[appId]) {
            throw new Error(`App "${appId}" is not registered`);
        }
        const configPath = registry.apps[appId].config_path;
        if (fs.existsSync(configPath)) {
            fs.unlinkSync(configPath);
        }
        delete registry.apps[appId];
        this.writeRegistry(registry);
    }
}
