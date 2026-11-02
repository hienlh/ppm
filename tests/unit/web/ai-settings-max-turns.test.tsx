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
/** Every Max Turns the field sent the server. */
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

/** Mounts the section against a server whose Claude provider has this Max Turns; saves are recorded and kept. */
async function mountWith(maxTurns: number): Promise<HTMLInputElement> {
  let turns = maxTurns;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/settings/ai" && init?.method === "PUT") {
      turns = JSON.parse(String(init.body)).providers.claude.max_turns;
      saved.push(turns);
    }
    const data = String(input) === "/api/settings/ai"
      ? { default_provider: "claude", providers: { claude: { type: "agent-sdk", max_turns: turns } } }
      : [];
    return new Response(JSON.stringify({ ok: true, data }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  view = await mount(<AISettingsSection />);
  await settle();
  return field();
}

function field(): HTMLInputElement {
  const input = document.getElementById("ai-max-turns") as HTMLInputElement | null;
  if (!input) throw new Error("no Max Turns field");
  return input;
}

/** Types `text` over the field and leaves it, as a user does. */
async function typeAndLeave(text: string): Promise<void> {
  await act(async () => {
    const input = field();
    input.focus();
    input.value = text;
    input.blur();
  });
  await settle();
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

  it("saves a number typed in range as it is", async () => {
    await mountWith(100);
    await typeAndLeave("250");
    expect(saved).toEqual([250]);
    expect(field().value).toBe("250");
  });

  // min and max bound the spinner arrows only, never a typed value.
  it.each([["2000", 1000], ["-5", 0]])("brings a typed %s into range before saving it", async (typed, kept) => {
    await mountWith(100);
    await typeAndLeave(typed);
    expect(saved).toEqual([kept]);
    expect(field().value).toBe(String(kept));
  });

  it("saves nothing for a cleared field, and shows the saved value again", async () => {
    await mountWith(100);
    await typeAndLeave("");
    expect(saved).toEqual([]);
    expect(field().value).toBe("100");
  });
});
