/**
 * An open MCP list or accounts pane reads its section again when the server announces that it
 * changed elsewhere (`ppm mcp`, `ppm accounts`, another device), and only for its own section.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { installDom, installGlobal, mount, uninstallDom } from "../../helpers/react-dom";

installDom();
const { act } = await import("react");
const { useMcpServers } = await import("../../../src/web/components/ai-resources/use-mcp-servers");
const { useCodexAccounts } = await import("../../../src/web/components/settings/accounts/use-codex-accounts");
const { SETTINGS_CHANGED_EVENT } = await import("../../../src/shared/settings-events");

afterAll(uninstallDom);

const envelope = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, data }), { headers: { "Content-Type": "application/json" } });

/** Counts the requests per path, answering each from `routes`. */
function serve(routes: Record<string, () => unknown>): Map<string, number> {
  const hits = new Map<string, number>();
  installGlobal("fetch", async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://localhost").pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const route = routes[path];
    return route ? envelope(route()) : new Response("not found", { status: 404 });
  });
  return hits;
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

/** Waits up to a second for `text`: a loaded machine can take longer than one settle. */
async function until(container: HTMLElement, text: string): Promise<void> {
  for (let i = 0; i < 50 && container.textContent !== text; i++) await settle();
  expect(container.textContent).toBe(text);
}
const announce = (section: string) => act(async () => {
  window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: { section } }));
  await new Promise((r) => setTimeout(r, 20));
});

function McpProbe() {
  const { servers } = useMcpServers();
  return <p>{servers.map((s) => s.name).join(",")}</p>;
}

// The Codex pane: the Claude one (`useAccountsData`) listens the same way, but another test file
// leaves never-answering `/api/accounts` requests in the API client's in-flight sharing.
function AccountsProbe() {
  const { accounts } = useCodexAccounts(() => {});
  return <p>{accounts.map((a) => a.label).join(",")}</p>;
}

describe("settings panes refresh on settings:changed", () => {
  it("re-reads the MCP list for its own section only", async () => {
    let names = ["files"];
    const hits = serve({ "/api/settings/mcp": () => names.map((name) => ({ name, transport: "stdio", config: { command: "x" } })) });
    const view = await mount(<McpProbe />);
    try {
      await settle();
      expect(view.container.textContent).toBe("files");
      names = ["files", "search"];
      await announce("accounts");
      expect(hits.get("/api/settings/mcp")).toBe(1);
      await announce("mcp");
      expect(view.container.textContent).toBe("files,search");
      expect(hits.get("/api/settings/mcp")).toBe(2);
    } finally {
      await view.unmount();
    }
  });

  it("re-reads the accounts when another device renames one", async () => {
    let label = "Work";
    serve({
      "/api/codex-accounts": () => ({ accounts: [{ id: "cx-1", label, type: "apiKey", status: "active" }], strategy: "round-robin" }),
      "/api/codex-accounts/usage": () => ({}),
    });
    const view = await mount(<AccountsProbe />);
    try {
      await until(view.container, "Work");
      label = "Personal";
      await announce("accounts");
      await until(view.container, "Personal");
    } finally {
      await view.unmount();
    }
  });
});
