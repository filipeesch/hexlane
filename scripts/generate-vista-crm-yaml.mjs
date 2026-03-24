#!/usr/bin/env node
/**
 * Writes examples/vista-crm.yaml from:
 * 1) Vistasoft OpenAPI embedded in /doc/ HTML (any broker host with the same spec)
 * 2) Broker targets from examples/vista-brokers-staging.json (no API keys — use hexlane credential set)
 *
 * Usage (from repo root):
 *   node scripts/generate-vista-crm-yaml.mjs [docBrokerId]
 *
 * docBrokerId — Vista broker id used only to download /doc/ (default: first entry in JSON).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "examples", "vista-crm.yaml");
const BROKERS_JSON = path.join(ROOT, "examples", "vista-brokers-staging.json");

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

/** Params documented in BSP / HTML but missing from OpenAPI for GET. */
const EXTRA_QUERY = {
  "get /imoveis/detalhes": [
    {
      name: "imovel",
      description: "Código do imóvel (obrigatório na API; ausente no OpenAPI).",
    },
  ],
};

function pathToSlug(p) {
  return p
    .replace(/^\/+/, "")
    .replace(/\{([^}]+)\}/g, "$1")
    .replace(/\//g, "-")
    .replace(/[^a-z0-9-]+/gi, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function safeParamName(name) {
  let s = String(name).replace(/[^a-zA-Z0-9_]/g, "_");
  if (!/^[a-zA-Z_]/.test(s)) s = `p_${s}`;
  return s;
}

/** ASCII slug for YAML tags (flow array). */
function slugTag(tag) {
  return (
    String(tag)
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "vista"
  );
}

/** Target id: vista-{name-slug}; disambiguate with -bsp-{id} on collision. */
function slugifyBrokerName(name) {
  const base =
    String(name)
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "broker";
  return base.replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function yamlEscapeOneLine(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, " ")
    .slice(0, 480);
}

function methodReadOnly(method) {
  return method === "get";
}

const names = new Map();
function uniqueOpName(method, p) {
  let base = `${method}-${pathToSlug(p)}`;
  if (base.length > 80) base = base.slice(0, 80).replace(/-$/, "");
  let n = names.get(base) ?? 0;
  names.set(base, n + 1);
  if (n > 0) base = `${base}-${n}`;
  return base;
}

function loadBrokers() {
  const raw = fs.readFileSync(BROKERS_JSON, "utf8");
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error(`${BROKERS_JSON} must be a non-empty array`);
  }
  const seen = new Set();
  const targets = [];
  for (const row of arr) {
    const bspId = row.bspId;
    const integrationName = row.integrationName;
    const vistaBrokerId = row.vistaBrokerId;
    if (!integrationName || !vistaBrokerId) {
      throw new Error("Each broker row needs integrationName and vistaBrokerId");
    }
    let id = `vista-${slugifyBrokerName(integrationName)}`;
    if (seen.has(id)) id = `${id}-bsp-${bspId}`;
    seen.add(id);
    targets.push({
      id,
      integrationName,
      vistaBrokerId,
      bspId,
    });
  }
  targets.sort((a, b) => a.id.localeCompare(b.id));
  return targets;
}

async function main() {
  const brokers = loadBrokers();
  const docBrokerId = process.argv[2] ?? brokers[0].vistaBrokerId;
  const DOC_URL = `https://${docBrokerId}-rest.vistahost.com.br/doc/`;

  const res = await fetch(DOC_URL);
  if (!res.ok) throw new Error(`GET ${DOC_URL} -> ${res.status}`);
  const html = await res.text();
  const m = html.match(/<script id="swagger-data"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("swagger-data script not found in HTML");
  const { spec } = JSON.parse(m[1]);

  const lines = [];
  const push = (...xs) => lines.push(...xs);

  push(
    "version: 1",
    "integration:",
    "  id: vista-crm",
    "  description: >",
    "    Vistasoft REST API — one HTTP target per Vista broker_integration (see examples/vista-brokers-staging.json).",
    "    Each target base_url is https://{vistaBrokerId}-rest.vistahost.com.br.",
    "    Operations are generated from OpenAPI embedded in /doc/ on that host.",
    "    Store API keys with: hexlane credential set --target <target-id> --token <params.key from BSP> — never commit keys.",
    "    Default broker for op run (no target prefix) is the first target in the list below (sorted by target id).",
    "    Use <target-id>/<op-name> or vista-crm/<op-name> --target <id> for other brokers.",
    "",
    "  targets:",
  );

  for (const t of brokers) {
    push(`    - id: ${t.id}`);
    push(`      tool: http`);
    push(`      config:`);
    push(`        base_url: https://${t.vistaBrokerId}-rest.vistahost.com.br`);
    push(`      credential:`);
    push(`        kind: api_token`);
    push(`        acquire_strategy:`);
    push(`          kind: static`);
    push(`        auth:`);
    push(`          kind: query_param`);
    push(`          name: key`);
    push("");
  }

  push("  operations:");

  for (const [p, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;

      const opName = uniqueOpName(method, p);
      const tagSlug = slugTag((op.tags && op.tags[0]) || "vista");
      const pathTemplate = p.replace(/\{([^}]+)\}/g, (_, name) => `{{ ${safeParamName(name)} }}`);

      const rawParams = [...(op.parameters ?? [])];
      const extraKey = `${method} ${p}`;
      if (EXTRA_QUERY[extraKey]) {
        for (const e of EXTRA_QUERY[extraKey]) {
          if (!rawParams.some((x) => x.name === e.name)) {
            rawParams.push({
              name: e.name,
              in: "query",
              required: true,
              description: e.description,
              schema: { type: "string" },
            });
          }
        }
      }

      const paramSpecs = [];
      const query = {};
      const usedNames = new Set();

      for (const par of rawParams) {
        const pname = safeParamName(par.name);
        if (usedNames.has(pname)) continue;
        usedNames.add(pname);

        const desc = [par.description, par.schema?.type ? `(${par.schema.type})` : ""]
          .filter(Boolean)
          .join(" ")
          .trim();

        const typ =
          par.schema?.type === "integer"
            ? "integer"
            : par.schema?.type === "number"
              ? "number"
              : par.schema?.type === "boolean"
                ? "boolean"
                : "string";

        const where = par.in === "path" ? "path" : "query";

        paramSpecs.push({
          pname,
          type: typ,
          description: yamlEscapeOneLine(desc || par.name),
        });

        if (where === "query") query[par.name] = `{{ ${pname} }}`;
      }

      const summary = yamlEscapeOneLine(op.summary || op.operationId || opName);

      push(`    - name: ${opName}`);
      push(`      tool: http`);
      push(`      description: "${summary}"`);
      push(`      tags: ["${tagSlug}"]`);
      if (!methodReadOnly(method)) push(`      readOnly: false`);

      if (paramSpecs.length > 0) {
        push(`      parameters:`);
        for (const ps of paramSpecs) {
          push(`        - name: ${ps.pname}`);
          push(`          type: ${ps.type}`);
          push(`          required: true`);
          push(`          description: "${ps.description}"`);
        }
      }

      push(`      execution:`);
      push(`        method: ${method.toUpperCase()}`);
      push(`        path: ${pathTemplate}`);
      if (Object.keys(query).length > 0) {
        push(`        query:`);
        for (const [k, v] of Object.entries(query)) {
          push(`          ${k}: "${v}"`);
        }
      }
      push("");
    }
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join("\n"), "utf8");
  console.log(`Wrote ${OUT} (${lines.length} lines), ${brokers.length} targets`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
