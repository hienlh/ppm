/**
 * Settings → PPM Assistant's own panes against a stub server: each control calls the route it
 * should with only what it means to change — a manager row's digest switch PATCHes that project,
 * the rules dialog offers Approve/Revert only while a change is held, the notebook stops adding
 * at its cap and marks a line verified on request, the digest switch saves with the browser's
 * zone and leaves the rest of the row alone, and the manager table keeps a stacked form for a
 * narrow pane.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { click, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installGlobal("MutationObserver", window.MutationObserver);
installGlobal("DocumentFragment", window.DocumentFragment);
afterAll(uninstallDom);

const { act } = await import("react");
const { AssistantManagerChatsSection } = await import("../../../src/web/components/settings/assistant/assistant-manager-chats-section");
const { ManagerRulesDialog } = await import("../../../src/web/components/settings/assistant/manager-rules-dialog");
const { AssistantNotebookSection } = await import("../../../src/web/components/settings/assistant/assistant-notebook-section");
const { AssistantDigestQuietSection } = await import("../../../src/web/components/settings/assistant/assistant-digest-quiet-section");
const { useProjectStore } = await import("../../../src/web/stores/project-store");

interface Answer { status?: number; body: unknown }
type Req = { method: string; url: string; body: unknown };

const realFetch = globalThis.fetch;
let requests: Req[] = [];
let answers: Array<(req: Req) => Answer | undefined> = [];
const ok = (data: unknown): Answer => ({ body: { ok: true, data } });
const on = (method: string, url: string, answer: (req: Req) => Answer) => (req: Req) => (req.method === method && req.url === url ? answer(req) : undefined);
const sent = (method: string, url: string) => requests.filter((r) => r.method === method && r.url === url).map((r) => r.body);

const SETTINGS = {
  default_provider: null, providers: {}, instructions: "Be brief.", mcp_servers: [],
  manager_default_mode: "default", manager_template: "", quiet_hours: { enabled: false, start: "22:00", end: "07:00" },
  digest: { enabled: true, time: "08:00" }, timezone: "Europe/London",
};
const SETTINGS_RESPONSE = {
  settings: SETTINGS, providers: [{ id: "claude", name: "Claude" }],
  limits: { instructionsMaxChars: 8000, maxServers: 20, managerTemplateMaxBytes: 16384 }, managerTemplateBuiltIn: "# Manager rules\n",
};
const MANAGER = {
  projectName: "nxsys", projectPath: "/p/nxsys", sessionId: "mgr-1", providerId: "claude", title: "Manager",
  phase: "idle", permissionMode: "default", digest: true, telegramDetail: "full", waiting: 0, rulesPending: true, toolsPending: true,
};

beforeEach(() => {
  requests = [];
  answers = [
    on("GET", "/api/assistant/settings", () => ok(SETTINGS_RESPONSE)),
    on("PUT", "/api/assistant/settings", (req) => ok({ ...SETTINGS_RESPONSE, settings: { ...SETTINGS, ...(req.body as object) } })),
    on("GET", "/api/assistant/managers", () => ok({ managers: [MANAGER] })),
  ];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = { method: (init?.method ?? "GET").toUpperCase(), url: String(input), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    requests.push(req);
    for (const answer of answers) {
      const a = answer(req);
      if (a) return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: false, error: `no stub for ${req.method} ${req.url}` }), { status: 599 });
  }) as typeof fetch;
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
});

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const text = () => document.body.textContent ?? "";
const buttons = (label: string) => [...document.body.querySelectorAll("button")].filter((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label);

describe("manager chats", () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [{ name: "nxsys", path: "/p/nxsys" }, { name: "pex", path: "/p/pex" }] as never });
  });

  it("lists every project with its manager, mode, held change and pending tools, and offers Assign / create where none", async () => {
    view = await mount(<AssistantManagerChatsSection />);
    await settle();
    const nxsys = document.body.querySelector("[data-manager-row=nxsys]")!;
    expect(nxsys.textContent).toContain("Manager");
    expect(nxsys.textContent).toContain("Ask");
    expect(nxsys.querySelector("[data-rules-pending]")?.textContent).toBe("Change waiting");
    expect(nxsys.querySelector("[data-tools-pending]")?.textContent).toBe("Manager tools arrive the next time this chat starts.");
    expect(document.body.querySelector("[data-manager-row=pex]")!.textContent).toContain("Assign / create");
    expect(text()).toContain("PPM guards only .ppm/manager.md. Files it points to are the manager's own working files.");
  });

  it("switches one project's digest with a PATCH naming only the digest", async () => {
    answers.unshift(on("PATCH", "/api/assistant/managers/nxsys", () => ok({ updated: true })));
    view = await mount(<AssistantManagerChatsSection />);
    await settle();
    await click(buttons("Morning digest for nxsys")[0]!);
    await settle();
    expect(sent("PATCH", "/api/assistant/managers/nxsys")).toEqual([{ digest: false }]);
  });

  it("keeps a stacked form for a narrow pane: labelled cells, the header row only when wide", async () => {
    view = await mount(<AssistantManagerChatsSection />);
    await settle();
    const header = [...document.body.querySelectorAll("[aria-hidden]")].find((el) => el.textContent?.startsWith("ProjectManager chat"))!;
    expect(header.className).toContain("hidden");
    expect(header.className).toContain("@[680px]:grid");
    const labels = [...document.body.querySelectorAll("[data-manager-row=nxsys] span")].filter((s) => s.className.includes("@[680px]:hidden"));
    expect(labels.map((l) => l.textContent)).toEqual(["Mode", "Rules", "Telegram", "Digest"]);
  });
});

describe("the rules dialog", () => {
  const RULES = { approved: "- a\n", accepted: "- a\n- b\n", proposed: null, pendingHash: null, approvedAt: 1, addedSince: ["- b"], proposedDiff: null };

  it("edits the whole file and saves it with PUT, with no decision to make", async () => {
    answers.unshift(
      on("GET", "/api/assistant/managers/nxsys/rules", () => ok({ rules: RULES })),
      on("PUT", "/api/assistant/managers/nxsys/rules", (req) => ok({ rules: { ...RULES, accepted: (req.body as { text: string }).text } })),
    );
    view = await mount(<ManagerRulesDialog projectName="nxsys" onClose={() => {}} />);
    await settle();
    const area = document.body.querySelector("textarea")!;
    expect(area.value).toBe("- a\n- b\n");
    expect(document.body.querySelector("[data-added-since]")?.textContent).toBe("- b");
    expect(buttons("Approve change")).toHaveLength(0);
    expect(buttons("Revert")).toHaveLength(0);
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(area), "value")!.set!.call(area, "- a\n- b\n- c\n");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(buttons("Save")[0]!);
    await settle();
    expect(sent("PUT", "/api/assistant/managers/nxsys/rules")).toEqual([{ text: "- a\n- b\n- c\n" }]);
  });

  it("shows a held change with Approve change and Revert, named by its hash", async () => {
    const hash = "f".repeat(64);
    answers.unshift(
      on("GET", "/api/assistant/managers/nxsys/rules", () => ok({ rules: { ...RULES, proposed: "- a\n", pendingHash: hash, proposedDiff: { added: [], removed: ["- b"] } } })),
      on("POST", "/api/assistant/managers/nxsys/rules/decision", () => ok({ rules: RULES })),
    );
    view = await mount(<ManagerRulesDialog projectName="nxsys" onClose={() => {}} />);
    await settle();
    expect(document.body.querySelector("[data-rules-change]")?.textContent).toContain("- - b");
    await click(buttons("Revert")[0]!);
    await settle();
    expect(sent("POST", "/api/assistant/managers/nxsys/rules/decision")).toEqual([{ action: "revert", hash }]);
  });
});

describe("the notebook", () => {
  const NOTE = { id: 7, text: "Deadline is Friday.", source: "assistant", unverified: true, createdAt: 1, updatedAt: Date.UTC(2026, 10, 10) };

  it("shows the header line, the meter and Unverified, and stops adding at the cap", async () => {
    answers.unshift(
      on("GET", "/api/assistant/notes", () => ok({ notes: [NOTE], used: 4000, cap: 4000, noteMax: 300 })),
      on("PATCH", "/api/assistant/notes/7", () => ok({ note: { ...NOTE, unverified: false } })),
    );
    view = await mount(<AssistantNotebookSection />);
    await settle();
    expect(text()).toContain("A note never grants permission or counts as your OK.");
    expect(document.body.querySelector("[data-notebook-meter]")?.textContent).toContain("4,000 / 4,000 characters");
    expect(document.body.querySelector("[data-unverified]")?.textContent).toBe("Unverified");
    expect(text()).toContain("Assistant · 10/11");
    expect(buttons("Add line")[0]!.disabled).toBe(true);
    for (const b of [...buttons("Edit note"), ...buttons("Delete note")]) expect(b.className).toContain("size-11");

    await click(buttons("Mark as verified")[0]!);
    await settle();
    expect(sent("PATCH", "/api/assistant/notes/7")).toEqual([{ verified: true }]);
  });

  it("adds a line with POST while there is room", async () => {
    answers.unshift(
      on("GET", "/api/assistant/notes", () => ok({ notes: [], used: 0, cap: 4000, noteMax: 300 })),
      on("POST", "/api/assistant/notes", () => ok({ note: { ...NOTE, source: "user", unverified: false } })),
    );
    view = await mount(<AssistantNotebookSection />);
    await settle();
    await click(buttons("Add line")[0]!);
    const area = document.body.querySelector<HTMLTextAreaElement>("textarea[aria-label='New note']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(area), "value")!.set!.call(area, "Release only on Thursdays.");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(buttons("Add")[0]!);
    await settle();
    expect(sent("POST", "/api/assistant/notes")).toEqual([{ text: "Release only on Thursdays." }]);
  });
});

describe("digest and quiet hours", () => {
  it("saves the digest switch with this browser's zone, the General fields as stored, and no other sub-tab's keys", async () => {
    view = await mount(<AssistantDigestQuietSection />);
    await settle();
    expect(document.body.querySelector("[data-testid=assistant-time-zone]")?.textContent).toContain("Times are in Europe/London");
    await click(buttons("Morning digest")[0]!);
    await settle();
    const [body] = sent("PUT", "/api/assistant/settings") as Array<Record<string, unknown>>;
    expect(body!.digest).toEqual({ enabled: false, time: "08:00" });
    expect(body!.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(body!.instructions).toBe("Be brief.");
    // Left out, so the server keeps what is stored rather than what this pane last read.
    for (const key of ["quiet_hours", "manager_default_mode", "manager_template", "main_session"]) expect(key in body!).toBe(false);
  });
});
