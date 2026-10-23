/**
 * A tool's input schema is checked when its toolset registers: Claude's API refuses a whole
 * request over one schema it cannot use, so a bad one must never reach a chat's turn.
 */
import { describe, expect, it } from "bun:test";
import { validateToolset } from "../../../src/shared/extension-mcp.ts";

const withSchema = (inputSchema: unknown) =>
  ({ id: "fg", title: "Graph", tools: [{ name: "overview", description: "Overview", inputSchema }] });
const accept = (inputSchema: unknown) => validateToolset(withSchema(inputSchema)).tools[0]!.inputSchema;
const refuse = (inputSchema: unknown, message: RegExp) => expect(() => validateToolset(withSchema(inputSchema))).toThrow(message);

/** `depth` object schemas, each the only property of the one around it. */
function nested(depth: number): Record<string, unknown> {
  let schema: Record<string, unknown> = { type: "object" };
  for (let i = 1; i < depth; i++) schema = { type: "object", properties: { next: schema } };
  return schema;
}

describe("extension tool input schemas", () => {
  it("accepts the schemas tools are written with", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      description: "Expand one node",
      properties: {
        nodeId: { type: "string", minLength: 1, maxLength: 64, pattern: "^n[0-9]+$" },
        depth: { type: "integer", minimum: 1, maximum: 5, default: 1 },
        mode: { enum: ["fast", "deep"] },
        weight: { type: ["number", "null"] },
        tags: { type: "array", items: { type: "string" }, maxItems: 10, uniqueItems: true },
        target: { $ref: "#/$defs/target" },
        either: { anyOf: [{ type: "string" }, { type: "boolean" }] },
        anything: true,
      },
      required: ["nodeId"],
      additionalProperties: false,
      $defs: { target: { type: "object", properties: { year: { type: "integer" } } } },
    };
    expect(accept(schema)).toEqual(schema);
    expect(accept({ type: "object" })).toEqual({ type: "object" });
    expect(accept(nested(16))).toEqual(nested(16));
  });

  it("refuses a schema whose root is not an object schema", () => {
    refuse({ type: "string" }, /type "object"/);
    refuse({ properties: {} }, /type "object"/);
  });

  it("refuses property maps and property schemas that are not schemas", () => {
    refuse({ type: "object", properties: [] }, /properties must be an object/);
    refuse({ type: "object", properties: { x: "string" } }, /properties\.x must be a schema/);
    refuse({ type: "object", properties: { x: null } }, /properties\.x must be a schema/);
    refuse({ type: "object", $defs: { a: 3 } }, /\$defs\.a must be a schema/);
  });

  it("refuses a type that is not a JSON Schema type", () => {
    refuse({ type: "object", properties: { x: { type: "strng" } } }, /properties\.x\.type/);
    refuse({ type: "object", properties: { x: { type: [] } } }, /properties\.x\.type/);
    refuse({ type: "object", properties: { x: { type: ["string", "text"] } } }, /properties\.x\.type/);
    refuse({ type: "object", properties: { x: { type: ["string", "string"] } } }, /properties\.x\.type/);
  });

  it("refuses a required list that is not unique strings naming properties", () => {
    refuse({ type: "object", properties: { x: { type: "string" } }, required: "x" }, /required/);
    refuse({ type: "object", properties: { x: { type: "string" } }, required: [1] }, /required/);
    refuse({ type: "object", properties: { x: { type: "string" } }, required: ["x", "x"] }, /required/);
    refuse({ type: "object", properties: { x: { type: "string" } }, required: ["y"] }, /required.*"y"/);
  });

  it("refuses a reference that leaves the schema or points at nothing", () => {
    refuse({ type: "object", properties: { x: { $ref: "https://example.com/s.json" } } }, /\$ref/);
    refuse({ type: "object", properties: { x: { $ref: "other.json#/a" } } }, /\$ref/);
    refuse({ type: "object", properties: { x: { $ref: "#/$defs/missing" } } }, /\$ref/);
    refuse({ type: "object", properties: { x: { $ref: 5 } } }, /\$ref/);
    refuse({ type: "object", $id: "https://example.com/s.json" }, /\$id/);
    refuse({ type: "object", properties: { x: { $dynamicRef: "#meta" } } }, /\$dynamicRef/);
  });

  it("refuses keywords whose values cannot be what the keyword needs", () => {
    refuse({ type: "object", properties: { x: { type: "array", items: 5 } } }, /items must be a schema/);
    refuse({ type: "object", properties: { x: { type: "array", items: [{ type: "string" }] } } }, /items must be a schema/);
    refuse({ type: "object", properties: { x: { enum: [] } } }, /enum/);
    refuse({ type: "object", properties: { x: { anyOf: { type: "string" } } } }, /anyOf/);
    refuse({ type: "object", properties: { x: { oneOf: [] } } }, /oneOf/);
    refuse({ type: "object", properties: { x: { type: "string", pattern: "(" } } }, /pattern/);
    refuse({ type: "object", properties: { x: { type: "string", minLength: -1 } } }, /minLength/);
    refuse({ type: "object", properties: { x: { type: "number", maximum: "5" } } }, /maximum/);
    refuse({ type: "object", properties: { x: { type: "string", description: 3 } } }, /description/);
    refuse({ type: "object", additionalProperties: "no" }, /additionalProperties must be a schema/);
  });

  it("refuses a schema nested deeper than 16 levels", () => {
    refuse(nested(17), /deeper than 16/);
  });
});
