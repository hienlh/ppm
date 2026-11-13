/**
 * Settings → AI Provider's Additional Instructions: agy reads a system prompt only when a chat
 * is created, so for Antigravity the field says the instructions reach new chats only.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

// Radix's Select builds its portal content in one.
installGlobal("DocumentFragment", window.DocumentFragment);
afterAll(uninstallDom);

const { act } = await import("react");
const { AISettingsSection } = await import("../../../src/web/components/settings/ai-settings-section");

const NOTE = "Antigravity reads these only when PPM starts a new chat";
const realFetch = globalThis.fetch;
let view: Mounted | null = null;

afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
});

/** Mounts the section with this provider as the default, which opens on its tab. */
async function mountOn(provider: string, config: Record<string, unknown>): Promise<HTMLTextAreaElement> {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const data = String(input) === "/api/settings/ai"
      ? { default_provider: provider, providers: { [provider]: config } }
      : [];
    return new Response(JSON.stringify({ ok: true, data }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  view = await mount(<AISettingsSection />);
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const field = document.getElementById("ai-system-prompt") as HTMLTextAreaElement | null;
  if (!field) throw new Error("no Additional Instructions field");
  return field;
}

describe("Additional Instructions", () => {
  it("tells an Antigravity user they reach new chats only", async () => {
    const field = await mountOn("antigravity", { type: "cli", cli_command: "agy" });
    const note = document.getElementById(field.getAttribute("aria-describedby") ?? "");
    expect(note?.textContent).toContain(NOTE);
  });

  it("says nothing of the kind for Claude, which reads them on every turn", async () => {
    const field = await mountOn("claude", { type: "agent-sdk" });
    expect(field.hasAttribute("aria-describedby")).toBe(false);
    expect(document.body.textContent).not.toContain(NOTE);
  });
});
