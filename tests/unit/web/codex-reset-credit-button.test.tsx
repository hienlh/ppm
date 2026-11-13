/**
 * Codex's free resets on an account card: each credit with its expiry on the card and in the sheet, and "Use reset" only once a limit is reached.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { click, installDom, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";
import type { ResetCredits } from "../../../src/types/chat.ts";

installDom();
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);

const { act } = await import("react");
const { CodexResetCreditButton } = await import("../../../src/web/components/settings/accounts/codex-reset-credit-button");

let store: Record<string, string> = {};
let requests: Array<{ url: string; body: unknown }> = [];
beforeEach(() => {
  store = {};
  requests = [];
  installGlobal("localStorage", {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { store = {}; },
  });
  installGlobal("fetch", async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ ok: true, data: { outcome: "reset" } }), { headers: { "Content-Type": "application/json" } });
  });
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const buttons = (text: string) => [...document.body.querySelectorAll("button")].filter((b) => b.textContent?.trim() === text) as HTMLButtonElement[];

const credits: ResetCredits = {
  available: 3, nextExpiresAt: "2099-01-05T00:00:00.000Z", nextCreditId: "c1", title: "Full reset",
  credits: [
    { id: "c1", title: "Full reset", expiresAt: "2099-01-05T00:00:00.000Z" },
    { id: "c2", title: "Full reset", expiresAt: "2099-02-07T00:00:00.000Z" },
    { id: "c3", title: "Full reset (Weekly + 5 hr)", expiresAt: "2099-03-09T00:00:00.000Z" },
  ],
};
const bucket = (utilization: number) => ({ utilization, resetsAt: "2099-01-01T00:00:00Z", resetsInMinutes: null, resetsInHours: null, windowHours: 168 });

describe("CodexResetCreditButton", () => {
  it("lists each credit with its own expiry, and offers none below a limit", async () => {
    view = await mount(<CodexResetCreditButton account={{ id: "x", label: "Codex" }} usage={{ weekly: bucket(0.4), resetCredits: credits }} onDone={() => {}} />);
    const section = document.body.querySelector('[data-testid="resets-section"]')!;
    expect(section.textContent).toContain("Free resets · 3");
    expect([...section.querySelectorAll('[data-testid="reset-line"]')].map((l) => l.textContent?.replace(/ · \d+ days$/, ""))).toEqual([
      "Full resetJan 5, 2099", "Full resetFeb 7, 2099", "Full reset (Weekly + 5 hr)Mar 9, 2099",
    ]);

    await click(document.body.querySelector<HTMLButtonElement>('[data-testid="resets-use"]')!);
    const text = document.body.querySelector('[data-testid="codex-reset-credits"]')!.textContent!;
    for (const when of ["Expires Jan 5, 2099", "Expires Feb 7, 2099", "Expires Mar 9, 2099"]) expect(text).toContain(when);
    expect(text.match(/Usable once a limit is reached/g)).toHaveLength(1);
    expect(buttons("Use reset").every((b) => b.disabled)).toBe(true);
  });

  it("keeps the section with none left", async () => {
    view = await mount(<CodexResetCreditButton account={{ id: "x", label: "Codex" }} usage={{ resetCredits: { available: 0 } as ResetCredits }} onDone={() => {}} />);
    expect(document.body.querySelector('[data-testid="resets-section"]')!.textContent).toBe("Free resets · 0None right now");
  });

  it("spends the credit picked, after a confirmation, once a limit is reached", async () => {
    const messages: string[] = [];
    view = await mount(<CodexResetCreditButton account={{ id: "x", label: "Codex" }} usage={{ weekly: bucket(1), resetCredits: credits }} onDone={(m) => messages.push(m)} />);
    await click(document.body.querySelector<HTMLButtonElement>('[data-testid="resets-use"]')!);
    await click(buttons("Use reset")[2]!);
    expect(document.body.querySelector('[data-testid="codex-reset-credit-confirm"]')!.textContent).toContain("This reset expires Mar 9, 2099");
    expect(requests).toEqual([]);
    await click(buttons("Use reset")[0]!);
    await settle();
    expect(requests).toEqual([{ url: "/api/codex-accounts/x/reset-credit", body: { creditId: "c3" } }]);
    expect(messages[0]).toContain("limits reset to 0%");
  });
});
