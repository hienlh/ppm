/**
 * A chat's question shown as a PPM Assistant card ("Needs your answer") offers "Other" — the user's
 * own words — wherever the chat's own form does: under the tiles of a single- and a multi-choice
 * question, and alone on a question with no options. The words go out in place of the tiles, the
 * same answer the chat's form sends; picking a tile again clears them. A question that takes no
 * typed text (a Codex choice without "other") gets no field, and a secret is still answered in the chat.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { AssistantCard } = await import("../../../src/web/components/assistant/cards/assistant-card");
const { answerableOnCard, cardAnswers } = await import("../../../src/web/components/assistant/cards/approval-mirror-card");
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
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const send = () => [...view!.container.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Send answer"))!;
const other = (q: string) => view!.container.querySelector(`[data-card-question="${q}"] [data-card-other-input]`);
const tile = (q: string, letter: string) => view!.container.querySelector(`[data-card-question="${q}"] [data-card-option="${letter}"]`)!;

describe("question card: Other", () => {
  it("sends typed words in place of the tiles on a single-choice question", async () => {
    view = await mount(<AssistantCard card={card([
      { id: "q1", question: "Which approach?", multiSelect: false, allowsFreeText: true, options: [{ label: "A" }, { label: "B" }, { label: "C" }] },
    ])} />);
    expect(other("q1")).not.toBeNull();
    expect((other("q1") as HTMLTextAreaElement).placeholder).toBe("Other: type your own answer…");
    // The row is a 44 px target like every tile, and 16 px text on a phone so focusing does not zoom.
    expect(view.container.querySelector("[data-card-other]")!.className).toContain("min-h-11");
    expect(other("q1")!.className).toContain("text-base");
    await click(tile("q1", "C"));
    expect(tile("q1", "C").getAttribute("aria-checked")).toBe("true");
    await typeInto(other("q1"), "  Neither: split it in two PRs  ");
    expect(tile("q1", "C").getAttribute("aria-checked")).toBe("false");
    expect(send().disabled).toBe(false);
    await click(send());
    expect(posts[0]!.body).toEqual({ answersById: { q1: ["Neither: split it in two PRs"] } });
  });

  it("offers Other on a multi-choice question too, and a tile picked after clears the words", async () => {
    view = await mount(<AssistantCard card={card([
      { id: "q1", question: "Which PRs?", multiSelect: true, allowsFreeText: true, options: [{ label: "#88" }, { label: "#89" }] },
      { id: "q2", question: "Ship?", multiSelect: false, allowsFreeText: true, options: [{ label: "Yes" }, { label: "No" }] },
    ])} />);
    await typeInto(other("q1"), "Only the docs one");
    expect(send().textContent).toBe("Send answers (1/2)");
    await click(tile("q2", "A"));
    expect(send().textContent).toBe("Send answers (2/2)");
    await click(send());
    expect(posts[0]!.body).toEqual({ answersById: { q1: ["Only the docs one"], q2: ["Yes"] } });

    posts = [];
    await click(tile("q1", "B"));
    expect((other("q1") as HTMLTextAreaElement).value).toBe("");
    await click(send());
    expect(posts[0]!.body).toEqual({ answersById: { q1: ["#89"], q2: ["Yes"] } });
  });

  it("answers a question with no options by the field alone", async () => {
    view = await mount(<AssistantCard card={card([
      { id: "q1", question: "What should the release be called?", multiSelect: false, allowsFreeText: true, options: [] },
    ])} />);
    expect(view.container.textContent).not.toContain("Answer it in the chat");
    expect((other("q1") as HTMLTextAreaElement).placeholder).toBe("Type your answer…");
    expect(send().disabled).toBe(true);
    await typeInto(other("q1"), "   ");
    expect(send().disabled).toBe(true);
    await typeInto(other("q1"), "Bluebird");
    await click(send());
    expect(posts[0]!.body).toEqual({ answersById: { q1: ["Bluebird"] } });
  });

  it("gives no field to a question that takes no typed text, and leaves a secret to the chat", async () => {
    view = await mount(<AssistantCard card={card([
      { id: "target", question: "Where to?", multiSelect: false, allowsFreeText: false, options: [{ label: "staging" }, { label: "prod" }] },
    ])} />);
    expect(other("target")).toBeNull();
    await view.unmount();
    const secret = [{ id: "token", question: "API token?", multiSelect: false, allowsFreeText: true, secret: true, options: [] }] as unknown as Questions;
    view = await mount(<AssistantCard card={card(secret)} />);
    expect(other("token")).toBeNull();
    expect(view.container.textContent).toContain("Answer it in the chat.");
  });

  it("shows no field once the card was answered", async () => {
    view = await mount(<AssistantCard card={{ ...card([
      { id: "q1", question: "Which?", multiSelect: false, allowsFreeText: true, options: [{ label: "A" }] },
    ]), status: "answered", answer: { by: "user", channel: "telegram", at: Date.now(), approved: true } } as Card} />);
    expect(other("q1")).toBeNull();
  });
});

describe("cardAnswers / answerableOnCard", () => {
  const qs = [
    { id: "a", question: "?", multiSelect: false, allowsFreeText: true, options: [{ label: "x" }] },
    { id: "b", question: "?", multiSelect: true, allowsFreeText: false, options: [{ label: "y" }, { label: "z" }] },
  ];
  it("prefers the typed words, ignores words where none are taken, leaves unanswered questions out", () => {
    expect(cardAnswers(qs, { a: ["x"], b: ["y", "z"] }, { a: " mine ", b: "ignored" })).toEqual({ a: ["mine"], b: ["y", "z"] });
    expect(cardAnswers(qs, {}, { a: "  " })).toEqual({});
  });
  it("counts a no-option question answerable only when it takes typed text", () => {
    expect(answerableOnCard([{ id: "a", question: "?", allowsFreeText: true, options: [] }])).toBe(true);
    expect(answerableOnCard([{ id: "a", question: "?", allowsFreeText: false, options: [] }])).toBe(false);
    expect(answerableOnCard([])).toBe(false);
  });
});
