/**
 * Copies of the JSON Schemas the Future Graph extension sends to `ppm.ai.complete`
 * (`src/ai/expansion-schema.ts`, `src/ai/merge-judge-prompts.ts`,
 * `src/convergence/rollout-schema.ts` in that repository), so the validator is tested against
 * what a real caller asks for: `integer`, union types with `null`, `pattern`,
 * `minLength`/`maxLength` and `additionalProperties: false`.
 */

const text = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const probability = { type: "number", minimum: 0, maximum: 1 };

function strictObject(properties: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}

export function expansionSchema(years: { min: number; max: number }): Record<string, unknown> {
  const source = strictObject({
    url: { type: "string", pattern: "^https?://", maxLength: 2000 },
    title: text(300),
    lang: text(16),
  });
  const signal = strictObject({
    text_vi: text(300),
    expected_by: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    probability,
  });
  const child = strictObject({
    title_vi: text(120),
    summary_vi: text(1200),
    horizon_year: { type: "integer", minimum: years.min, maximum: years.max },
    prob_low: probability,
    prob_high: probability,
    cond_prob: probability,
    rationale_vi: text(1200),
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    impact_vi: text(1200),
    prep_actions_vi: { type: "array", minItems: 1, maxItems: 5, items: text(300) },
    sources: { type: "array", minItems: 1, maxItems: 6, items: source },
    signals: { type: "array", minItems: 1, maxItems: 4, items: signal },
  });
  return strictObject({ children: { type: "array", minItems: 3, maxItems: 5, items: child } });
}

export const JUDGE_A_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["match_id", "score", "reason_vi"],
  properties: {
    match_id: { type: ["string", "null"] },
    score: { type: "number", minimum: 0, maximum: 1 },
    reason_vi: { type: "string", maxLength: 1200 },
  },
};

export const JUDGE_B_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["same", "score", "reason_vi"],
  properties: {
    same: { type: "boolean" },
    score: { type: "number", minimum: 0, maximum: 1 },
    reason_vi: { type: "string", maxLength: 1200 },
  },
};

export function rolloutSchema(years: { min: number; max: number }): Record<string, unknown> {
  const t = { type: "string", minLength: 1, maxLength: 300 };
  return {
    type: "object",
    required: ["path", "outcome_id", "confidence"],
    additionalProperties: false,
    properties: {
      path: {
        type: "array",
        minItems: 2,
        maxItems: 12,
        items: {
          type: "object",
          required: ["year", "event_vi"],
          additionalProperties: false,
          properties: { year: { type: "integer", minimum: years.min, maximum: years.max }, event_vi: t },
        },
      },
      outcome_id: { type: ["string", "null"] },
      new_outcome_vi: t,
      confidence: { type: "string", enum: ["low", "medium", "high"] },
    },
  };
}

/** A child that fits `expansionSchema({ min: 2027, max: 2035 })`. */
export function validChild(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title_vi: "Lãi suất giảm",
    summary_vi: "Ngân hàng trung ương hạ lãi suất hai lần.",
    horizon_year: 2028,
    prob_low: 0.2,
    prob_high: 0.4,
    cond_prob: 0.3,
    rationale_vi: "Lạm phát hạ nhiệt.",
    confidence: "medium",
    impact_vi: "Chi phí vay rẻ hơn.",
    prep_actions_vi: ["Theo dõi lãi suất"],
    sources: [{ url: "https://example.com/a", title: "Báo cáo", lang: "en" }],
    signals: [{ text_vi: "CPI giảm", expected_by: "2027-06-30", probability: 0.5 }],
    ...overrides,
  };
}
