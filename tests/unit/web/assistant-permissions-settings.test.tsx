/**
 * Settings → PPM Assistant → General → Permissions against a stub server: each switch saves the
 * moment it flips, naming only its own key; turning "act on its own" on asks first (a dialog on
 * a desktop, a bottom sheet on a phone) and saves nothing until Turn on, while turning it off
 * saves at once; and the General pane's Save never sends either key, so a draft it loaded
 * earlier cannot put an old value back.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { click, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installGlobal("MutationObserver", window.MutationObserver);
installGlobal("DocumentFragment", window.DocumentFragment);
afterAll(uninstallDom);

const { act } = await import("react");
const {
  AssistantPermissionsSettings, ACT_ON_OWN_CONFIRM, ACT_ON_OWN_LABEL, READONLY_COMMANDS_LABEL,
} = await import("../../../src/web/components/settings/assistant/assistant-permissions-settings");
const { saveGeneralAssistantSettings } = await import("../../../src/web/lib/assistant-settings-api");

type Req = { method: string; url: string; body: Record<string, unknown> | undefined };

const SETTINGS = {
  default_provider: null, providers: {}, instructions: "Be brief.", mcp_servers: [],
  manager_default_mode: "default", manager_template: "", quiet_hours: { enabled: false, start: "22:00", end: "07:00" },
  digest: { enabled: true, time: "08:00" }, timezone: "Europe/London", restart_news: true,
  auto_readonly_commands: true, act_on_own: false,
};

const realFetch = globalThis.fetch;
let requests: Req[] = [];
let stored: Record<string, unknown> = {};

beforeEach(() => {
  requests = [];
  stored = { ...SETTINGS };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req: Req = { method: (init?.method ?? "GET").toUpperCase(), url: String(input), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    requests.push(req);
    if (req.url !== "/api/assistant/settings") return new Response(JSON.stringify({ ok: false, error: "no stub" }), { status: 599 });
    // The server keeps the stored value of every key a save does not name.
    if (req.method === "PUT") stored = { ...stored, ...req.body };
    const data = { settings: stored, providers: [{ id: "claude", name: "Claude" }], limits: { instructionsMaxChars: 8000, maxServers: 20 } };
    return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
  setWidth(1024);
});

function setWidth(px: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: px });
}
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const puts = () => requests.filter((r) => r.method === "PUT").map((r) => r.body!);
const toggle = (label: string) => document.body.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const button = (label: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) ?? null;
const text = () => document.body.textContent ?? "";

async function render(): Promise<void> {
  view = await mount(<AssistantPermissionsSettings />);
  await settle();
}

describe("Permissions", () => {
  it("shows read-only commands on and acting on its own off by default, with their help text", async () => {
    await render();
    expect(toggle(READONLY_COMMANDS_LABEL).getAttribute("aria-checked")).toBe("true");
    expect(toggle(ACT_ON_OWN_LABEL).getAttribute("aria-checked")).toBe("false");
    expect(text()).toContain("Commands PPM can prove only read — git status, listing files in your projects, process and memory info — run without a card.");
    expect(text()).toContain("Never reaches your keys, credential folders or PPM's own data.");
  });

  it("treats a server that sends neither switch as read-only on, acting on its own off", async () => {
    delete stored.auto_readonly_commands;
    delete stored.act_on_own;
    await render();
    expect(toggle(READONLY_COMMANDS_LABEL).getAttribute("aria-checked")).toBe("true");
    expect(toggle(ACT_ON_OWN_LABEL).getAttribute("aria-checked")).toBe("false");
  });

  it("saves the read-only switch at once, naming no other pane's key", async () => {
    await render();
    await click(toggle(READONLY_COMMANDS_LABEL));
    await settle();
    const [body] = puts();
    expect(body!.auto_readonly_commands).toBe(false);
    expect(body!.instructions).toBe("Be brief.");
    for (const key of ["act_on_own", "digest", "quiet_hours", "timezone", "restart_news", "manager_default_mode", "manager_template"]) {
      expect(key in body!).toBe(false);
    }
    expect(toggle(READONLY_COMMANDS_LABEL).getAttribute("aria-checked")).toBe("false");
  });

  it("asks before letting the Assistant act on its own, and Cancel saves nothing", async () => {
    await render();
    await click(toggle(ACT_ON_OWN_LABEL));
    await settle();
    expect(text()).toContain(ACT_ON_OWN_CONFIRM);
    expect(puts()).toEqual([]);
    expect(toggle(ACT_ON_OWN_LABEL).getAttribute("aria-checked")).toBe("false");
    await click(button("Cancel"));
    await settle();
    expect(text()).not.toContain(ACT_ON_OWN_CONFIRM);
    expect(puts()).toEqual([]);
    expect(toggle(ACT_ON_OWN_LABEL).getAttribute("aria-checked")).toBe("false");
  });

  it("turns acting on its own on only after Turn on, then off again with no question", async () => {
    await render();
    await click(toggle(ACT_ON_OWN_LABEL));
    await settle();
    await click(button("Turn on"));
    await settle();
    expect(puts()).toHaveLength(1);
    expect(puts()[0]!.act_on_own).toBe(true);
    expect("auto_readonly_commands" in puts()[0]!).toBe(false);
    expect(toggle(ACT_ON_OWN_LABEL).getAttribute("aria-checked")).toBe("true");

    await click(toggle(ACT_ON_OWN_LABEL));
    await settle();
    expect(text()).not.toContain(ACT_ON_OWN_CONFIRM);
    expect(puts()).toHaveLength(2);
    expect(puts()[1]!.act_on_own).toBe(false);
    expect(toggle(ACT_ON_OWN_LABEL).getAttribute("aria-checked")).toBe("false");
  });

  it("asks in a bottom sheet on a phone", async () => {
    setWidth(390);
    await render();
    await click(toggle(ACT_ON_OWN_LABEL));
    await settle();
    const sheet = document.body.querySelector(`[role="dialog"][aria-label="${ACT_ON_OWN_LABEL}?"]`);
    expect(sheet?.textContent).toContain(ACT_ON_OWN_CONFIRM);
    // The chip-row standard: 28px on a desktop, 26px on a phone, and no 44px minimum.
    for (const name of ["Turn on", "Cancel"]) {
      const cls = button(name)?.className ?? "";
      expect(cls).toContain("h-7");
      expect(cls).toContain("max-md:h-[26px]");
      expect(cls).not.toContain("min-h-11");
    }
    await click(button("Turn on"));
    await settle();
    expect(puts()[0]!.act_on_own).toBe(true);
  });

  it("survives a General Save from a draft loaded before the switch changed", async () => {
    await render();
    await click(toggle(READONLY_COMMANDS_LABEL));
    await settle();
    // The General pane's draft still holds the old values of both switches.
    await saveGeneralAssistantSettings({ ...SETTINGS, instructions: "Be briefer." } as never);
    const general = puts().at(-1)!;
    expect("auto_readonly_commands" in general).toBe(false);
    expect("act_on_own" in general).toBe(false);
    expect(stored.auto_readonly_commands).toBe(false);
    expect(stored.instructions).toBe("Be briefer.");
  });
});
