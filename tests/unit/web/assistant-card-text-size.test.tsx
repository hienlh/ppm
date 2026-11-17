/**
 * A PPM Assistant card's text reads at a chat message's size wherever the card is drawn. The set of
 * decisions (the manager chat's "Waiting on you" bar, the Assistant window) draws a card outside
 * the card frame, and its text used to take the page's 16px root size: larger than the card's own
 * title and than the chat around it. The size is on the text box itself now, for every card kind.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { AssistantCard } = await import("../../../src/web/components/assistant/cards/assistant-card");
const { DecisionSetCard } = await import("../../../src/web/components/assistant/cards/decision-set/decision-set-card");
const { CHAT_MESSAGE_TEXT } = await import("../../../src/web/lib/chat-message-text");
type Card = import("../../../src/shared/assistant-cards").AssistantCard;

const BODY = "**Ticket Story**, Backlog.\n\n- PR100 = `isDefaultRate`\n- Scope UK/IE\n- Rate kept";

const base = (over: Partial<Card>): Card => ({
  id: "33333333-3333-3333-3333-333333333333", kind: "needs_decision", projectName: "nxsys", projectKey: "k", sessionId: "mgr-1",
  title: "GI Group OT", body: BODY, payload: {}, status: "open", answer: null, provenance: "Written by the nxsys manager AI",
  createdAt: Date.now(), updatedAt: Date.now(), ...over,
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const textBoxes = () => [...view!.container.querySelectorAll<HTMLElement>("[data-card-text]")];
const noop = () => {};

function expectChatSize(boxes: HTMLElement[]) {
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes) expect(box.classList.contains(CHAT_MESSAGE_TEXT)).toBe(true);
}

describe("a card's text at a chat message's size", () => {
  it("is the chat's own class", () => {
    // The chat's messages are drawn with this class; changing it moves both together.
    expect(CHAT_MESSAGE_TEXT).toBe("text-sm");
  });

  it("in a card of the set of decisions, drawn outside the card frame", async () => {
    const card = base({ payload: { options: [{ id: "a", label: "Go" }, { id: "b", label: "Wait" }] } });
    view = await mount(
      <DecisionSetCard
        card={card} answer={undefined} onAnswer={noop} focusedRow={0} setFocusedRow={noop}
        replyRef={{ current: null }} onReplyKeyDown={noop} onOpenChat={noop} onDismiss={noop} busy={false} onConfirm={noop}
      />,
    );
    expectChatSize(textBoxes());
  });

  it("in a decision card with choices, an urgent one and one with a draft", async () => {
    view = await mount(
      <>
        <AssistantCard card={base({ payload: { options: [{ id: "a", label: "Go" }] } })} />
        <AssistantCard card={base({ id: "44444444-4444-4444-4444-444444444444", kind: "urgent" })} />
        <AssistantCard card={base({ id: "55555555-5555-5555-5555-555555555555", payload: { draft: { to: "slack", text: "hello" } } })} />
      </>,
    );
    expectChatSize(textBoxes());
  });

  it("in done and failed cards, and in a follow-up answer", async () => {
    view = await mount(
      <>
        <AssistantCard card={base({ kind: "done" })} />
        <AssistantCard card={base({ id: "66666666-6666-6666-6666-666666666666", kind: "failed" })} />
        <AssistantCard card={base({
          id: "77777777-7777-7777-7777-777777777777", status: "answered",
          followUp: { text: "Done, **merged**.", truncated: false, at: Date.now() },
        })} />
      </>,
    );
    const boxes = textBoxes();
    expect(boxes.length).toBe(4);
    expectChatSize(boxes);
  });
});
