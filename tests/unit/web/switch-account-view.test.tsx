/**
 * "Switch account", drilled into from the chat's ··· menu. Every account is a two-line card with
 * both bars; the current one leads and is ticked, then the usable ones by headroom. Below five
 * accounts an unusable one stays inline with its reason; from five on the view searches and folds
 * the unusable ones under "Out of usage". A refused pick says why instead of doing nothing, and a
 * signed-out card offers signing in again.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";
import type { SwitchAccount } from "../../../src/web/lib/chat-account-switch";

installDom();
afterAll(uninstallDom);
const { act } = await import("react");
const { SwitchAccountView, MANY_ACCOUNTS } = await import("../../../src/web/components/chat/switch-account-view");

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

const inMins = (mins: number) => new Date(Date.now() + mins * 60_000 - 30_000).toISOString();
const acc = (id: string, label: string, h5: number, wk: number, refusal: string | null = null, signedOut = false): SwitchAccount =>
  ({ id, label, plan: "Max", fiveHourPct: h5, weekPct: wk, fiveHourResetsAt: inMins(192), weekResetsAt: inMins(2 * 1440 + 8 * 60), refusal, signedOut });

const THREE = [acc("v2", "Victor 2 (Nxsys)", 47, 52), acc("v", "Victor", 12, 30), acc("s", "Nxsys shared", 100, 88, "5-hour limit reached")];
const NINE = [
  ...THREE,
  acc("a", "Nxsys team A", 5, 18), acc("b", "Nxsys team B", 33, 41), acc("h", "Hien personal", 64, 71), acc("q", "QA bot", 81, 60),
  acc("d", "Demo account", 96, 100, "Weekly limit reached"), acc("o", "Old work", 20, 30, "Signed out · sign in again", true),
];

async function render(accounts: SwitchAccount[], extra: Partial<Parameters<typeof SwitchAccountView>[0]> = {}) {
  const calls = { picked: [] as string[], done: 0, reauth: [] as string[] };
  view = await mount(
    <SwitchAccountView
      accounts={accounts}
      loading={false}
      currentId="v2"
      providerName="Claude"
      onBack={() => {}}
      onPick={async (id) => { calls.picked.push(id); return null; }}
      onPicked={() => { calls.done++; }}
      onReauth={(a) => calls.reauth.push(a.id)}
      onAddAccount={() => {}}
      onManage={() => {}}
      {...extra}
    />,
  );
  return calls;
}
const rows = () => [...view!.container.querySelectorAll("[data-account-row]")].map((r) => r.getAttribute("data-account-row"));
const row = (id: string) => view!.container.querySelector<HTMLButtonElement>(`[data-account-row="${id}"]`)!;
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
/** React reads a controlled input's value through the native setter, then an `input` event. */
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("SwitchAccountView", () => {
  it("with three accounts: no search, current first and ticked, the unusable one inline with its reason", async () => {
    await render(THREE);
    expect(MANY_ACCOUNTS).toBe(5);
    expect(view!.container.querySelector('input[type="search"]')).toBeNull();
    expect(rows()).toEqual(["v2", "v", "s"]);
    expect(row("v2").getAttribute("aria-current")).toBe("true");
    expect(row("s").getAttribute("aria-disabled")).toBe("true");
    expect(row("s").textContent).toContain("5-hour limit reached");
    // Two lines: both windows on every usable card.
    expect(row("v").textContent).toContain("5h");
    expect(row("v").textContent).toContain("Week");
    expect(view!.container.textContent).toContain("Add account");
    expect(view!.container.textContent).toContain("Manage in Settings");
  });

  it("with nine accounts: search, most headroom first, the unusable folded under Out of usage", async () => {
    await render(NINE);
    expect(view!.container.querySelector('input[type="search"]')).not.toBeNull();
    expect(view!.container.textContent).toContain("9 accounts · Claude");
    // Current, then by the busier window ascending: team A 18, Victor 30, team B 41, Hien 71, QA 81.
    expect(rows().slice(0, 6)).toEqual(["v2", "a", "v", "b", "h", "q"]);
    const fold = [...view!.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Out of usage"))!;
    expect(fold.textContent).toContain("3");
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    await click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
  });

  it("filters by name, opens the fold while searching, and says when nothing matches", async () => {
    await render(NINE);
    const input = view!.container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await type(input, "demo");
    expect(rows()).toEqual(["d"]);
    const fold = [...view!.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Out of usage"))!;
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    await type(input, "zzz");
    expect(rows()).toEqual([]);
    expect(view!.container.textContent).toContain("No account matches.");
  });

  it("routes the chat on a usable pick and returns to the menu", async () => {
    const calls = await render(THREE);
    await click(row("v"));
    await wait(320);
    expect(calls.picked).toEqual(["v"]);
    expect(calls.done).toBe(1);
  });

  it("refuses an unusable account with its reason, and offers sign-in for a signed-out one", async () => {
    const calls = await render(NINE);
    await click(row("s"));
    expect(calls.picked).toEqual([]);
    expect(view!.container.querySelector('[role="alert"]')?.textContent).toContain("5-hour limit reached");
    await click(row("o"));
    expect(calls.reauth).toEqual(["o"]);
    expect(calls.picked).toEqual([]);
  });

  it("says why when the chat cannot change account yet, rather than doing nothing", async () => {
    await render(THREE, { onPick: undefined });
    await click(row("v"));
    expect(view!.container.querySelector('[role="alert"]')?.textContent).toContain("once this chat has finished starting");
  });

  it("shows the server's refusal and stays on the list", async () => {
    const calls = { done: 0 };
    await render(THREE, { onPick: async () => "Account is busy", onPicked: () => { calls.done++; } });
    await click(row("v"));
    await wait(320);
    expect(view!.container.querySelector('[role="alert"]')?.textContent).toContain("Account is busy");
    expect(calls.done).toBe(0);
  });

  it("says under every bar when it resets, countdown and clock, in red when the bar is full", async () => {
    await render(THREE);
    const resets = (id: string) => [...row(id).querySelectorAll("[data-account-reset]")];
    const [h5, wk] = resets("v");
    expect(h5.textContent).toMatch(/^Resets in 3h 12m · \d\d:\d\d$/);
    expect(wk.textContent).toMatch(/^Resets in 2d 8h · [A-Z][a-z]{2} \d\d:\d\d$/);
    expect(h5.className).not.toContain("text-error");
    // The full 5h bar: its reset line is the answer, so it reads red; the refusal names only the window.
    expect(resets("s")[0].className).toContain("text-error");
    expect(row("s").textContent).not.toContain("resets in");
  });
});
