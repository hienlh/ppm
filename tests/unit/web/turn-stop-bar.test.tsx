/**
 * The bar above the composer that says why the last turn stopped. Classes rather than pixels
 * for the touch target: happy-dom does no layout and the Tailwind stylesheet is not loaded.
 */
import { describe, it, expect, afterEach, afterAll } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { TurnStopBar, CONTINUE_AFTER_STOP } = await import("../../../src/web/components/chat/turn-stop-bar.tsx");

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

const maxTurns = { message: "Agent reached maximum turn limit.\nReached maximum number of turns (500)", subtype: "error_max_turns", at: 1 };

describe("TurnStopBar", () => {
  it("says why the turn stopped and continues it on a 44px button below md", async () => {
    let continued = 0;
    view = await mount(<TurnStopBar stop={maxTurns} onContinue={() => { continued++; }} />);
    const bar = view.container.querySelector("[data-testid=turn-stop-bar]");
    expect(bar?.textContent).toContain("Stopped after 500 steps (Max Turns)");
    const button = [...view.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Continue"));
    expect(button?.getAttribute("class")).toContain("max-md:min-h-11");
    await click(button ?? null);
    expect(continued).toBe(1);
  });

  it("renders nothing without a stop", async () => {
    view = await mount(<TurnStopBar stop={null} onContinue={() => {}} />);
    expect(view.container.innerHTML).toBe("");
  });

  it("continues with the wording PPM's own retry uses", () => {
    expect(CONTINUE_AFTER_STOP).toBe("Continue from where you left off.");
  });
});
