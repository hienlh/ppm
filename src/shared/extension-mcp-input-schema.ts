/**
 * The input schema of an extension's tool, checked when its toolset registers. Claude's API reads
 * every tool's `input_schema` as JSON Schema and refuses the whole request over one it cannot
 * use, so a bad schema would break every turn of every chat bound to that toolset — and, saved
 * as the last-known definition, outlive the extension's own fix. It is refused here instead.
 *
 * A structural check of the subset tool schemas use, not a meta-schema validator:
 * - every keyword that holds a schema holds one (an object, or `true`/`false`);
 * - `type` names JSON Schema types, alone or as a list without repeats;
 * - `required` lists unique strings, each a declared property when `properties` is given;
 * - `$ref` points inside this schema (`#/...`) at something that exists; `$id`, `$dynamicRef`
 *   and `$recursiveRef` are refused, so nothing is fetched and nothing re-bases a reference;
 * - counts, bounds and patterns have the types the keywords need, and a pattern compiles;
 * - nesting stops at {@link MAX_EXTENSION_TOOL_SCHEMA_DEPTH} levels.
 * Keywords it does not know pass, as JSON Schema ignores them. The root being `type: "object"`
 * and the size cap are checked by the caller.
 */

export const MAX_EXTENSION_TOOL_SCHEMA_DEPTH = 16;

const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const SCHEMA_KEYS = [
  "items", "additionalProperties", "not", "if", "then", "else", "contains", "propertyNames",
  "unevaluatedProperties", "unevaluatedItems",
];
const SCHEMA_LIST_KEYS = ["anyOf", "oneOf", "allOf", "prefixItems"];
const SCHEMA_MAP_KEYS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const COUNT_KEYS = ["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties", "minContains", "maxContains"];
const NUMBER_KEYS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"];
const STRING_KEYS = ["title", "description", "format", "$schema", "$comment", "$anchor"];
const REFUSED_KEYS = ["$id", "$dynamicRef", "$dynamicAnchor", "$recursiveRef", "$recursiveAnchor"];

type Node = Record<string, unknown>;
const isObject = (v: unknown): v is Node => !!v && typeof v === "object" && !Array.isArray(v);
const has = (node: Node, key: string): boolean => Object.prototype.hasOwnProperty.call(node, key);

/** Whether a `#/...` JSON pointer names a schema inside `root`. */
function resolvesInside(root: Node, ref: string): boolean {
  if (ref === "#") return true;
  if (!ref.startsWith("#/")) return false;
  let node: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    let part: string;
    try {
      part = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    } catch {
      return false;
    }
    if (Array.isArray(node) && /^(0|[1-9][0-9]*)$/.test(part)) node = node[Number(part)];
    else if (isObject(node) && has(node, part)) node = node[part];
    else return false;
  }
  return isObject(node) || typeof node === "boolean";
}

function checkType(type: unknown, where: string): void {
  const list = Array.isArray(type) ? type : [type];
  const ok = list.length > 0 && list.every((t) => typeof t === "string" && TYPES.has(t)) && new Set(list).size === list.length;
  if (!ok) throw new Error(`${where}.type must be one of ${[...TYPES].join(", ")}, or a list of them without repeats`);
}

function checkRequired(node: Node, where: string): void {
  const required = node.required;
  if (!Array.isArray(required) || !required.every((r) => typeof r === "string") || new Set(required).size !== required.length) {
    throw new Error(`${where}.required must be a list of property names without repeats`);
  }
  if (!isObject(node.properties)) return;
  const properties = node.properties;
  const missing = required.find((name) => !has(properties, name as string));
  if (missing !== undefined) throw new Error(`${where}.required names "${String(missing).slice(0, 60)}", which is not in properties`);
}

function checkScalars(node: Node, where: string): void {
  for (const key of STRING_KEYS) {
    if (has(node, key) && typeof node[key] !== "string") throw new Error(`${where}.${key} must be a string`);
  }
  for (const key of COUNT_KEYS) {
    const value = node[key];
    if (has(node, key) && !(Number.isInteger(value) && (value as number) >= 0)) throw new Error(`${where}.${key} must be a whole number of 0 or more`);
  }
  for (const key of NUMBER_KEYS) {
    if (has(node, key) && !(typeof node[key] === "number" && Number.isFinite(node[key]))) throw new Error(`${where}.${key} must be a number`);
  }
  if (has(node, "pattern")) {
    let ok = typeof node.pattern === "string";
    if (ok) {
      try { new RegExp(node.pattern as string); } catch { ok = false; }
    }
    if (!ok) throw new Error(`${where}.pattern must be a regular expression`);
  }
  if (has(node, "enum") && !(Array.isArray(node.enum) && node.enum.length > 0)) throw new Error(`${where}.enum must be a list of at least one value`);
}

function checkNode(node: unknown, where: string, depth: number, root: Node): void {
  if (typeof node === "boolean") return;
  if (!isObject(node)) throw new Error(`${where} must be a schema (an object, or true/false)`);
  if (depth > MAX_EXTENSION_TOOL_SCHEMA_DEPTH) throw new Error(`${where} nests deeper than ${MAX_EXTENSION_TOOL_SCHEMA_DEPTH} levels`);
  for (const key of REFUSED_KEYS) {
    if (has(node, key)) throw new Error(`${where}.${key} is not supported: a tool's schema must be self-contained`);
  }
  if (has(node, "$ref") && !(typeof node.$ref === "string" && resolvesInside(root, node.$ref))) {
    throw new Error(`${where}.$ref must point inside the schema ("#/$defs/...") at a definition that exists`);
  }
  if (has(node, "type")) checkType(node.type, where);
  if (has(node, "required")) checkRequired(node, where);
  checkScalars(node, where);
  for (const key of SCHEMA_KEYS) {
    if (!has(node, key)) continue;
    const child = node[key];
    if (typeof child !== "boolean" && !isObject(child)) throw new Error(`${where}.${key} must be a schema (an object, or true/false)`);
    checkNode(child, `${where}.${key}`, depth + 1, root);
  }
  for (const key of SCHEMA_LIST_KEYS) {
    if (!has(node, key)) continue;
    const list = node[key];
    if (!Array.isArray(list) || list.length === 0) throw new Error(`${where}.${key} must be a list of at least one schema`);
    list.forEach((child, i) => checkNode(child, `${where}.${key}[${i}]`, depth + 1, root));
  }
  for (const key of SCHEMA_MAP_KEYS) {
    if (!has(node, key)) continue;
    const map = node[key];
    if (!isObject(map)) throw new Error(`${where}.${key} must be an object of schemas`);
    for (const [name, child] of Object.entries(map)) checkNode(child, `${where}.${key}.${name.slice(0, 60)}`, depth + 1, root);
  }
}

/** Throws, naming the first problem, when `schema` is not one Claude's API can take as a tool's input. */
export function checkToolInputSchema(schema: Record<string, unknown>, where: string): void {
  checkNode(schema, where, 1, schema);
}
