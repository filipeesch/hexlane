import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { AppConfigSchema, type AppConfig } from "./schema.js";

export type { AppConfig };

export function loadAppConfig(filePath: string): AppConfig {
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
    const result = AppConfigSchema.safeParse(parsed);
    if (!result.success) {
        const issues = result.error.issues
            .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
            .join("\n");
        throw new Error(`Invalid app config:\n${issues}`);
    }
    return result.data;
}

export function validateAppConfig(filePath: string): { valid: boolean; errors: string[] } {
    try {
        loadAppConfig(filePath);
        return { valid: true, errors: [] };
    } catch (e: unknown) {
        return { valid: false, errors: [(e as Error).message] };
    }
}
