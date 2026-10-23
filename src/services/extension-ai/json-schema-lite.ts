/**
 * A small JSON Schema validator for extension answers. Enforced keywords: `type` (a name or a
 * list of names, `integer` included), `enum`, `const`, `properties`, `required`,
 * `additionalProperties` (boolean or schema), `items` (one schema), `minItems`/`maxItems`,
 * `minLength`/`maxLength` (counted in code points), `pattern`, `minimum`/`maximum` and the
 * numeric `exclusiveMinimum`/`exclusiveMaximum`. Every other keyword (`anyOf`, `$ref`,
 * `format`, …) is ignored, which only makes the check looser, never wrong.
 *
 * `checkSchema` is run before any call is made, so a schema the validator cannot use (an
 * unknown type name, a pattern that does not compile) is refused instead of paid for.
 */

type Schema = Record<string, unknown>;
export interface SchemaProblem {
  path: string;
  message: string;
}

const TYPE_NAMES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
const MAX_DEPTH = 32;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function compilePattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "u");
  } catch {
    return new RegExp(pattern);
  }
}

/** Why `schema` cannot be used, or null when it can. */
export function checkSchema(schema: unknown, path = "$", depth = 0): string | null {
  if (!isObject(schema)) return `${path}: a schema must be an object`;
  if (depth > MAX_DEPTH) return `${path}: the schema is nested too deeply`;
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  for (const t of types) if (typeof t !== "string" || !TYPE_NAMES.has(t)) return `${path}: unknown type ${JSON.stringify(t)}`;
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minItems", "maxItems", "minLength", "maxLength"]) {
    if (schema[key] !== undefined && typeof schema[key] !== "number") return `${path}: ${key} must be a number`;
  }
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) return `${path}: enum must be an array`;
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((r) => typeof r !== "string"))) {
    return `${path}: required must list property names`;
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") return `${path}: pattern must be a string`;
    try { compilePattern(schema.pattern); } catch { return `${path}: pattern does not compile`; }
  }
  if (schema.properties !== undefined) {
    if (!isObject(schema.properties)) return `${path}: properties must be an object`;
    for (const [name, sub] of Object.entries(schema.properties)) {
      const problem = checkSchema(sub, `${path}.${name}`, depth + 1);
      if (problem) return problem;
    }
  }
  const additional = schema.additionalProperties;
  if (additional !== undefined && typeof additional !== "boolean") {
    const problem = checkSchema(additional, `${path}.*`, depth + 1);
    if (problem) return problem;
  }
  if (isObject(schema.items)) return checkSchema(schema.items, `${path}[]`, depth + 1);
  return null;
}

function typeOf(value: unknown, wanted: string): boolean {
  switch (wanted) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "object": return isObject(value);
    case "array": return Array.isArray(value);
    case "null": return value === null;
    default: return false;
  }
}

class Validation {
  problems: SchemaProblem[] = [];
  private patterns = new Map<string, RegExp>();
  constructor(private readonly maxProblems: number) {}

  private fail(path: string, message: string): void {
    if (this.problems.length < this.maxProblems) this.problems.push({ path, message });
  }

  private regex(pattern: string): RegExp {
    let re = this.patterns.get(pattern);
    if (!re) this.patterns.set(pattern, re = compilePattern(pattern));
    return re;
  }

  check(value: unknown, schema: Schema, path: string): void {
    if (this.problems.length >= this.maxProblems) return;
    if (schema.type !== undefined) {
      const types = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
      if (!types.some((t) => typeOf(value, t))) return this.fail(path, `must be ${types.join(" or ")}`);
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
      this.fail(path, `must be one of ${JSON.stringify(schema.enum).slice(0, 200)}`);
    }
    if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
      this.fail(path, `must be ${JSON.stringify(schema.const).slice(0, 200)}`);
    }
    if (typeof value === "string") this.checkString(value, schema, path);
    else if (typeof value === "number") this.checkNumber(value, schema, path);
    else if (Array.isArray(value)) this.checkArray(value, schema, path);
    else if (isObject(value)) this.checkObject(value, schema, path);
  }

  private checkString(value: string, schema: Schema, path: string): void {
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength) this.fail(path, `must have at least ${schema.minLength} characters`);
    if (typeof schema.maxLength === "number" && length > schema.maxLength) this.fail(path, `must have at most ${schema.maxLength} characters`);
    if (typeof schema.pattern === "string" && !this.regex(schema.pattern).test(value)) this.fail(path, `must match ${schema.pattern}`);
  }

  private checkNumber(value: number, schema: Schema, path: string): void {
    if (typeof schema.minimum === "number" && value < schema.minimum) this.fail(path, `must be >= ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) this.fail(path, `must be <= ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) this.fail(path, `must be > ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) this.fail(path, `must be < ${schema.exclusiveMaximum}`);
  }

  private checkArray(value: unknown[], schema: Schema, path: string): void {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) this.fail(path, `must have at least ${schema.minItems} items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) this.fail(path, `must have at most ${schema.maxItems} items`);
    if (isObject(schema.items)) value.forEach((item, i) => this.check(item, schema.items as Schema, `${path}[${i}]`));
  }

  private checkObject(value: Record<string, unknown>, schema: Schema, path: string): void {
    const properties = isObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const name of schema.required as string[]) if (!Object.hasOwn(value, name)) this.fail(`${path}.${name}`, "is required");
    }
    for (const [name, sub] of Object.entries(value)) {
      const known = Object.hasOwn(properties, name) ? properties[name] : undefined;
      if (isObject(known)) this.check(sub, known, `${path}.${name}`);
      else if (schema.additionalProperties === false) this.fail(`${path}.${name}`, "is not allowed");
      else if (isObject(schema.additionalProperties)) this.check(sub, schema.additionalProperties, `${path}.${name}`);
    }
  }
}

/** Every way `value` breaks `schema` (up to `maxProblems`); empty when it fits. */
export function validateJson(value: unknown, schema: Record<string, unknown>, maxProblems = 10): SchemaProblem[] {
  const run = new Validation(maxProblems);
  run.check(value, schema, "$");
  return run.problems;
}

export function formatProblems(problems: SchemaProblem[]): string {
  return problems.map((p) => `${p.path} ${p.message}`).join("; ");
}
