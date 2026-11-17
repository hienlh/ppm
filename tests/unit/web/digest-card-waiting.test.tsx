/**
 * The morning digest card in PPM lists a project's waiting tasks under its manager's items: code,
 * title, on whom and until when, the user's own marked, the rest counted. A digest from before this
 * list draws as it always did.
 */
import { afterAll, afterEach, expect, it } from "bun:test";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { DigestCard } = await import("../../../src/web/components/assistant/cards/digest-card");
type Card = import("../../../src/shared/assistant-cards").AssistantCard;

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

const card = (projects: NonNullable<Card["payload"]["projects"]>): Card => ({
  id: "d1", kind: "digest", projectName: null, projectKey: null, sessionId: null, title: "Morning digest", body: "", status: "open", answer: null,
  provenance: null, createdAt: Date.now(), updatedAt: Date.now(), payload: { date: "2026-11-17", projects },
});

it("lists the waiting tasks with on whom and until when, the user's own marked", async () => {
  view = await mount(<DigestCard card={card([{
    name: "nxsys", state: "no_answer", items: [], waitingMine: 1, waitingMore: 3,
    waiting: [
      { ref: "nxsys/7", title: "Sign the contract", label: "Waiting on you", mine: true, until: "Due today" },
      { ref: "nxsys/9", title: "Review", label: "Waiting on Việt", mine: false, until: "for 2 days" },
    ],
  }])} />);
  const fold = view.container.querySelector("[data-digest-fold] button");
  if (fold) (fold as HTMLButtonElement).click();
  await new Promise((r) => setTimeout(r, 0));
  const box = view.container.querySelector("[data-digest-waiting]")!;
  expect(box.textContent).toContain("5 tasks waiting, 1 on you");
  const mine = box.querySelector("[data-digest-waiting-task='nxsys/7']")!;
  expect(mine.hasAttribute("data-digest-waiting-mine")).toBe(true);
  expect(mine.textContent).toContain("Waiting on you");
  expect(mine.textContent).toContain("Due today");
  expect(mine.querySelector("svg")).not.toBeNull();
  expect(box.querySelector("[data-digest-waiting-task='nxsys/9']")!.textContent).toContain("Waiting on Việt· for 2 days");
  expect(box.textContent).toContain("and 3 more in Tasks");
  // PPM's list sits beside the manager's state, not instead of it.
  expect(view.container.textContent).toContain("No answer yet (busy)");
});

it("draws an older digest without a waiting list as before", async () => {
  view = await mount(<DigestCard card={card([{ name: "pex", state: "answered", items: ["Release out"] }])} />);
  expect(view.container.querySelector("[data-digest-waiting]")).toBeNull();
});
