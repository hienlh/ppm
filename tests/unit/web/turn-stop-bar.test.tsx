/**
 * The bar above the composer that says why the last turn stopped. Classes rather than pixels
 * for the touch target: happy-dom does no layout and the Tailwind stylesheet is not loaded.
 */
import { describe, it, expect, afterEach, afterAll } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";
import { sessionMissingMessage } from "../../../src/shared/turn-stop.ts";

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

  it("is a note, not a box, offering a fresh start or a new chat, never Continue, when Claude Code lost the conversation", async () => {
    let newChats = 0;
    const stop = { message: sessionMissingMessage("no-history"), subtype: "error_session_missing", at: 7 };
    view = await mount(<TurnStopBar stop={stop} onContinue={() => {}} onNewChat={() => { newChats++; }} onOpenRecoverySettings={() => {}} />);
    const bar = view.container.querySelector("[data-testid=turn-stop-bar]");
    expect(bar?.getAttribute("data-stop-kind")).toBe("session-missing");
    expect(bar?.textContent).toContain("Claude Code no longer has this chat's history.");
    expect(bar?.textContent).toContain("Your next message starts a new session.");
    // No border, no fill: the note reads as part of the conversation (designs/resume-recovery-notices, A).
    expect(bar?.getAttribute("class")).not.toMatch(/\bborder\b|bg-/);
    const labels = [...view.container.querySelectorAll("button")].map((b) => b.textContent?.trim());
    // Recovery was on and nothing was kept: no offer to switch it on.
    expect(labels).toEqual(["Start fresh here", "New chat"]);
    for (const button of view.container.querySelectorAll("button")) expect(button.getAttribute("class")).toContain("max-md:min-h-11");
    await click([...view.container.querySelectorAll("button")].find((b) => b.textContent?.includes("New chat")) ?? null);
    expect(newChats).toBe(1);
    await click([...view.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Start fresh")) ?? null);
    expect(view.container.querySelector("[data-testid=turn-stop-bar]")).toBeNull();
  });

  it("offers to switch recovery on, on a desktop only, when it was off", async () => {
    let opened = 0;
    const stop = { message: sessionMissingMessage("off"), subtype: "error_session_missing", at: 9 };
    view = await mount(<TurnStopBar stop={stop} onContinue={() => {}} onNewChat={() => {}} onOpenRecoverySettings={() => { opened++; }} />);
    const link = [...view.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Recover chats like this automatically"));
    expect(link?.getAttribute("class")).toContain("max-md:hidden");
    await click(link ?? null);
    expect(opened).toBe(1);
  });

  it("links to Accounts beside Continue when the Claude CLI is signed out", async () => {
    let opened = 0;
    const stop = { message: "Claude Code on this computer is signed out.\nAdd an account in Settings → Accounts, or run `claude auth login`.", subtype: "error_during_execution", at: 3 };
    view = await mount(<TurnStopBar stop={stop} onContinue={() => {}} onOpenAccounts={() => { opened++; }} />);
    expect(view.container.querySelector("[data-testid=turn-stop-bar]")?.getAttribute("data-stop-kind")).toBe("signed-out");
    const labels = [...view.container.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(labels).toEqual(["Accounts", "Continue"]);
    await click([...view.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Accounts")) ?? null);
    expect(opened).toBe(1);
  });

  it("continues with the wording PPM's own retry uses", () => {
    expect(CONTINUE_AFTER_STOP).toBe("Continue from where you left off.");
  });
});
