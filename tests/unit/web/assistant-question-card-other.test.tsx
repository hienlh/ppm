/**
 * A chat's question shown as a PPM Assistant card ("Needs your answer") is answered with the very
 * form the chat shows (`chat/question-card.tsx`): the same options, the same "Other" field (also on
 * several-choice questions, and alone on a question with no options), the same Submit and Skip. The
 * card sends what that form produces — answers by question id, typed words alone in place of the
 * options — and Skip declines the question as Skip in the chat does. Only the frame is the card's:
 * who asked, and Open chat. A secret is still answered in the chat, and a card no longer waiting
 * shows what was asked as text.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { AssistantCard } = await import("../../../src/web/components/assistant/cards/assistant-card");
const { QuestionCard } = await import("../../../src/web/components/chat/question-card");
const { answerableOnCard } = await import("../../../src/web/components/assistant/cards/approval-mirror-card");
const { api } = await import("../../../src/web/lib/api-client");
type Card = import("../../../src/shared/assistant-cards").AssistantCard;
type Questions = NonNullable<Card["payload"]["questions"]>;

const card = (questions: Questions): Card => ({
  id: "22222222-2222-2222-2222-222222222222", kind: "question", projectName: "api", projectKey: "k", sessionId: "chat-1",
  title: "Question", body: "", payload: { requestId: "q", questions, chat: { title: "Fix login", providerId: "claude" } } as Card["payload"],
  status: "open", answer: null, provenance: null, createdAt: Date.now(), updatedAt: Date.now(),
});

let view: Mounted | null = null;
let posts: Array<{ url: string; body: unknown }> = [];
const spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  posts = [];
  spies.push(spyOn(api, "post").mockImplementation((async (url: string, body: unknown) => { posts.push({ url, body }); return {}; }) as never));
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const s of spies.splice(0)) s.mockRestore();
});

async function typeInto(el: Element | null, value: string): Promise<void> {
  if (!el) throw new Error("no such field");
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const q = (sel: string) => view!.container.querySelector(sel);
const button = (text: string) => [...view!.container.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(text))!;
const option = (i: number) => q(`[data-question-option="${i}"]`)!;
const other = () => q("[data-question-other] input");

describe("question card: the chat's own form", () => {
  it("draws the chat's form inside the card, between the card's own header and footer", async () => {
    const questions = [{ id: "q1", question: "Which approach?", multiSelect: false, allowsFreeText: true, options: [{ label: "A" }, { label: "B" }, { label: "C" }] }];
    view = await mount(<AssistantCard card={card(questions)} />);
    const form = q("[data-card-question-form] [data-question-card]");
    expect(form).not.toBeNull();
    expect(view.container.textContent).toContain("Asked by Chat “Fix login” in api.");
    expect(button("Open chat")).toBeDefined();
    // The same markup the chat draws for the same question.
    const inCard = form!.outerHTML;
    await view.unmount();
    view = await mount(<QuestionCard questions={[{ ...questions[0]!, multiSelect: false, allowsFreeText: true }]} onSubmit={() => {}} onSkip={() => {}} autoFocus={false} />);
    expect(q("[data-question-card]")!.outerHTML).toBe(inCard);
  });

  it("sends typed words in place of the option picked, as the chat does", async () => {
    view = await mount(<AssistantCard card={card([
      { id: "q1", question: "Which approach?", multiSelect: false, allowsFreeText: true, options: [{ label: "A" }, { label: "B" }, { label: "C" }] },
    ])} />);
    await click(option(2));
    expect(option(2).getAttribute("aria-pressed")).toBe("true");
    await typeInto(other(), "  Neither: split it in two PRs  ");
    expect(option(2).getAttribute("aria-pressed")).toBe("false");
    await click(button("Submit"));
    expect(posts).toEqual([{ url: "/api/assistant/cards/22222222-2222-2222-2222-222222222222/answer", body: { answersById: { q1: ["Neither: split it in two PRs"] } } }]);
  });

  it("several questions: tabs, several choices, Other on a several-choice question, and a question with no options", async () => {
    view = await mount(<AssistantCard card={card([
      { id: "q1", question: "Which checks?", multiSelect: true, allowsFreeText: true, options: [{ label: "unit" }, { label: "e2e" }] },
      { id: "q2", question: "Release note?", multiSelect: false, allowsFreeText: true, options: [] },
    ])} />);
    await click(option(0));
    await click(option(1));
    expect(button("Submit").textContent).toContain("(1/2)");
    await click(q('[data-question-tab="1"]'));
    expect(view.container.textContent).toContain("Release note?");
    await typeInto(other(), "Fixes the login loop.");
    await click(button("Submit"));
    expect(posts[0]!.body).toEqual({ answersById: { q1: ["unit", "e2e"], q2: ["Fixes the login loop."] } });
  });

  it("Skip declines the question, as Skip in the chat does", async () => {
    view = await mount(<AssistantCard card={card([
      { id: "q1", question: "Ship?", multiSelect: false, allowsFreeText: true, options: [{ label: "Yes" }] },
    ])} />);
    await click(button("Skip"));
    expect(posts[0]!.body).toEqual({ decision: "deny" });
  });

  it("gives no Other to a question that takes no typed text, and leaves a secret to the chat", async () => {
    view = await mount(<AssistantCard card={card([
      { id: "target", question: "Where to?", multiSelect: false, allowsFreeText: false, options: [{ label: "staging" }, { label: "prod" }] },
    ])} />);
    expect(q("[data-question-card]")).not.toBeNull();
    expect(other()).toBeNull();
    await view.unmount();
    const secret = [{ id: "token", question: "API token?", multiSelect: false, allowsFreeText: true, secret: true, options: [] }] as unknown as Questions;
    view = await mount(<AssistantCard card={card(secret)} />);
    expect(q("[data-question-card]")).toBeNull();
    expect(view.container.textContent).toContain("Answer it in the chat.");
  });

  it("shows what was asked as text once the card no longer waits", async () => {
    view = await mount(<AssistantCard card={{ ...card([
      { id: "q1", question: "Which?", multiSelect: false, allowsFreeText: true, options: [{ label: "A" }, { label: "B" }] },
    ]), status: "answered", answer: { by: "user", channel: "telegram", at: Date.now(), approved: true } } as Card} />);
    expect(q("[data-question-card]")).toBeNull();
    expect(q('[data-card-question="q1"]')!.textContent).toBe("Which?AB");
    expect([...view.container.querySelectorAll("button")].map((b) => b.textContent?.trim())).not.toContain("Skip");
  });

  it("counts a no-option question answerable only when it takes typed text", () => {
    expect(answerableOnCard([{ id: "a", question: "?", allowsFreeText: true, options: [] }])).toBe(true);
    expect(answerableOnCard([{ id: "a", question: "?", allowsFreeText: false, options: [] }])).toBe(false);
    expect(answerableOnCard([])).toBe(false);
  });
});
