import { describe, expect, it } from "bun:test";
import { checkSchema, formatProblems, validateJson } from "../../../src/services/extension-ai/json-schema-lite.ts";
import { expansionSchema, JUDGE_A_SCHEMA, JUDGE_B_SCHEMA, rolloutSchema, validChild } from "../../fixtures/future-graph-schemas.ts";

const YEARS = { min: 2027, max: 2035 };
const paths = (value: unknown, schema: Record<string, unknown>) => validateJson(value, schema).map((p) => p.path);

describe("json-schema-lite against the extension's real schemas", () => {
  it("accepts every schema the extension sends", () => {
    for (const schema of [expansionSchema(YEARS), JUDGE_A_SCHEMA, JUDGE_B_SCHEMA, rolloutSchema(YEARS)]) {
      expect(checkSchema(schema)).toBeNull();
    }
  });

  it("passes a correct expansion and names each broken field of a wrong one", () => {
    const schema = expansionSchema(YEARS);
    const ok = { children: [validChild(), validChild(), validChild()] };
    expect(validateJson(ok, schema)).toEqual([]);

    const wrong = {
      children: [
        validChild({ horizon_year: 2027.5 }),
        validChild({ sources: [{ url: "ftp://x", title: "t", lang: "en" }] }),
        validChild({ signals: [{ text_vi: "x", expected_by: "30/06/2027", probability: 0.5 }], extra: 1 }),
      ],
    };
    expect(paths(wrong, schema)).toEqual([
      "$.children[0].horizon_year",
      "$.children[1].sources[0].url",
      "$.children[2].signals[0].expected_by",
      "$.children[2].extra",
    ]);
  });

  it("enforces integer, year bounds, counts and lengths", () => {
    const schema = expansionSchema(YEARS);
    expect(paths({ children: [validChild()] }, schema)).toEqual(["$.children"]);
    expect(paths({ children: [validChild({ horizon_year: 2026 }), validChild(), validChild()] }, schema)).toEqual(["$.children[0].horizon_year"]);
    expect(paths({ children: [validChild({ title_vi: "" }), validChild(), validChild()] }, schema)).toEqual(["$.children[0].title_vi"]);
    expect(paths({ children: [validChild({ title_vi: "ư".repeat(121) }), validChild(), validChild()] }, schema)).toEqual(["$.children[0].title_vi"]);
    // Code points, not UTF-16 units: 120 emoji are 240 units and still fit.
    expect(paths({ children: [validChild({ title_vi: "😀".repeat(120) }), validChild(), validChild()] }, schema)).toEqual([]);
  });

  it("takes a type list with null (judge A's match_id, a rollout's outcome_id)", () => {
    expect(validateJson({ match_id: null, score: 0.1, reason_vi: "khác" }, JUDGE_A_SCHEMA)).toEqual([]);
    expect(validateJson({ match_id: "n1", score: 0.9, reason_vi: "giống" }, JUDGE_A_SCHEMA)).toEqual([]);
    expect(formatProblems(validateJson({ match_id: 3, score: 0.9, reason_vi: "x" }, JUDGE_A_SCHEMA))).toBe("$.match_id must be string or null");
    expect(paths({ match_id: null, reason_vi: "x" }, JUDGE_A_SCHEMA)).toEqual(["$.score"]);
  });

  it("leaves an optional property optional and refuses an unknown one", () => {
    const schema = rolloutSchema(YEARS);
    const path = [{ year: 2028, event_vi: "a" }, { year: 2030, event_vi: "b" }];
    expect(validateJson({ path, outcome_id: null, confidence: "low" }, schema)).toEqual([]);
    expect(validateJson({ path, outcome_id: null, new_outcome_vi: "kết cục mới", confidence: "low" }, schema)).toEqual([]);
    expect(paths({ path, outcome_id: null, confidence: "low", note: "x" }, schema)).toEqual(["$.note"]);
    expect(paths({ path: [path[0]], outcome_id: "o", confidence: "sure" }, schema)).toEqual(["$.path", "$.confidence"]);
  });

  it("does not let __proto__ slip past additionalProperties: false", () => {
    expect(paths(JSON.parse('{"same":true,"score":1,"reason_vi":"x","__proto__":{}}'), JUDGE_B_SCHEMA)).toEqual(["$.__proto__"]);
  });
});

