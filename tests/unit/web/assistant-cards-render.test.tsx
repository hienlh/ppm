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
    // The server did not offer an OK on this card: only the user's own words, through Edit.
    expect(buttons()).toEqual(["Edit", "Open manager chat", "Dismiss"]);
  });

  it("sends OK with the exact draft's hash only when the server offers it", async () => {
    const sha = "d".repeat(64);
    view = await mount(<AssistantCard card={base({
      kind: "needs_decision", title: "Slack draft", okOffered: true, payload: { draft: { to: "#devs", text: "Shipping today.", sha256: sha } },
    })} />);
    expect(buttons()).toEqual(["OK, send", "Edit", "Open manager chat", "Dismiss"]);
    await click([...view.container.querySelectorAll("button")].find((b) => b.textContent?.includes("OK, send"))!);
    expect(posts[0]!.url).toBe("/api/assistant/cards/11111111-1111-1111-1111-111111111111/ok");
    expect(posts[0]!.body).toMatchObject({ draftSha256: sha });
  });

  it("Edit opens the reply bar, which sends the user's words to the card and closes", async () => {
    const { CardReplyBar } = await import("../../../src/web/components/assistant/cards/card-reply-bar");
    const { useCardReplyStore } = await import("../../../src/web/stores/assistant-card-reply-store");
    view = await mount(<><AssistantCard card={base({ kind: "needs_decision", title: "Release 2.14", projectName: "nxsys" })} /><CardReplyBar /></>);
    expect(view.container.querySelector("[data-card-reply-bar]")).toBeNull();
    await click([...view.container.querySelectorAll("button")].find((b) => b.textContent === "Edit")!);
    const bar = view.container.querySelector("[data-card-reply-bar]")!;
    expect(bar.textContent).toContain("Replying to: nxsys · Release 2.14");
    const area = bar.querySelector("textarea")!;
    expect(area.getAttribute("placeholder")).toBe("Your words go to the manager chat word for word…");
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(area), "value")!.set!;
    const { act } = await import("react");
    await act(async () => {
      setter.call(area, "Make it tomorrow morning 👍");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(bar.querySelector("button[aria-label='Send to the manager chat']")!);
    expect(posts.at(-1)).toMatchObject({ url: "/api/assistant/cards/11111111-1111-1111-1111-111111111111/reply", body: { text: "Make it tomorrow morning 👍" } });
    expect(useCardReplyStore.getState().target).toBeNull();
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
    view = await mount(<AssistantCard card={base({
      kind: "digest", projectName: null, projectKey: null, sessionId: null, title: "Morning digest · 3 projects, 2 items",
      provenance: "Put together by PPM; each item was written by that project's manager AI",
      payload: { date: "2026-11-10", projects: [
        { name: "nxsys", state: "answered", items: ["OK the <b>Slack</b> draft", "Release 2.14"] },
        { name: "ppm", state: "answered", items: [] },
        { name: "pex", state: "no_answer", items: [] },
      ] },
    })} />);
    // Folded to one line until opened.
    expect(view.container.querySelector("[data-digest-fold]")?.getAttribute("data-digest-fold")).toBe("closed");
    expect(view.container.textContent).toContain("Morning digest · 3 projects, 2 items");
    expect(view.container.querySelectorAll("[data-digest-project]")).toHaveLength(0);
    await click(view.container.querySelector("[data-digest-fold] button")!);
    const text = view.container.textContent ?? "";
    expect(text).toContain("Morning digest");
    expect(text).toContain("3 projects, 2 items");
    expect(text).toContain("Put together by PPM");
    const sections = [...view.container.querySelectorAll("[data-digest-project]")].map((s) => s.getAttribute("data-digest-project"));
    expect(sections).toEqual(["nxsys", "ppm", "pex"]);
    expect(view.container.querySelectorAll("[data-digest-project='nxsys'] li")).toHaveLength(2);
    expect(view.container.querySelector("[data-digest-project='nxsys'] b")).toBeNull();
    expect(view.container.querySelector("[data-digest-project='ppm']")?.textContent).toContain("Nothing new");
    expect(view.container.querySelector("[data-digest-project='pex']")?.textContent).toContain("No answer yet (busy)");
    // Only the fold's own toggle: a digest asks nothing of the user.
    expect(buttons()).toHaveLength(1);
    await view.unmount();
    view = await mount(<AssistantCard card={base({ kind: "rules_note", status: "info", title: "The manager added 1 rule line", payload: { added: ["x"] } })} />);
    expect(view.container.textContent).toContain("Rules updated");
  });
});
