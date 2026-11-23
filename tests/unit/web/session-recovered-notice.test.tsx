/**
 * The one line a chat shows when PPM carried it into a new Claude session: a note in the
 * conversation, ahead of what the new session says, with the turns it carried behind
 * "What was sent" as a You / Claude list (designs/resume-recovery-notices, direction A).
 */
import { describe, it, expect, afterEach, afterAll } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { recoveredTurnsLabel } = await import("../../../src/web/components/chat/session-recovered-notice.tsx");
const { InterleavedEvents } = await import("../../../src/web/components/chat/message-events.tsx");

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

const entries = Array.from({ length: 5 }, (_, i) => ({
  n: i + 1, user: `question ${i + 1}`, answer: `answer ${i + 1}`, ...(i === 4 ? { tools: "Edit ×3, Bash" } : {}),
}));

describe("SessionRecoveredNotice", () => {
  it("says how much history went along", () => {
    expect(recoveredTurnsLabel(14, 0)).toBe("all 14 earlier turns");
    expect(recoveredTurnsLabel(14, 6)).toBe("the last 14 turns");
    expect(recoveredTurnsLabel(1, 0)).toBe("the one earlier turn");
  });

  it("is one quiet line before the new session's answer, with no box around it", async () => {
    view = await mount(
      <InterleavedEvents
        isStreaming={false}
        events={[
          { type: "session_recovered", turns: 5, omittedTurns: 0, entries },
          { type: "text", content: "Picking up where we were." },
        ]}
      />,
    );
    const notice = view.container.querySelector("[data-testid=session-recovered-notice]");
    expect(notice?.textContent).toContain("New Claude session — PPM sent all 5 earlier turns it kept.");
    expect(notice?.getAttribute("class")).not.toMatch(/\bborder\b|bg-/);
    expect(view.container.firstElementChild?.getAttribute("data-testid")).toBe("session-recovered-notice");
    expect(view.container.children.length).toBe(2);
    expect(notice?.querySelector("[data-testid=session-recovered-sent]")).toBeNull();
  });

  it("opens What was sent as the newest turns, and the rest on request", async () => {
    view = await mount(<InterleavedEvents isStreaming={false} events={[{ type: "session_recovered", turns: 5, omittedTurns: 2, entries }]} />);
    const toggle = [...view.container.querySelectorAll("button")].find((b) => b.textContent?.includes("What was sent"));
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    await click(toggle ?? null);
    const sent = view.container.querySelector("[data-testid=session-recovered-sent]");
    const rows = () => [...(sent?.querySelectorAll("li") ?? [])].map((li) => li.textContent);
    expect(rows()).toHaveLength(3);
    expect(rows()[0]).toContain("You");
    expect(rows()[0]).toContain("question 3");
    expect(rows()[2]).toContain("Claude");
    expect(rows()[2]).toContain("Edit ×3, Bash");
    const more = [...view.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Show 2 earlier turns"));
    await click(more ?? null);
    expect(rows()).toHaveLength(5);
    expect(rows()[0]).toContain("question 1");
  });
});
