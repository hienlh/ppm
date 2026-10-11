/**
 * Claude and Codex ask questions in different shapes and want their answers back in different
 * shapes. Every surface works with one normalized question and answers by question id; these
 * pin both conversions, using Codex's real `item/tool/requestUserInput` params.
 */
import { describe, expect, it } from "bun:test";
import {
  answersByIdError, answersForDisplay, coerceAnswersById, legacyAnswersToById,
  normalizeClaudeQuestions, normalizeCodexQuestions, questionsFromWire, toProviderAnswers,
} from "../../../src/shared/approval-questions.ts";

const CLAUDE_INPUT = {
  questions: [
    { question: "Which database?", header: "DB", options: [{ label: "Postgres", description: "the usual" }, { label: "SQLite" }], multiSelect: false },
    { question: "Which features?", header: "Features", options: [{ label: "Auth" }, { label: "Billing" }], multiSelect: true },
  ],
};

// Shape of codex app-server's ToolRequestUserInputParams.
const CODEX_PARAMS = {
  threadId: "t", turnId: "u", itemId: "i", isBlocking: true, autoResolutionMs: null,
  questions: [
    { id: "env", header: "Target", question: "Deploy where?", isOther: false, isSecret: false, options: [{ label: "staging", description: "safe" }, { label: "prod", description: "live" }] },
    { id: "note", header: "Note", question: "Anything to add?", isOther: true, isSecret: false, options: [{ label: "No" }] },
    { id: "token", header: "Token", question: "Paste the deploy token", isOther: false, isSecret: true, options: null },
  ],
};

describe("normalizing", () => {
  it("reads Claude's questions with positional ids and free text always allowed", () => {
    expect(normalizeClaudeQuestions(CLAUDE_INPUT)).toEqual([
      { id: "q1", question: "Which database?", header: "DB", options: [{ label: "Postgres", description: "the usual" }, { label: "SQLite" }], multiSelect: false, allowsFreeText: true },
      { id: "q2", question: "Which features?", header: "Features", options: [{ label: "Auth" }, { label: "Billing" }], multiSelect: true, allowsFreeText: true },
    ]);
    expect(normalizeClaudeQuestions("not an object")).toEqual([]);
  });

  it("reads Codex's questions by their own ids: single choice, other, secret", () => {
    const qs = normalizeCodexQuestions(CODEX_PARAMS);
    expect(qs.map((q) => [q.id, q.multiSelect, q.allowsFreeText, q.secret ?? false])).toEqual([
      ["env", false, false, false], ["note", false, true, false], ["token", false, true, true],
    ]);
    expect(qs[0]!.options).toEqual([{ label: "staging", description: "safe" }, { label: "prod", description: "live" }]);
    expect(qs[2]!.options).toEqual([]);
  });

  it("round-trips through the wire and refuses what is not that shape", () => {
    const qs = normalizeCodexQuestions(CODEX_PARAMS);
    expect(questionsFromWire(JSON.parse(JSON.stringify(qs)))).toEqual(qs);
    expect(questionsFromWire([{ question: "no id" }])).toBeUndefined();
    expect(questionsFromWire("x")).toBeUndefined();
  });
});

describe("answers", () => {
  const claude = normalizeClaudeQuestions(CLAUDE_INPUT);
  const codex = normalizeCodexQuestions(CODEX_PARAMS);

  it("gives Claude its own shape, keyed by question text, choices joined", () => {
    expect(toProviderAnswers("claude", claude, { q1: ["SQLite"], q2: ["Auth", "Billing"] }))
      .toEqual({ "Which database?": "SQLite", "Which features?": "Auth, Billing" });
  });

  it("gives Codex every question by id, an unanswered one as an empty list", () => {
    expect(toProviderAnswers("codex", codex, { env: ["prod"], token: ["s3cret"] }))
      .toEqual({ env: ["prod"], note: [], token: ["s3cret"] });
  });

  it("shows answers by question text and never shows a secret", () => {
    expect(answersForDisplay(codex, { env: ["prod"], token: ["s3cret"] }))
      .toEqual({ "Deploy where?": "prod", "Paste the deploy token": "(hidden)" });
  });

  it("reads an older tab's answers by text, by id or by position", () => {
    expect(legacyAnswersToById(claude, { "Which database?": "Postgres", "Which features?": "Auth, Billing" }))
      .toEqual({ q1: ["Postgres"], q2: ["Auth, Billing"] });
    expect(legacyAnswersToById(codex, { env: "staging" })).toEqual({ env: ["staging"] });
    expect(legacyAnswersToById(codex, ["prod", "", "tok"])).toEqual({ env: ["prod"], token: ["tok"] });
  });

  it("coerces leniently: unknown ids and non-strings dropped, one answer for single choice", () => {
    expect(coerceAnswersById(codex, { env: ["prod", "staging"], bogus: ["x"], note: [1, "  "] })).toEqual({ env: ["prod"] });
  });

  it("validates strictly for callers that take answers from an agent or a button", () => {
    expect(answersByIdError(codex, { env: ["prod"], note: ["typed"], token: ["t"] }, { requireAll: true })).toBeNull();
    expect(answersByIdError(codex, { nope: ["x"] })).toContain("not a question");
    expect(answersByIdError(codex, { env: ["live"] })).toContain("not an option");
    expect(answersByIdError(codex, { env: ["prod", "staging"] })).toContain("takes one answer");
    expect(answersByIdError(codex, { env: "prod" })).toContain("list of non-empty strings");
    expect(answersByIdError(codex, { env: ["prod"] }, { requireAll: true })).toContain("missing: note, token");
    expect(answersByIdError(claude, { q1: ["something else"], q2: ["Auth", "Billing"] })).toBeNull();
    expect(answersByIdError(claude, null)).not.toBeNull();
  });
});
