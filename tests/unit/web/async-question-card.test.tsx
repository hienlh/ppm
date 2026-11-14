import { describe, expect, it } from "bun:test";
import { useState } from "react";
import { AsyncQuestionCard, AsyncQuestionContext } from "../../../src/web/components/chat/async-question-card.tsx";
import { QuestionCard } from "../../../src/web/components/chat/question-card.tsx";
import { mount, click } from "../../helpers/react-dom.tsx";
import { formatQuestionReply } from "../../../src/shared/chat-questions.ts";
import { normalizeClaudeQuestions, toProviderAnswers, type NormalizedQuestion } from "../../../src/shared/approval-questions.ts";
import type { ChatMessage } from "../../../src/types/chat.ts";

const questions = [{ id: "db", question: "Which database?", options: [{ label: "SQLite" }, { label: "Postgres" }] }];
/** The same question as `QuestionCard` takes it: normalized, with a typed-answer row. */
const cardQuestions: NormalizedQuestion[] = [{ ...questions[0]!, multiSelect: false, allowsFreeText: true }];

function Harness({ sent, history = [], itemId = "ask-1" }: { sent: string[]; history?: ChatMessage[]; itemId?: string }) {
  const [messages, setMessages] = useState(history);
  return <AsyncQuestionContext.Provider value={{ messages, onSend: (content) => {
    sent.push(content);
    setMessages((previous) => [...previous, { id: "answer", role: "user", content, timestamp: new Date().toISOString() }]);
  } }}><AsyncQuestionCard itemId={itemId} questions={questions} /></AsyncQuestionContext.Provider>;
}

const button = (container: HTMLElement, label: string) => Array.from(container.querySelectorAll("button, [role=button]"))
  .find((element) => element.textContent?.includes(label)) ?? null;

