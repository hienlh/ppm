/**
 * Settings → AI Provider's Max Turns field: the range it offers, and the cost warning shown once
 * the limit is off or high enough for a task to keep going unattended for hours.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

// Radix's Select builds its portal content in one.
installGlobal("DocumentFragment", window.DocumentFragment);
afterAll(uninstallDom);

const { act } = await import("react");
const { AISettingsSection } = await import("../../../src/web/components/settings/ai-settings-section");

const WARNING = "Every step is a paid model call";
const realFetch = globalThis.fetch;
let view: Mounted | null = null;

afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
});

/** Mounts the section against a server whose Claude provider has this Max Turns. */
async function mountWith(maxTurns: number): Promise<HTMLInputElement> {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const data = String(input) === "/api/settings/ai"
      ? { default_provider: "claude", providers: { claude: { type: "agent-sdk", max_turns: maxTurns } } }
      : [];
    return new Response(JSON.stringify({ ok: true, data }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  view = await mount(<AISettingsSection />);
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const input = document.getElementById("ai-max-turns") as HTMLInputElement | null;
  if (!input) throw new Error("no Max Turns field");
  return input;
}

describe("Max Turns", () => {
  it("offers 0 to 1000", async () => {
    const input = await mountWith(100);
    expect([input.min, input.max, input.value]).toEqual(["0", "1000", "100"]);
  });

  it.each([1, 100, 500])("does not warn at %d", async (n) => {
    await mountWith(n);
    expect(document.body.textContent).not.toContain(WARNING);
  });

  it.each([0, 501, 1000])("warns about cost at %d", async (n) => {
    await mountWith(n);
    expect(document.body.textContent).toContain(WARNING);
  });
});
