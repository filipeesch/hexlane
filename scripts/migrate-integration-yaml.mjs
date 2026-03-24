#!/usr/bin/env node
/**
 * Migrates integration YAML files from the old flat target schema
 *   { id, tool, config, credential }
 * to the new tools-array schema
 *   { id, tools: [{ type, config, credential }] }
 *
 * Also removes `defaultTarget` from individual operations (it only lives on
 * the integration object now).
 *
 * Usage:
 *   node scripts/migrate-integration-yaml.mjs <file1.yaml> [file2.yaml] ...
 */

import * as fs from "fs";
import * as yaml from "js-yaml";

function migrateTarget(target) {
    const { id, params, tool, config, credential, ...rest } = target;
    if (!tool) {
        // Already migrated or has no tool — leave as-is
        return target;
    }
    const toolEntry = { type: tool };
    if (config && Object.keys(config).length > 0) toolEntry.config = config;
    if (credential) toolEntry.credential = credential;
    const migrated = { id };
    if (params) migrated.params = params;
    migrated.tools = [toolEntry];
    // Carry over any unknown keys
    Object.assign(migrated, rest);
    return migrated;
}

function migrateOperation(op) {
    const { defaultTarget, ...rest } = op;
    return rest;
}

function migrateFile(filePath) {
    const raw = yaml.load(fs.readFileSync(filePath, "utf8"));

    if (!raw?.integration) {
        console.error(`  Skipping ${filePath}: no 'integration' key found`);
        return;
    }

    const integration = raw.integration;

    if (Array.isArray(integration.targets)) {
        integration.targets = integration.targets.map(migrateTarget);
    }

    if (Array.isArray(integration.operations)) {
        integration.operations = integration.operations.map(migrateOperation);
    }

    fs.writeFileSync(filePath, yaml.dump(raw, { lineWidth: 120, noRefs: true }), "utf8");
    console.log(`  Migrated: ${filePath}`);
}

const files = process.argv.slice(2);
if (files.length === 0) {
    console.error("Usage: node scripts/migrate-integration-yaml.mjs <file1.yaml> [file2.yaml] ...");
    process.exit(1);
}

for (const f of files) {
    migrateFile(f);
}
