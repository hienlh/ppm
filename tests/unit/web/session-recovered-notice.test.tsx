/**
 * The one line a chat shows when PPM carried it into a new Claude session: drawn inside the
 * answer, before what the new session says, with what was sent behind a disclosure.
 */
import { describe, it, expect, afterEach, afterAll } from "bun:test";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { recoveredTurnsLabel } = await import("../../../src/web/components/chat/session-recovered-notice.tsx");
const { InterleavedEvents } = await import("../../../src/web/components/chat/message-events.tsx");

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

describe("SessionRecoveredNotice", () => {
  it("says how much history went along", () => {
    expect(recoveredTurnsLabel(14, 0)).toBe("all 14 earlier turns");
    expect(recoveredTurnsLabel(14, 6)).toBe("the last 14 turns");
    expect(recoveredTurnsLabel(1, 0)).toBe("the one earlier turn");
  });

  it("draws one line before the new session's answer, with what was sent behind a disclosure", async () => {
    view = await mount(
      <InterleavedEvents
        isStreaming={false}
        events={[
          { type: "session_recovered", turns: 2, omittedTurns: 0, sent: "PPM restored this chat. <earlier-turn n=\"1\">" },
          { type: "text", content: "Picking up where we were." },
        ]}
      />,
    );
    const notice = view.container.querySelector("[data-testid=session-recovered-notice]");
    expect(notice?.textContent).toContain("Started a new Claude session for this chat");
    expect(notice?.textContent).toContain("all 2 earlier turns");
    expect(notice?.querySelector("details summary")?.textContent).toBe("What was sent");
    expect(notice?.querySelector("pre")?.textContent).toContain("PPM restored this chat.");
    expect(view.container.querySelectorAll("[role=status]")).toHaveLength(1);
    // First in the answer, ahead of the text group the new session's reply renders into.
    expect(view.container.firstElementChild?.getAttribute("data-testid")).toBe("session-recovered-notice");
    expect(view.container.children.length).toBe(2);
  });
});
