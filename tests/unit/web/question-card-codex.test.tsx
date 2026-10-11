/**
 * A Codex question used to render as an empty form: the card's input was a capped JSON string
 * and the form read `input.questions`. The form now reads the normalized questions — Codex's
 * own ids, single choice, a typed answer only where the question takes one, a secret typed
 * unseen — and answers by question id, for Claude's questions as much as Codex's.
 */
import { afterAll, afterEach, expect, it } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";
import { normalizeClaudeQuestions, normalizeCodexQuestions, type AnswersById } from "../../../src/shared/approval-questions";

installDom();
afterAll(uninstallDom);
const { QuestionCard } = await import("../../../src/web/components/chat/question-card");
const { approvalFromWire, approvalQuestions } = await import("../../../src/web/lib/approval-request");

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

async function type(el: HTMLInputElement, text: string): Promise<void> {
  const { act } = await import("react");
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const button = (label: string) => [...view!.container.querySelectorAll("button")].find((b) => b.textContent?.includes(label))!;
const option = (label: string) => [...view!.container.querySelectorAll("[role=button]")].find((b) => b.textContent?.includes(label))!;

const CODEX_PARAMS = {
  questions: [
    { id: "env", header: "Target", question: "Deploy where?", isOther: false, isSecret: false, options: [{ label: "staging", description: "safe" }, { label: "prod", description: "live" }] },
    { id: "token", header: "Token", question: "Paste the deploy token", isOther: false, isSecret: true, options: null },
  ],
};

it("shows a Codex card's questions and options from the wire, and answers by id", async () => {
  const questions = normalizeCodexQuestions(CODEX_PARAMS);
  const approval = approvalFromWire({ requestId: "r1", tool: "AskUserQuestion", input: { questions }, questions })!;
  const sent: AnswersById[] = [];
  view = await mount(<QuestionCard questions={approvalQuestions(approval)} onSubmit={(a) => sent.push(a)} onSkip={() => {}} />);

  const text = view.container.textContent ?? "";
  expect(text).toContain("Deploy where?");
  expect(text).toContain("staging");
  expect(text).toContain("prod");
  // A choice without "other" offers no typed row.
  expect(view.container.querySelector("input")).toBeNull();
  await click(option("prod"));

  await click(button("Token"));
  expect(view.container.textContent).toContain("Paste the deploy token");
  const input = view.container.querySelector("input")!;
  expect(input.type).toBe("password");
  await type(input, "s3cret");

  await click(button("Submit"));
  expect(sent).toEqual([{ env: ["prod"], token: ["s3cret"] }]);
});

it("answers Claude's questions by id too, several choices as a list", async () => {
  const questions = normalizeClaudeQuestions({
    questions: [{ question: "Which features?", header: "Features", options: [{ label: "Auth" }, { label: "Billing" }], multiSelect: true }],
  });
  const sent: AnswersById[] = [];
  view = await mount(<QuestionCard questions={questions} onSubmit={(a) => sent.push(a)} onSkip={() => {}} />);
  await click(option("Auth"));
  await click(option("Billing"));
  await click(button("Submit"));
  expect(sent).toEqual([{ q1: ["Auth", "Billing"] }]);
});

it("falls back to Claude's tool input when the card carries no normalized questions", () => {
  const approval = approvalFromWire({ requestId: "r2", tool: "AskUserQuestion", input: { questions: [{ question: "Go?", options: [{ label: "Yes" }] }] } })!;
  expect(approvalQuestions(approval).map((q) => [q.id, q.question])).toEqual([["q1", "Go?"]]);
});