describe("json-schema-lite keywords", () => {
  it("ignores keywords it does not enforce", () => {
    const schema = { type: "object", anyOf: [{ required: ["a"] }], properties: { a: { type: "string", format: "email" } } };
    expect(checkSchema(schema)).toBeNull();
    expect(validateJson({ a: "not-an-email" }, schema)).toEqual([]);
  });

  it("checks const, exclusive bounds and an additionalProperties schema", () => {
    expect(paths(1, { const: 2 })).toEqual(["$"]);
    expect(paths(0, { type: "number", exclusiveMinimum: 0 })).toEqual(["$"]);
    expect(paths({ a: 1, b: "x" }, { type: "object", additionalProperties: { type: "integer" } })).toEqual(["$.b"]);
  });

  it("refuses a schema it cannot use before anything is spent", () => {
    expect(checkSchema({ type: "text" })).toContain("unknown type");
    expect(checkSchema({ type: "string", pattern: "(" })).toContain("pattern does not compile");
    expect(checkSchema({ type: "array", maxItems: "3" })).toContain("maxItems must be a number");
    expect(checkSchema({ required: "a" })).toContain("required");
    expect(checkSchema([])).toContain("must be an object");
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 40; i++) deep = { type: "array", items: deep };
    expect(checkSchema(deep)).toContain("nested too deeply");
  });

  it("stops after ten problems", () => {
    const schema = { type: "array", items: { type: "string" } };
    expect(validateJson(Array.from({ length: 50 }, (_, i) => i), schema)).toHaveLength(10);
  });
});

describe("json-schema-lite values and patterns", () => {
  it("compares enum and const objects by value, whatever the key order", () => {
    expect(validateJson({ b: 2, a: 1 }, { enum: [{ a: 1, b: 2 }] })).toEqual([]);
    expect(validateJson({ b: 2, a: [1, { y: 0, x: 1 }] }, { const: { a: [1, { x: 1, y: 0 }], b: 2 } })).toEqual([]);
    expect(paths({ a: 1 }, { const: { a: 1, b: 2 } })).toEqual(["$"]);
    expect(paths([1, 2], { const: [2, 1] })).toEqual(["$"]);
  });

  it("refuses patterns that backtrack without bound before anything is spent", () => {
    for (const pattern of ["^(a+)+$", "(a|aa)*b", "^(\\d+\\.)*$", "(.*a){3}", "(a)\\1", "(?<x>a)\\k<x>", "\\d*\\d*\\d*x", "x".repeat(257)]) {
      expect(checkSchema({ type: "string", pattern })).not.toBeNull();
    }
    for (const pattern of ["^https?://", "^\\d{4}-\\d{2}-\\d{2}$", "^[a-z-]+$", "^(?:ab)?c+$", "[(+)]*x", "\\(a+\\)+"]) {
      expect(checkSchema({ type: "string", pattern })).toBeNull();
    }
  });

  it("never runs a catastrophic pattern on the thread, even when handed one without checkSchema", () => {
    const startedAt = performance.now();
    // 27 a's: long enough to take a measurable while if it ran (each a doubles it), short
    // enough that a build without the guard still finishes this test.
    const problems = validateJson("a".repeat(27) + "b", { type: "string", pattern: "^(a+)+$" });
    expect(performance.now() - startedAt).toBeLessThan(50);
    expect(problems.map((p) => p.message)).toEqual(["cannot be checked against an unsafe pattern"]);
  });

  it("bounds the text tested against the patterns it allows", () => {
    const two = { type: "string", pattern: "\\d*\\d*x" };
    expect(paths("1".repeat(501), two)).toEqual(["$"]);
    const startedAt = performance.now();
    const many = validateJson(Array.from({ length: 40 }, () => "1".repeat(500)), { type: "array", items: two }, 100);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(many.some((p) => p.message.includes("too much text"))).toBe(true);
    // A pattern with no unbounded repeat runs on long strings: a long URL still passes.
    expect(validateJson("https://x.test/" + "q".repeat(3_000), { type: "string", pattern: "^https?://" })).toEqual([]);
  });
});