describe("async question card", () => {
  it("submits the selection as a follow-up, then renders the answered state", async () => {
    const sent: string[] = [];
    const view = await mount(<Harness sent={sent} />);
    try {
      expect(view.container.textContent).toContain("Which database?");
      await click(button(view.container, "SQLite"));
      await click(button(view.container, "Submit"));
      expect(sent).toEqual([formatQuestionReply("ask-1", questions, { db: "SQLite" })]);
      expect(view.container.textContent).toContain("Response sent");
      expect(button(view.container, "Submit")).toBeNull();
    } finally { await view.unmount(); }
  });

  it("shows the answer as sent at once while the reply waits to reach the conversation", async () => {
    // Mid-turn the reply is pushed to the provider and joins `messages` only when it is taken in;
    // until then the card must not look unanswered, or the user answers again.
    const sent: string[] = [];
    const view = await mount(<AsyncQuestionContext.Provider value={{ messages: [], onSend: (content) => { sent.push(content); } }}>
      <AsyncQuestionCard itemId="ask-pending" questions={questions} />
    </AsyncQuestionContext.Provider>);
    try {
      await click(button(view.container, "Postgres"));
      await click(button(view.container, "Submit"));
      expect(sent).toEqual([formatQuestionReply("ask-pending", questions, { db: "Postgres" })]);
      expect(view.container.textContent).toContain("Response sent");
      expect(button(view.container, "Submit")).toBeNull();
    } finally { await view.unmount(); }
  });

  it("stays closed when it remounts before the reply reaches the conversation", async () => {
    // The card remounts whenever the turn's events regroup. Reopening then let every further click
    // queue another answer to the same question.
    const sent: string[] = [];
    const card = () => <AsyncQuestionContext.Provider value={{ messages: [], onSend: (content) => { sent.push(content); } }}>
      <AsyncQuestionCard itemId="ask-remount" questions={questions} />
    </AsyncQuestionContext.Provider>;
    const first = await mount(card());
    try {
      await click(button(first.container, "SQLite"));
      await click(button(first.container, "Submit"));
    } finally { await first.unmount(); }
    const second = await mount(card());
    try {
      expect(second.container.textContent).toContain("Response sent");
      expect(button(second.container, "Submit")).toBeNull();
      expect(sent).toHaveLength(1);
    } finally { await second.unmount(); }
  });

  it("is closed while its reply waits in the queue", async () => {
    // Another device answered, or this page reloaded: the reply sits in the session's queue only.
    const content = formatQuestionReply("ask-queued", questions, { db: "SQLite" });
    const view = await mount(<AsyncQuestionContext.Provider value={{ messages: [], onSend: () => {},
      queued: [{ id: "q1", content, imageCount: 0, queuedAt: "now" }] }}>
      <AsyncQuestionCard itemId="ask-queued" questions={questions} />
    </AsyncQuestionContext.Provider>);
    try {
      expect(view.container.textContent).toContain("Response sent");
      expect(button(view.container, "Submit")).toBeNull();
    } finally { await view.unmount(); }
  });

  it("restores the answered state from the user message after remount", async () => {
    const history: ChatMessage[] = [{ id: "answer", role: "user", timestamp: "now",
      content: formatQuestionReply("ask-history", questions, { db: "Postgres" }) }];
    const view = await mount(<Harness sent={[]} history={history} itemId="ask-history" />);
    try {
      expect(view.container.textContent).toContain("Postgres");
      expect(view.container.textContent).toContain("Response sent");
      expect(button(view.container, "Submit")).toBeNull();
    } finally { await view.unmount(); }
  });

  it("sends an explicit skip instead of submitting the first option", async () => {
    const sent: string[] = [];
    const view = await mount(<Harness sent={sent} itemId="ask-skip" />);
    try {
      await click(button(view.container, "Skip"));
      expect(sent).toEqual([formatQuestionReply("ask-skip", questions)]);
      expect(view.container.textContent).toContain("Skipped by the user");
    } finally { await view.unmount(); }
  });

  it("does not steal focus from the composer", async () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const view = await mount(<Harness sent={[]} itemId="ask-focus" />);
    try { expect(document.activeElement).toBe(input); }
    finally { await view.unmount(); input.remove(); }
  });

  it("leaves focus in another card when it re-renders", async () => {
    // Two chats side by side, each waiting on its own question: the second card re-renders for
    // reasons of its own (its chat updates, a pane gains focus) while the user types in the first.
    const { act } = await import("react");
    let rerenderSecond = () => {};
    function TwoCards() {
      const [tick, setTick] = useState(0);
      rerenderSecond = () => setTick((value) => value + 1);
      return <>
        <QuestionCard questions={cardQuestions} onSubmit={() => {}} onSkip={() => {}} />
        <div data-tick={tick}><QuestionCard questions={cardQuestions} onSubmit={() => {}} onSkip={() => {}} /></div>
      </>;
    }
    const view = await mount(<TwoCards />);
    try {
      const [firstInput] = Array.from(view.container.querySelectorAll("input"));
      firstInput!.focus();
      await act(async () => { rerenderSecond(); });
      expect(document.activeElement).toBe(firstInput);
    } finally { await view.unmount(); }
  });

  it("does not focus itself again after the user moves elsewhere", async () => {
    // Focusing scrolls the card into view, and the chat re-renders as soon as the user scrolls up
    // (it tracks whether the list is at the bottom). Re-focusing then pinned the list to the card.
    const { act } = await import("react");
    let rerender = () => {};
    function Card() {
      const [tick, setTick] = useState(0);
      rerender = () => setTick((value) => value + 1);
      return <div data-tick={tick}><QuestionCard questions={cardQuestions} onSubmit={() => {}} onSkip={() => {}} /></div>;
    }
    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    const view = await mount(<Card />);
    try {
      expect(view.container.contains(document.activeElement)).toBe(true);
      composer.focus();
      await act(async () => { rerender(); });
      expect(document.activeElement).toBe(composer);
    } finally { await view.unmount(); composer.remove(); }
  });

  it("does not offer a submit action without a connected sender", async () => {
    const view = await mount(<AsyncQuestionCard itemId="ask-offline" questions={questions} />);
    try {
      expect(view.container.textContent).toContain("Connect to answer");
      expect(button(view.container, "Submit")).toBeNull();
    } finally { await view.unmount(); }
  });

  it("keeps Claude question-text answer keys when no ID is provided", async () => {
    // Claude's questions carry no ids: the card answers by the id normalizing gave each, and the
    // server hands Claude the answer keyed by the question's text, as AskUserQuestion expects.
    const claudeQuestions = normalizeClaudeQuestions({ questions: [{ question: "Which database?", options: [{ label: "SQLite" }] }] });
    const answers: Record<string, string[]>[] = [];
    const view = await mount(<QuestionCard questions={claudeQuestions}
      onSubmit={(value) => answers.push(value)} onSkip={() => {}} />);
    try {
      await click(button(view.container, "SQLite"));
      await click(button(view.container, "Submit"));
      expect(answers).toEqual([{ q1: ["SQLite"] }]);
      expect(toProviderAnswers("claude", claudeQuestions, answers[0]!)).toEqual({ "Which database?": "SQLite" });
    } finally { await view.unmount(); }
  });
});
