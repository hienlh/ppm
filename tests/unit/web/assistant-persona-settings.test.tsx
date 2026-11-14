/**
 * Settings → PPM Assistant → General: the name, the list of ways to address the user and the
 * personality are edited in the General pane's draft and go out with its one Save — and the name
 * the rest of the app shows follows the answer at once. Instructions are left exactly as they were.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { click, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installGlobal("MutationObserver", window.MutationObserver);
installGlobal("DocumentFragment", window.DocumentFragment);
afterAll(uninstallDom);

const { act } = await import("react");
const { AssistantGeneralSettings } = await import("../../../src/web/components/settings/assistant-general-settings");
const { useAssistantNameStore, rememberAssistantName } = await import("../../../src/web/stores/assistant-name-store");

type Req = { method: string; url: string; body: unknown };
const realFetch = globalThis.fetch;
let requests: Req[] = [];

const SETTINGS = {
  default_provider: null, providers: {}, instructions: "## Tính cách\nTên em là Mi.", mcp_servers: [],
  persona: { name: "", address_forms: [], soul: "" },
  manager_default_mode: "default", manager_template: "", quiet_hours: { enabled: false, start: "22:00", end: "07:00" },
  digest: { enabled: true, time: "08:00" },
};
const RESPONSE = { settings: SETTINGS, providers: [{ id: "claude", name: "Claude" }], limits: { instructionsMaxChars: 8000, maxServers: 20 } };

beforeEach(() => {
  requests = [];
  rememberAssistantName("");
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = { method: (init?.method ?? "GET").toUpperCase(), url: String(input), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    requests.push(req);
    const data = req.method === "PUT" ? { ...RESPONSE, settings: { ...SETTINGS, ...(req.body as object) } } : RESPONSE;
    if (req.url === "/api/assistant/settings") return new Response(JSON.stringify({ ok: true, data }), { headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ ok: true, data: {} }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
  rememberAssistantName("");
});

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function typeInto(el: Element | null, value: string): Promise<void> {
  if (!el) throw new Error("no such field");
  const field = el as HTMLInputElement | HTMLTextAreaElement;
  await act(async () => {
    const proto = field instanceof window.HTMLInputElement ? window.HTMLInputElement.prototype : Object.getPrototypeOf(field);
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const button = (label: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label) ?? null;

describe("the Assistant's name and personality", () => {
  it("saves a name, several ways to address you and a personality, leaving the instructions alone", async () => {
    view = await mount(<AssistantGeneralSettings />);
    await settle();
    expect(document.body.textContent).toContain("Name and personality");

    await typeInto(document.getElementById("asst-persona-name"), "Mi");
    await click(button("Add a way to address you"));
    await typeInto(document.getElementById("asst-form-user-0"), "anh");
    await typeInto(document.getElementById("asst-form-self-0"), "em");
    await typeInto(document.getElementById("asst-form-when-0"), "bình thường");
    await click(button("Add a way to address you"));
    await typeInto(document.getElementById("asst-form-user-1"), "sếp");
    await typeInto(document.getElementById("asst-form-self-1"), "em");
    await typeInto(document.getElementById("asst-form-when-1"), "báo gấp, xin duyệt");
    await typeInto(document.getElementById("asst-persona-soul"), "Vui vẻ, gần gũi.");
    expect(document.querySelectorAll("[data-address-form]")).toHaveLength(2);

    await click(button("Save"));
    await settle();
    const put = requests.find((r) => r.method === "PUT")!.body as typeof SETTINGS;
    expect(put.persona).toEqual({
      name: "Mi",
      address_forms: [{ user: "anh", self: "em", when: "bình thường" }, { user: "sếp", self: "em", when: "báo gấp, xin duyệt" }],
      soul: "Vui vẻ, gần gũi.",
    });
    expect(put.instructions).toBe(SETTINGS.instructions);
    // Everything that shows the Assistant's name follows the answer.
    expect(useAssistantNameStore.getState().name).toBe("Mi");
  });

  it("removes a way to address you, and will not save a personality over its limit", async () => {
    view = await mount(<AssistantGeneralSettings />);
    await settle();
    await click(button("Add a way to address you"));
    await click(button("Remove form of address 1"));
    expect(document.querySelectorAll("[data-address-form]")).toHaveLength(0);

    await typeInto(document.getElementById("asst-persona-soul"), "x".repeat(2001));
    expect(document.body.textContent).toContain("2,001 / 2,000 characters");
    expect(button("Save")!.disabled).toBe(true);
  });
});
