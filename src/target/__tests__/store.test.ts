/**
 * Tests for TargetStore — the registry that maps target IDs to their
 * YAML config files on disk. Covers register, get, list, and remove.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TargetStore } from "../store.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const httpTargetYaml = `
version: 1
target:
  id: my-app-api-prod
  app: my-app
  tool: http
  config:
    base_url: https://api.myapp.com
  credential:
    kind: api_token
    acquire_strategy:
      kind: static
    auth:
      kind: bearer
`.trim();

const sqlTargetYaml = `
version: 1
target:
  id: my-app-db-prod
  app: my-app
  tool: sql
  config:
    engine: postgresql
    host: db.myapp.com
    port: 5432
    dbname: myapp
  credential:
    kind: db_connection
    acquire_strategy:
      kind: static
`.trim();

const publicTargetYaml = `
version: 1
target:
  id: github
  app: github
  tool: http
  config:
    base_url: https://api.github.com
  credential:
    kind: public
`.trim();

// ─── Setup ────────────────────────────────────────────────────────────────────

let tmpDir: string;
let store: TargetStore;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hexlane-target-store-test-"));
    store = new TargetStore(tmpDir);
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── register ─────────────────────────────────────────────────────────────────

describe("TargetStore.register", () => {
    it("registers an http target and returns its parsed config", () => {
        const yamlPath = path.join(tmpDir, "my-app-api-prod.yaml");
        fs.writeFileSync(yamlPath, httpTargetYaml, "utf8");

        const config = store.register(yamlPath);

        expect(config.target.id).toBe("my-app-api-prod");
        expect(config.target.tool).toBe("http");
        expect(config.target.app).toBe("my-app");
    });

    it("registers a sql target and returns its parsed config", () => {
        const yamlPath = path.join(tmpDir, "my-app-db-prod.yaml");
        fs.writeFileSync(yamlPath, sqlTargetYaml, "utf8");

        const config = store.register(yamlPath);

        expect(config.target.id).toBe("my-app-db-prod");
        expect(config.target.tool).toBe("sql");
        expect(config.target.config["engine"]).toBe("postgresql");
    });

    it("registers a public target with no credential acquisition", () => {
        const yamlPath = path.join(tmpDir, "github.yaml");
        fs.writeFileSync(yamlPath, publicTargetYaml, "utf8");

        const config = store.register(yamlPath);

        expect(config.target.id).toBe("github");
        expect(config.target.credential?.kind).toBe("public");
    });

    it("copies the target file to the targets directory", () => {
        const yamlPath = path.join(tmpDir, "my-app-api-prod.yaml");
        fs.writeFileSync(yamlPath, httpTargetYaml, "utf8");

        store.register(yamlPath);

        const storedPath = path.join(tmpDir, "config", "targets", "my-app-api-prod.yaml");
        expect(fs.existsSync(storedPath)).toBe(true);
    });

    it("overwrites an existing registration with the same id", () => {
        const yamlPath = path.join(tmpDir, "my-app-api-prod.yaml");
        fs.writeFileSync(yamlPath, httpTargetYaml, "utf8");

        store.register(yamlPath);
        store.register(yamlPath); // second registration — should not throw

        const listed = store.list();
        expect(listed.filter((t) => t.id === "my-app-api-prod").length).toBe(1);
    });

    it("throws when the file does not exist", () => {
        expect(() => store.register("/nonexistent/target.yaml")).toThrow();
    });

    it("throws when the YAML is invalid or fails schema validation", () => {
        const badYaml = path.join(tmpDir, "bad.yaml");
        fs.writeFileSync(badYaml, "version: 1\ntarget:\n  id: INVALID_ID\n  tool: http\n  app: x\n", "utf8");
        expect(() => store.register(badYaml)).toThrow();
    });
});

// ─── get ─────────────────────────────────────────────────────────────────────

describe("TargetStore.get", () => {
    it("returns the registered target config by id", () => {
        const yamlPath = path.join(tmpDir, "my-app-api-prod.yaml");
        fs.writeFileSync(yamlPath, httpTargetYaml, "utf8");
        store.register(yamlPath);

        const config = store.get("my-app-api-prod");

        expect(config.target.id).toBe("my-app-api-prod");
        expect(config.target.tool).toBe("http");
    });

    it("throws a descriptive error when the target is not registered", () => {
        expect(() => store.get("unknown-target")).toThrow(/not registered/i);
    });
});

// ─── list ─────────────────────────────────────────────────────────────────────

describe("TargetStore.list", () => {
    it("returns an empty array when no targets are registered", () => {
        expect(store.list()).toEqual([]);
    });

    it("returns all registered targets with id, tool, and app", () => {
        const httpPath = path.join(tmpDir, "my-app-api-prod.yaml");
        const sqlPath = path.join(tmpDir, "my-app-db-prod.yaml");
        fs.writeFileSync(httpPath, httpTargetYaml, "utf8");
        fs.writeFileSync(sqlPath, sqlTargetYaml, "utf8");

        store.register(httpPath);
        store.register(sqlPath);

        const listed = store.list();
        expect(listed.length).toBe(2);

        const ids = listed.map((t) => t.id);
        expect(ids).toContain("my-app-api-prod");
        expect(ids).toContain("my-app-db-prod");
    });

    it("includes tool and app for each entry", () => {
        const yamlPath = path.join(tmpDir, "my-app-api-prod.yaml");
        fs.writeFileSync(yamlPath, httpTargetYaml, "utf8");
        store.register(yamlPath);

        const listed = store.list();
        expect(listed[0]?.tool).toBe("http");
        expect(listed[0]?.app).toBe("my-app");
    });
});

// ─── remove ───────────────────────────────────────────────────────────────────

describe("TargetStore.remove", () => {
    it("removes a registered target by id", () => {
        const yamlPath = path.join(tmpDir, "my-app-api-prod.yaml");
        fs.writeFileSync(yamlPath, httpTargetYaml, "utf8");
        store.register(yamlPath);

        store.remove("my-app-api-prod");

        const listed = store.list();
        expect(listed.find((t) => t.id === "my-app-api-prod")).toBeUndefined();
    });

    it("removing a target makes get() throw", () => {
        const yamlPath = path.join(tmpDir, "my-app-api-prod.yaml");
        fs.writeFileSync(yamlPath, httpTargetYaml, "utf8");
        store.register(yamlPath);

        store.remove("my-app-api-prod");

        expect(() => store.get("my-app-api-prod")).toThrow(/not registered/i);
    });

    it("throws a descriptive error when removing a non-existent target", () => {
        expect(() => store.remove("nonexistent")).toThrow(/not registered/i);
    });
});
