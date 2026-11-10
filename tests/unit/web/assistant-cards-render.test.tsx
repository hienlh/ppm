/**
 * PPM Assistant's cards in the browser: every kind draws its own buttons only while it waits, Allow
 * is absent when the card does not show the whole request, a manager's words carry the
 * server-written provenance line and render as text, a draft shows hidden characters, and an
 * answered card keeps its content with a status line instead of buttons. Phone targets are 44 px.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { AssistantCard } = await import("../../../src/web/components/assistant/cards/assistant-card");
const { api } = await import("../../../src/web/lib/api-client");
type Card = import("../../../src/shared/assistant-cards").AssistantCard;

const base = (over: Partial<Card>): Card => ({
  id: "11111111-1111-1111-1111-111111111111", kind: "done", projectName: "api", projectKey: "k", sessionId: "mgr-1",
  title: "Title", body: "", payload: {}, status: "open", answer: null, provenance: null,
  createdAt: Date.now(), updatedAt: Date.now(), ...over,
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

const buttons = () => [...view!.container.querySelectorAll("button")].map((b) => b.textContent?.trim());

describe("assistant cards", () => {
  it("offers Allow on an approval only when the whole request is shown", async () => {
    const deciding = { kind: "command", title: "Bash", facts: [], text: "npm publish", complete: true };
    view = await mount(<AssistantCard card={base({ kind: "approval", payload: { requestId: "r", deciding } })} />);
    expect(buttons()).toEqual(["Allow", "Deny", "Open manager chat"]);
    expect(view.container.querySelector("[data-card-command]")?.textContent).toBe("npm publish");
    await click([...view.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Allow"))!);
    expect(posts).toEqual([{ url: "/api/assistant/cards/11111111-1111-1111-1111-111111111111/answer", body: { decision: "allow" } }]);
    await view.unmount();
    view = await mount(<AssistantCard card={base({ kind: "approval", payload: { requestId: "r", deciding: { ...deciding, complete: false, incompleteReason: "Cut short." } } })} />);
    expect(buttons()).toEqual(["Deny", "Open manager chat"]);
    expect(view.container.textContent).toContain("Cut short.");
  });

  it("shows a decision's provenance line and draft verbatim with hidden characters revealed", async () => {
    view = await mount(<AssistantCard card={base({
      kind: "needs_decision", title: "Reply to the client", provenance: "Written by the api manager AI",
      payload: { draft: { to: "client@example.com", text: "Hi <b>there</b>\u202E", sha256: "x" } },
    })} />);
    expect(view.container.querySelector("[data-card-provenance]")?.textContent).toBe("Written by the api manager AI");
    const draft = view.container.querySelector("[data-card-draft]")!;
    expect(draft.textContent).toContain("Hi <b>there</b>⟨U+202E⟩");
    expect(draft.querySelector("b")).toBeNull();
    expect(buttons()).toEqual(["Open manager chat", "Dismiss"]);
  });

  it("drops the buttons of a card that no longer waits and says how it ended", async () => {
    view = await mount(<AssistantCard card={base({
      kind: "approval", status: "resolved", payload: { requestId: "r" },
      answer: { by: "user", channel: "telegram", at: Date.now(), note: "Answered on Telegram" },
    })} />);
    expect(buttons()).toEqual([]);
    expect(view.container.querySelector("[data-card-status-line]")?.textContent).toMatch(/^Answered on Telegram · \d\d:\d\d$/);
  });

  it("answers a single-choice question with its options", async () => {
    view = await mount(<AssistantCard card={base({
      kind: "question", payload: { requestId: "q", questions: [{ id: "q1", question: "Ship now?", multiSelect: false, allowsFreeText: false, options: [{ label: "Yes" }, { label: "No" }] }] },
    })} />);
    expect(buttons()).toEqual(["Yes", "No", "Open manager chat"]);
    await click([...view.container.querySelectorAll("button")].find((b) => b.textContent === "No")!);
    expect(posts[0]!.body).toEqual({ answersById: { q1: ["No"] } });
  });

  it("draws every other kind with its own controls, 44 px tall on a phone", async () => {
    for (const card of [
      base({ kind: "done" }), base({ kind: "failed", payload: { detected: true } }), base({ kind: "urgent" }),
      base({ kind: "budget", projectName: null, body: "Paused." }),
      base({ kind: "rules_change", payload: { added: ["Never deploy on Friday."], rulesHash: "h" } }),
    ]) {
      view = await mount(<AssistantCard card={card} />);
      const all = [...view.container.querySelectorAll("button")];
      expect(all.length).toBeGreaterThan(0);
      for (const b of all) expect(b.className).toContain("h-11");
      await view.unmount();
      view = null;
    }
    view = await mount(<AssistantCard card={base({ kind: "digest", title: "Today", payload: { items: ["a", "b"] } })} />);
    expect(view.container.textContent).toContain("Morning digest");
    expect(view.container.textContent).toContain("2 items");
    await view.unmount();
    view = await mount(<AssistantCard card={base({ kind: "rules_note", status: "info", title: "The manager added 1 rule line", payload: { added: ["x"] } })} />);
    expect(view.container.textContent).toContain("Rules updated");
  });
});
