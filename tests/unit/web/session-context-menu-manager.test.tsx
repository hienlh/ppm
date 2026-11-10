/**
 * The session row's menu and the manager role: "Set as manager chat" is offered only for a Claude
 * chat of a real project that is neither a design nor an Assistant session, "Unset manager chat"
 * only on the manager itself; the assign dialog states the consequence (and bypass mode) and which
 * chat it replaces before it assigns. On a phone the same menu opens with a long press.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, installGlobal, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);
installGlobal("MutationObserver", (window as unknown as { MutationObserver: unknown }).MutationObserver);

const { act } = await import("react");
const { SessionContextMenu } = await import("../../../src/web/components/chat/session-context-menu");
const { MANAGERS_CHANGED_EVENT, MANAGER_ASSIGN_BYPASS, MANAGER_ASSIGN_CONSEQUENCE } = await import("../../../src/shared/assistant-managers");
const { ASSISTANT_PROJECT_NAME } = await import("../../../src/shared/assistant-project");
const { api } = await import("../../../src/web/lib/api-client");

type Row = { id: string; providerId: string; title: string; createdAt: string; designSlug?: string | null };
const claude: Row = { id: "c1", providerId: "claude", title: "Release work", createdAt: "2026-11-10T01:00:00Z" };

let managers: unknown[] = [];
let puts: Array<{ url: string; body: unknown }> = [];
let deletes: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];
let view: Mounted | null = null;
const realWidth = window.innerWidth;

beforeEach(() => {
  managers = [];
  puts = [];
  deletes = [];
  spies.push(
    spyOn(api, "get").mockImplementation((async (url: string) => {
      if (url === "/api/assistant/managers") return { managers };
      if (url.startsWith("/api/assistant/managers/proj/check")) {
        return { permissionMode: "bypassPermissions", replaces: { sessionId: "old", title: "Old manager" }, already: false };
      }
      throw new Error(`no stub for GET ${url}`);
    }) as never),
    spyOn(api, "put").mockImplementation((async (url: string, body: unknown) => { puts.push({ url, body }); return {}; }) as never),
    spyOn(api, "del").mockImplementation((async (url: string) => { deletes.push(url); return {}; }) as never),
  );
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
  Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true });
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function setManagers(list: unknown[]): Promise<void> {
  await act(async () => { window.dispatchEvent(new CustomEvent(MANAGERS_CHANGED_EVENT, { detail: { managers: list } })); });
  await settle();
}

async function mountRow(session: Row, projectName = "proj") {
  view = await mount(
    <SessionContextMenu session={session} projectName={projectName} projectTags={[]} onTogglePin={() => {}} onTagChanged={() => {}}>
      <div data-testid="row">{session.title}</div>
    </SessionContextMenu>,
  );
  await settle();
}

const rowEl = () => document.body.querySelector("[data-testid=row]")!;
const menuItems = () => [...document.body.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent?.trim());

async function rightClick(): Promise<void> {
  await act(async () => {
    rowEl().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
  await settle();
}

describe("on a desktop", () => {
  it("offers the role only for a Claude chat of a real project that is not a design chat", async () => {
    const cases: Array<[Row, string, boolean]> = [
      [claude, "proj", true],
      [{ ...claude, providerId: "codex" }, "proj", false],
      [{ ...claude, designSlug: "landing" }, "proj", false],
      [claude, ASSISTANT_PROJECT_NAME, false],
    ];
    for (const [session, project, offered] of cases) {
      await mountRow(session, project);
      await rightClick();
      expect(menuItems().includes("Set as manager chat")).toBe(offered);
      expect(menuItems()).not.toContain("Unset manager chat");
      await view!.unmount();
      view = null;
    }
  });

  it("offers Unset on the manager itself, and unsets through the route", async () => {
    await mountRow(claude);
    await setManagers([{ projectName: "proj", sessionId: "c1" }]);
    await rightClick();
    expect(menuItems()).toContain("Unset manager chat");
    expect(menuItems()).not.toContain("Set as manager chat");
    const item = [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.includes("Unset"))!;
    await click(item);
    await settle();
    expect(deletes).toEqual(["/api/assistant/managers/proj"]);
    await setManagers([]);
  });

  it("states what the role means and what it replaces before assigning", async () => {
    await mountRow(claude);
    await rightClick();
    const item = [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.includes("Set as manager"))!;
    await click(item);
    await settle();
    const text = document.body.textContent ?? "";
    expect(text).toContain(MANAGER_ASSIGN_CONSEQUENCE);
    expect(text).toContain(MANAGER_ASSIGN_BYPASS);
    expect(text).toContain("Old manager");
    const confirm = [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Replace manager")!;
    await click(confirm);
    await settle();
    expect(puts).toEqual([{ url: "/api/assistant/managers/proj", body: { sessionId: "c1" } }]);
  });
});

describe("on a phone", () => {
  beforeEach(() => Object.defineProperty(window, "innerWidth", { value: 390, configurable: true }));

  it("opens the same items with a long press", async () => {
    await mountRow(claude);
    await act(async () => { rowEl().dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true })); });
    await act(async () => { await Bun.sleep(450); });
    await act(async () => { rowEl().dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true })); });
    await settle();
    const buttons = [...document.body.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(buttons).toContain("Set as manager chat");
    expect(buttons).toContain("Pin");
  });
});
