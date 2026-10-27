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

describe("Stop leftover processes after", () => {
  it("shows the 30-minute default when nothing is set, and offers 0 to 1440", async () => {
    const field = await mountWith({});
    expect([field.min, field.max, field.value]).toEqual(["0", "1440", "30"]);
  });

  it("shows 0 as 0, not as the default", async () => {
    expect((await mountWith({ leftover_processes_idle_minutes: 0 })).value).toBe("0");
  });

  it("saves the minutes typed when the field loses focus", async () => {
    const field = await mountWith({});
    await act(async () => {
      field.focus();
      field.value = "45";
      field.blur();
    });
    await settle();
    expect(saved).toEqual([{ leftover_processes_idle_minutes: 45 }]);
    expect((document.getElementById("ai-leftover-idle") as HTMLInputElement).value).toBe("45");
  });
});
