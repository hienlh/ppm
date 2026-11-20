/**
 * The Assistant window's quick Full/Ask switch: shows the saved mode as a word, flips it with one
 * press (saving only that key), and a Settings change on the same page moves it too.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { click, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installGlobal("MutationObserver", window.MutationObserver);
installGlobal("DocumentFragment", window.DocumentFragment);
afterAll(uninstallDom);

const { act } = await import("react");
const { AssistantModeHeadButton } = await import("../../../src/web/components/assistant/assistant-mode-button");
const { announcePermissionMode } = await import("../../../src/web/hooks/use-assistant-permission-mode");

const realFetch = globalThis.fetch;
let stored: Record<string, unknown> = {};
let puts: Array<Record<string, unknown>> = [];

beforeEach(() => {
  stored = { mcp_servers: [], permission_mode: "ask" };
  puts = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== "/api/assistant/settings") return new Response("{}", { status: 599 });
    if ((init?.method ?? "GET").toUpperCase() === "PUT") {
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      puts.push(body);
      stored = { ...stored, ...body };
    }
    const data = { settings: stored, providers: [], limits: { instructionsMaxChars: 8000, maxServers: 20 } };
    return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; globalThis.fetch = realFetch; });

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const btn = () => document.body.querySelector<HTMLButtonElement>("[data-assistant-mode]")!;

describe("AssistantModeHeadButton", () => {
  it("shows Ask, asks before Full, and saves only the mode once confirmed", async () => {
    view = await mount(<AssistantModeHeadButton />);
    await settle();
    expect(btn().textContent).toBe("Ask");
    expect(btn().getAttribute("aria-pressed")).toBe("false");
    await click(btn());
    await settle();
    expect(puts).toEqual([]);
    expect(document.body.textContent).toContain("Switch the Assistant to Full mode?");
    await click([...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Use Full")!);
    await settle();
    expect(puts.at(-1)!.permission_mode).toBe("full");
    expect(btn().getAttribute("data-assistant-mode")).toBe("full");
    expect(btn().textContent).toBe("Full");
  });

  it("goes back to Ask with one press", async () => {
    stored = { ...stored, permission_mode: "full" };
    view = await mount(<AssistantModeHeadButton />);
    await settle();
    await click(btn());
    await settle();
    expect(puts.at(-1)!.permission_mode).toBe("ask");
    expect(btn().textContent).toBe("Ask");
  });

  it("follows a change from another device", async () => {
    view = await mount(<AssistantModeHeadButton />);
    await settle();
    await act(async () => { window.dispatchEvent(new CustomEvent("assistant:permission-mode", { detail: { type: "assistant:permission-mode", mode: "full" } })); });
    expect(btn().textContent).toBe("Full");
  });

  it("follows a change made elsewhere on the page", async () => {
    view = await mount(<AssistantModeHeadButton />);
    await settle();
    await act(async () => { announcePermissionMode("full"); });
    expect(btn().textContent).toBe("Full");
  });

  it("is a text chip on the chip-row standard, not a 44px target", async () => {
    view = await mount(<AssistantModeHeadButton />);
    await settle();
    expect(btn().className).toContain("h-7");
    expect(btn().className).toContain("max-md:h-[26px]");
  });
});
