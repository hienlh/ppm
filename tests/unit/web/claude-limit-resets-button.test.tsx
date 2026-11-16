/**
 * Claude's free limit resets on an account card: the count, the list as claude.ai shows it, the
 * reason on a reset that cannot be used, and a confirmation before one is spent.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { click, installDom, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";
import { parseClaudeLimitResets } from "../../../src/shared/claude-limit-resets.ts";

installDom();
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);

const { act } = await import("react");
const { ClaudeLimitResetsButton } = await import("../../../src/web/components/settings/accounts/claude-limit-resets-button");

let store: Record<string, string> = {};
let requests: Array<{ url: string; method: string; body: unknown }> = [];
let answer: unknown = { ok: true, data: { result: "reset", kind: "fable", resetsLeft: 1 } };
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
    requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(answer), { headers: { "Content-Type": "application/json" } });
  });
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const button = (text: string, root: ParentNode = document.body) => {
  const found = [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found as HTMLButtonElement;
};

function grant(id: string, over: Record<string, unknown> = {}) {
  return {
    id, label: id, resets_total: 1, resets_left: 1, ends_at: "2099-03-09T07:59:00Z",
    clears: ["five_hour", "seven_day_overage_included"], paused: false, usable_now: true, use_requires_limit: false,
    percent_used: { five_hour: 16 }, blocking: [], type: "full", gives_back_weekly: true, ...over,
  };
}
const resets = (grants: unknown[]) => parseClaudeLimitResets({ cedar_ember: { eligible: true, at_limit: false, exhausted: [], grants } })!;

describe("ClaudeLimitResetsButton", () => {
  it("keeps the section when the account holds no reset, so cards side by side line up", async () => {
    view = await mount(<ClaudeLimitResetsButton account={{ id: "a1", label: "Work" }} resets={undefined} onDone={() => {}} />);
    expect(document.body.querySelector('[data-testid="resets-section"]')!.textContent).toBe("Free resets · 0None right now");
    expect(document.body.querySelector('[data-testid="resets-use"]')).toBeNull();
  });

  it("shows only the count and the nearest expiry on the card, and each reset with its own expiry in the sheet", async () => {
    const messages: string[] = [];
    view = await mount(
      <ClaudeLimitResetsButton
        account={{ id: "a1", label: "Work" }}
        resets={resets([
          grant("f1", { ends_at: "2099-03-09T07:59:00Z" }),
          grant("f2", { resets_left: 2, ends_at: "2099-03-10T07:59:00Z" }),
          grant("full-1", { gives_back_weekly: false, clears: ["five_hour", "seven_day"], usable_now: false, use_requires_limit: true, ends_at: "2099-01-05T00:00:00Z" }),
        ])}
        onDone={(m) => messages.push(m)}
      />,
    );
    // The card: no reset button, each kind with its expiry, soonest first.
    const section = document.body.querySelector('[data-testid="resets-section"]')!;
    expect(section.textContent).toContain("Free resets · 4");
    const lines = [...section.querySelectorAll('[data-testid="reset-line"]')].map((l) => l.textContent);
    expect(lines[0]).toMatch(/^Full reset.*Jan 5, 2099 · \d+ days$/);
    expect(lines[2]).toMatch(/^Fable reset ×2.*Mar 10, 2099/);
    expect([...document.body.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Reset for free");

    await click(document.body.querySelector<HTMLButtonElement>('[data-testid="resets-use"]')!);
    const full = document.body.querySelector('[data-testid="claude-reset-full-1"]')!;
    expect(full.textContent).toContain("Expires Jan 5, 2099");
    expect(full.textContent).toContain("Can't use it now: usable once you reach a limit it refills.");
    expect(button("Reset for free", full).disabled).toBe(true);
    const f2 = document.body.querySelector('[data-testid="claude-reset-f2"]')!;
    expect(f2.textContent).toContain("Fable reset ×2");
    expect(f2.textContent).toContain("Expires Mar 10, 2099");
    expect(f2.textContent).toContain("gives back what Fable used of your weekly limit");

    await click(button("Reset for free", f2));
    const sheet = document.body.querySelector('[data-testid="claude-limit-reset-confirm"]')!;
    expect(sheet.textContent).toContain("You still have 84% of your 5-hour limit left. Use your Fable reset anyway?");
    expect(sheet.textContent).toContain("2 of this kind left, use by Mar 10, 2099");
    expect(requests).toEqual([]);
    await click(button("Yes, use my Fable reset"));
    await settle();
    expect(requests).toEqual([{ url: "/api/accounts/a1/limit-reset", method: "POST", body: { grantId: "f2" } }]);
    expect(messages).toEqual(["Work: Fable reset used. What Fable used is back in your weekly limit. 1 Fable reset left."]);
  });

  it("keeps the reset when the confirmation is declined, and shows the server's refusal", async () => {
    const messages: string[] = [];
    view = await mount(<ClaudeLimitResetsButton account={{ id: "a1", label: "Work" }} resets={resets([grant("f1")])} onDone={(m) => messages.push(m)} />);
    await click(document.body.querySelector<HTMLButtonElement>('[data-testid="resets-use"]')!);
    await click(button("Reset for free"));
    await click(button("Keep it"));
    expect(requests).toEqual([]);
    expect(document.body.querySelector('[data-testid="claude-limit-resets"]')).not.toBeNull();

    answer = { ok: false, error: "Work no longer has that reset. The list has been refreshed." };
    await click(button("Reset for free"));
    await click(button("Yes, use my Fable reset"));
    await settle();
    expect(messages).toEqual(["Work no longer has that reset. The list has been refreshed."]);
  });
});
