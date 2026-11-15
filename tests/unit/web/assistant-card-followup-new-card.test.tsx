/**
 * Under a card the user replied to: when the manager answered with a new card, only that card is
 * named (with Show while it waits), never the turn's text, which repeated the card. A turn that
 * opened no card still shows its answer.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { AssistantCard } = await import("../../../src/web/components/assistant/cards/assistant-card");
const { NEW_CARD_FOLLOWUP_NOTE } = await import("../../../src/web/components/assistant/cards/card-followup-new-cards");
const { useOpenCardsStore } = await import("../../../src/web/stores/assistant-open-cards-store");
type Card = import("../../../src/shared/assistant-cards").AssistantCard;

const replied = (followUp: Card["followUp"]): Card => ({
  id: "33333333-3333-3333-3333-333333333333", kind: "needs_decision", projectName: "ppm", projectKey: "k", sessionId: "mgr-1",
  title: "Run the full suite on Opus?", body: "Needs your OK.", payload: {}, status: "answered",
  answer: { by: "user", channel: "telegram", at: Date.now() }, provenance: null, createdAt: Date.now(), updatedAt: Date.now(),
  ...(followUp ? { followUp } : {}),
});
const fresh: Card = {
  id: "44444444-4444-4444-4444-444444444444", kind: "needs_decision", projectName: "ppm", projectKey: "k", sessionId: "mgr-1",
  title: "Run it anyway? ~40% quota", body: "Quota is at 60%.", payload: {}, status: "open", answer: null, provenance: null,
  createdAt: Date.now(), updatedAt: Date.now(),
};

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  useOpenCardsStore.setState({ cards: null, focus: null });
});

describe("the follow-up under a replied card", () => {
  it("names only the new card, with Show while it waits, and none of the turn's text", async () => {
    useOpenCardsStore.setState({ cards: [fresh] });
    view = await mount(<AssistantCard card={replied({ text: "", truncated: false, at: Date.now(), newCards: [{ id: fresh.id, title: fresh.title }] })} />);
    const box = view.container.querySelector("[data-card-followup-new-cards]")!;
    expect(box.textContent).toContain(NEW_CARD_FOLLOWUP_NOTE);
    expect(box.querySelector(`[data-card-followup-new-card="${fresh.id}"]`)?.textContent).toContain(fresh.title);
    expect(view.container.textContent).not.toContain("The manager's answer to your reply");
    const show = box.querySelector("button")!;
    expect(show.textContent).toBe("Show");
    show.click();
    expect(useOpenCardsStore.getState().focus).toMatchObject({ projectName: "ppm", cardId: fresh.id });
  });

  it("offers no Show for a new card that no longer waits", async () => {
    useOpenCardsStore.setState({ cards: [] });
    view = await mount(<AssistantCard card={replied({ text: "", truncated: false, at: Date.now(), newCards: [{ id: fresh.id, title: fresh.title }] })} />);
    expect(view.container.querySelector("[data-card-followup-new-cards] button")).toBeNull();
  });

  it("still shows the answer of a turn that opened no card", async () => {
    view = await mount(<AssistantCard card={replied({ text: "No, it is cheap.", truncated: false, at: Date.now() })} />);
    expect(view.container.querySelector("[data-card-followup-new-cards]")).toBeNull();
    expect(view.container.querySelector("[data-card-followup]")?.textContent).toContain("No, it is cheap.");
  });
});
