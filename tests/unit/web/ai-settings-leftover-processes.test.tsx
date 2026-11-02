/**
 * Settings → AI Provider's "Stop leftover processes after" field: the default it shows, the range
 * it offers, and what it saves.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

// Radix's Select builds its portal content in one.
installGlobal("DocumentFragment", window.DocumentFragment);
afterAll(uninstallDom);

const { act } = await import("react");
const { AISettingsSection } = await import("../../../src/web/components/settings/ai-settings-section");

const realFetch = globalThis.fetch;
let view: Mounted | null = null;
let saved: unknown[] = [];

afterEach(async () => {
  await view?.unmount();
  view = null;
  saved = [];
  globalThis.fetch = realFetch;
});

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

/** Mounts the section against a server holding this AI config; PUTs are recorded and echoed back. */
async function mountWith(ai: Record<string, unknown>): Promise<HTMLInputElement> {
  let current = { default_provider: "claude", providers: { claude: { type: "agent-sdk" } }, ...ai };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let data: unknown = [];
    if (String(input) === "/api/settings/ai") {
      if (init?.method === "PUT") {
        const patch = JSON.parse(String(init.body));
        saved.push(patch);
        current = { ...current, ...patch };
      }
      data = current;
    }
    return new Response(JSON.stringify({ ok: true, data }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  view = await mount(<AISettingsSection />);
  await settle();
  const field = document.getElementById("ai-leftover-idle") as HTMLInputElement | null;
  if (!field) throw new Error("no leftover processes field");
  return field;
}

/** Types `text` over the field and leaves it, as a user does. */
async function typeAndLeave(text: string): Promise<void> {
  await act(async () => {
    const field = document.getElementById("ai-leftover-idle") as HTMLInputElement;
    field.focus();
    field.value = text;
    field.blur();
  });
  await settle();
}

const shown = () => (document.getElementById("ai-leftover-idle") as HTMLInputElement).value;

describe("Stop leftover processes after", () => {
  it("shows the default, off, when nothing is set, and offers 0 to 1440", async () => {
    const field = await mountWith({});
    expect([field.min, field.max, field.value]).toEqual(["0", "1440", "0"]);
  });

  it("shows what is set", async () => {
    expect((await mountWith({ leftover_processes_idle_minutes: 45 })).value).toBe("45");
  });

  it("saves the minutes typed when the field loses focus", async () => {
    await mountWith({});
    await typeAndLeave("45");
    expect(saved).toEqual([{ leftover_processes_idle_minutes: 45 }]);
    expect(shown()).toBe("45");
  });

  // min and max bound the spinner arrows only, never a typed value.
  it.each([["2000", 1440], ["-5", 0]])("brings a typed %s into range before saving it", async (typed, kept) => {
    await mountWith({ leftover_processes_idle_minutes: 30 });
    await typeAndLeave(typed);
    expect(saved).toEqual([{ leftover_processes_idle_minutes: kept }]);
    expect(shown()).toBe(String(kept));
  });

  it("saves nothing for a cleared field, and shows the saved value again", async () => {
    await mountWith({ leftover_processes_idle_minutes: 30 });
    await typeAndLeave("");
    expect(saved).toEqual([]);
    expect(shown()).toBe("30");
  });
});
