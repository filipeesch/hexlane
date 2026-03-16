import { describe, it, expect } from "vitest";
import { renderTemplate, renderApiExecution, renderDbExecution, TemplateRenderError, extractTemplateVars } from "../renderer.js";
import type { ApiExecution, DbExecution } from "../schema.js";

describe("renderTemplate", () => {
    it("substitutes a single variable", () => {
        expect(renderTemplate("/orders/{{ orderId }}", { orderId: 123 })).toBe("/orders/123");
    });

    it("substitutes multiple variables", () => {
        expect(renderTemplate("/orders/{{ orderId }}/items/{{ itemId }}", { orderId: 1, itemId: 2 }))
            .toBe("/orders/1/items/2");
    });

    it("handles whitespace inside braces", () => {
        expect(renderTemplate("{{  name  }}", { name: "hello" })).toBe("hello");
    });

    it("substitutes the same variable more than once", () => {
        expect(renderTemplate("{{ x }}/{{ x }}", { x: "foo" })).toBe("foo/foo");
    });

    it("leaves unrelated text untouched", () => {
        expect(renderTemplate("/static/path", {})).toBe("/static/path");
    });

    it("throws TemplateRenderError for unknown variable", () => {
        expect(() => renderTemplate("/orders/{{ unknown }}", { orderId: 1 }))
            .toThrow(TemplateRenderError);
    });

    it("converts boolean false to string 'false'", () => {
        expect(renderTemplate("{{ flag }}", { flag: false })).toBe("false");
    });
});

describe("extractTemplateVars", () => {
    it("extracts variable names from a template", () => {
        const vars = extractTemplateVars("/orders/{{ orderId }}/items/{{ itemId }}");
        expect(vars).toEqual(["orderId", "itemId"]);
    });

    it("returns empty array for no variables", () => {
        expect(extractTemplateVars("/static")).toEqual([]);
    });
});

describe("renderApiExecution", () => {
    const exec: ApiExecution = {
        method: "GET",
        path: "/orders/{{ orderId }}",
        headers: { "X-Client": "{{ clientId }}" },
        body: '{"note":"{{ note }}"}',
    };

    it("renders path, headers, and body", () => {
        const result = renderApiExecution(exec, { orderId: "123", clientId: "app1", note: "hello" });
        expect(result.path).toBe("/orders/123");
        expect(result.headers!["X-Client"]).toBe("app1");
        expect(result.body).toBe('{"note":"hello"}');
        expect(result.method).toBe("GET");
    });

    it("omits headers and body when not in exec", () => {
        const simple: ApiExecution = { method: "DELETE", path: "/orders/{{ id }}" };
        const result = renderApiExecution(simple, { id: "5" });
        expect(result.headers).toBeUndefined();
        expect(result.body).toBeUndefined();
    });

    it("throws on unknown template variable in path", () => {
        expect(() => renderApiExecution(exec, { orderId: "1", clientId: "x" }))
            .toThrow(TemplateRenderError);
    });
});

describe("renderDbExecution", () => {
    const exec: DbExecution = { sql: "SELECT * FROM orders WHERE id = :orderId" };

    it("returns sql unchanged and passes params through", () => {
        const result = renderDbExecution(exec, { orderId: 42 });
        expect(result.sql).toBe("SELECT * FROM orders WHERE id = :orderId");
        expect(result.params["orderId"]).toBe(42);
    });
});
