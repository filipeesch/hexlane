import type { ApiExecution, DbExecution } from "./schema.js";
import type { ResolvedParams } from "./param-resolver.js";

/** Pattern for {{ varName }} template variables */
const TEMPLATE_VAR = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export class TemplateRenderError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TemplateRenderError";
    }
}

/**
 * Replace all {{ varName }} occurrences in a template string with values
 * from the resolved params map. Throws if an unknown variable is referenced.
 */
export function renderTemplate(template: string, params: ResolvedParams): string {
    return template.replace(TEMPLATE_VAR, (_match, name: string) => {
        if (!(name in params)) {
            throw new TemplateRenderError(
                `Template references unknown variable "{{ ${name} }}" — no parameter named "${name}" is declared on this operation.`
            );
        }
        return String(params[name]);
    });
}

/**
 * Extract all template variable names from a string without rendering.
 * Used by the validator to check for typos before runtime.
 */
export function extractTemplateVars(template: string): string[] {
    const vars: string[] = [];
    let match: RegExpExecArray | null;
    const re = new RegExp(TEMPLATE_VAR.source, "g");
    while ((match = re.exec(template)) !== null) {
        vars.push(match[1]);
    }
    return vars;
}

// ─── API Execution Renderer ──────────────────────────────────────────────────

export interface RenderedApiExecution {
    method: string;
    path: string;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    body?: string;
}

export function renderApiExecution(
    exec: ApiExecution,
    params: ResolvedParams,
): RenderedApiExecution {
    const path = renderTemplate(exec.path, params);

    let query: Record<string, string> | undefined;
    if (exec.query) {
        query = {};
        for (const [k, v] of Object.entries(exec.query)) {
            query[k] = renderTemplate(v, params);
        }
    }

    let headers: Record<string, string> | undefined;
    if (exec.headers) {
        headers = {};
        for (const [k, v] of Object.entries(exec.headers)) {
            headers[k] = renderTemplate(v, params);
        }
    }

    let body: string | undefined;
    if (exec.body) {
        body = renderTemplate(exec.body, params);
    }

    return { method: exec.method, path, query, headers, body };
}

// ─── DB Execution Renderer ───────────────────────────────────────────────────

export interface RenderedDbExecution {
    /** SQL with :name placeholders — passed to executeDbQuery which handles $N binding */
    sql: string;
    /** Typed params ready for the executor */
    params: ResolvedParams;
}

/**
 * DB execution rendering is intentionally minimal: the SQL is passed through
 * as-is (with :name placeholders) because the existing db-executor already
 * handles :name → $N substitution and pg parameterized binding.
 * The resolved params are passed alongside so the executor can bind them.
 */
export function renderDbExecution(
    exec: DbExecution,
    params: ResolvedParams,
): RenderedDbExecution {
    return { sql: exec.sql, params };
}
