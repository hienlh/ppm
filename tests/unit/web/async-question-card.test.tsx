import { describe, expect, it } from "bun:test";
import { useState } from "react";
import { AsyncQuestionCard, AsyncQuestionContext } from "../../../src/web/components/chat/async-question-card.tsx";
import { QuestionCard } from "../../../src/web/components/chat/question-card.tsx";
import { mount, click } from "../../helpers/react-dom.tsx";
import { formatQuestionReply } from "../../../src/shared/chat-questions.ts";
import type { ChatMessage } from "../../../src/types/chat.ts";

const questions = [{ id: "db", question: "Which database?", options: [{ label: "SQLite" }, { label: "Postgres" }] }];

function Harness({ sent, history = [] }: { sent: string[]; history?: ChatMessage[] }) {
  const [messages, setMessages] = useState(history);
  return <AsyncQuestionContext.Provider value={{ messages, onSend: (content) => {
    sent.push(content);
    setMessages((previous) => [...previous, { id: "answer", role: "user", content, timestamp: new Date().toISOString() }]);
  } }}><AsyncQuestionCard itemId="ask-1" questions={questions} /></AsyncQuestionContext.Provider>;
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

  it("restores the answered state from the user message after remount", async () => {
    const history: ChatMessage[] = [{ id: "answer", role: "user", timestamp: "now",
      content: formatQuestionReply("ask-1", questions, { db: "Postgres" }) }];
    const view = await mount(<Harness sent={[]} history={history} />);
    try {
      expect(view.container.textContent).toContain("Postgres");
      expect(view.container.textContent).toContain("Response sent");
      expect(button(view.container, "Submit")).toBeNull();
    } finally { await view.unmount(); }
  });

  it("sends an explicit skip instead of submitting the first option", async () => {
    const sent: string[] = [];
    const view = await mount(<Harness sent={sent} />);
    try {
      await click(button(view.container, "Skip"));
      expect(sent).toEqual([formatQuestionReply("ask-1", questions)]);
      expect(view.container.textContent).toContain("Skipped by the user");
    } finally { await view.unmount(); }
  });

  it("does not steal focus from the composer", async () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const view = await mount(<Harness sent={[]} />);
    try { expect(document.activeElement).toBe(input); }
    finally { await view.unmount(); input.remove(); }
  });

  it("does not offer a submit action without a connected sender", async () => {
    const view = await mount(<AsyncQuestionCard itemId="ask-1" questions={questions} />);
    try {
      expect(view.container.textContent).toContain("Connect to answer");
      expect(button(view.container, "Submit")).toBeNull();
    } finally { await view.unmount(); }
  });

  it("keeps Claude question-text answer keys when no ID is provided", async () => {
    const answers: unknown[] = [];
    const view = await mount(<QuestionCard questions={[{ question: "Which database?", options: [{ label: "SQLite" }] }]}
      onSubmit={(value) => answers.push(value)} onSkip={() => {}} />);
    try {
      await click(button(view.container, "SQLite"));
      await click(button(view.container, "Submit"));
      expect(answers).toEqual([{ "Which database?": "SQLite" }]);
    } finally { await view.unmount(); }
  });
});
