import { describe, expect, test } from "bun:test";
import { createManagerToolHandlers } from "../../../../src/services/assistant-mcp/assistant-manager-tools.ts";
import type { ManagerToolDeps } from "../../../../src/services/assistant-mcp/assistant-manager-write-tools.ts";
import { MANAGER_TOOL_DEFINITIONS } from "../../../../src/services/assistant-mcp/assistant-manager-tool-definitions.ts";
import type { ApprovalAsk, ApprovalVerdict } from "../../../../src/services/assistant-mcp/assistant-approval-broker.ts";
import type { ToolContext } from "../../../../src/services/assistant-mcp/assistant-tool-family.ts";
import { MANAGER_ASSIGN_TOOL, MANAGER_TOOLS, MANAGER_UNASSIGN_TOOL } from "../../../../src/shared/assistant-manager-tool-names.ts";
import { MANAGER_ASSIGN_BYPASS, MANAGER_ASSIGN_CONSEQUENCE } from "../../../../src/shared/assistant-managers.ts";
import { UNATTENDED_TURN_REFUSAL } from "../../../../src/services/chat-control/chat-control.ts";
import { ASSISTANT_CHATS_SUBSECTIONS } from "../../../../src/services/assistant/assistant-instructions-chats.ts";
import { assistantManagersContextEntry } from "../../../../src/services/assistant/assistant-managers-context.ts";

/**
 * `manager_assign` and `manager_unassign` over stand-in dependencies: what each refuses before a
 * card, what the card says, what it reads again after the answer, and that the change goes to the
 * same assign/unassign calls the session list makes.
 */

type Chat = { project: string; providerId: "claude" | "codex"; title: string | null; design?: boolean };

interface Harness {
  ctx: ToolContext;
  asks: ApprovalAsk[];
  calls: string[];
  chats: Map<string, Chat>;
  managers: Map<string, string>;
  modes: Map<string, string>;
  unattended: { on: boolean };
  deps: ManagerToolDeps;
}

const PROJECTS = [{ name: "Nxsys", path: "/code/nxsys" }, { name: "other", path: "/code/other" }];
const pathOf = (name: string) => PROJECTS.find((p) => p.name === name)!.path;

function harness(opts: { verdict?: ApprovalVerdict; onAsk?: (h: Harness) => void } = {}): Harness {
  const chats = new Map<string, Chat>([
    ["quanly", { project: "Nxsys", providerId: "claude", title: "Quản lý" }],
    ["old", { project: "Nxsys", providerId: "claude", title: "Old manager" }],
    ["codex1", { project: "Nxsys", providerId: "codex", title: "Codex chat" }],
    ["design1", { project: "Nxsys", providerId: "claude", title: "A design", design: true }],
    ["elsewhere", { project: "other", providerId: "claude", title: "Other chat" }],
  ]);
  const managers = new Map<string, string>();
  const modes = new Map<string, string>();
  const calls: string[] = [];
  const asks: ApprovalAsk[] = [];
  const unattended = { on: false };
  const deps: ManagerToolDeps = {
    projects: () => PROJECTS,
    target: (project, sessionId) => {
      if (sessionId === "assistant1") return { ok: false, error: "That is a PPM Assistant chat, not one of the project's chats." };
      const chat = typeof sessionId === "string" ? chats.get(sessionId) : undefined;
      if (!chat || chat.project !== project.name) return { ok: false, error: `Session ${String(sessionId)} is not a chat of project "${project.name}".` };
      return { ok: true, value: { sessionId: sessionId as string, providerId: chat.providerId } };
    },
    title: async (sessionId) => chats.get(sessionId)?.title ?? null,
    lastActivity: () => Date.UTC(2026, 10, 13, 8, 30),
    mode: (sessionId) => modes.get(sessionId) ?? "default",
    managerOf: (path) => {
      const id = [...managers.entries()].find(([p]) => pathOf(p) === path)?.[1];
      return id ? { sessionId: id, providerId: "claude" } : null;
    },
    checkAssign: async (_project, sessionId) => {
      if (chats.get(sessionId)?.design) throw new Error("A design chat cannot be a manager chat");
      return { sessionId };
    },
    assign: async (project, sessionId, onlyIfNone) => {
      calls.push(`assign ${project} ${sessionId} onlyIfNone=${onlyIfNone}`);
      const replaced = managers.get(project) ?? null;
      managers.set(project, sessionId);
      return { replaced };
    },
    unassign: (project) => {
      calls.push(`unassign ${project}`);
      return managers.delete(project);
    },
    unattended: () => unattended.on,
  };
  const h: Harness = {
    asks, calls, chats, managers, modes, unattended, deps,
    ctx: {
      sessionId: "assistant-session",
      callRoute: (async () => { throw new Error("no route may be called"); }) as ToolContext["callRoute"],
      ask: async (ask) => {
        asks.push(ask);
        opts.onAsk?.(h);
        return opts.verdict ?? { verdict: "approved" };
      },
    },
  };
  return h;
}

const run = (h: Harness, tool: string, args: Record<string, unknown>) =>
  createManagerToolHandlers(async () => h.deps)[tool]!(h.ctx, args) as Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
const text = (r: { content: Array<{ text: string }> }) => r.content[0]!.text;

test("the Assistant is told to adopt an existing chat, and where the user does it", () => {
  expect(ASSISTANT_CHATS_SUBSECTIONS).toContain("adopt it with `manager_assign` rather than creating a new one");
  expect(ASSISTANT_CHATS_SUBSECTIONS).toContain('"Set as manager chat" / "Unset manager chat"');
  expect(assistantManagersContextEntry([])).toContain("manager_assign makes a chat the user already has the manager");
});

test("names, definitions and handlers line up", () => {
  expect(MANAGER_TOOL_DEFINITIONS.map((d) => d.name)).toEqual([...MANAGER_TOOLS]);
  expect(Object.keys(createManagerToolHandlers(async () => harness().deps))).toEqual([...MANAGER_TOOLS]);
  expect(MANAGER_TOOL_DEFINITIONS[0]!.description).toContain("\"Set as manager chat\"");
  expect(MANAGER_TOOL_DEFINITIONS[1]!.description).toContain("\"Unset manager chat\"");
});

describe("manager_assign", () => {
  test("asks with a card PPM builds, then assigns through the session list's call", async () => {
    const h = harness();
    const r = await run(h, MANAGER_ASSIGN_TOOL, { project: "Nxsys", sessionId: "quanly" });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r))).toMatchObject({ outcome: "assigned", project: "Nxsys", sessionId: "quanly" });
    expect(h.calls).toEqual(["assign Nxsys quanly onlyIfNone=true"]);
    expect(h.asks).toHaveLength(1);
    const { tool, input, summary } = h.asks[0]!;
    expect(tool).toBe(MANAGER_ASSIGN_TOOL);
    expect(input).toEqual({ project: "Nxsys", sessionId: "quanly" });
    expect(summary.headline).toBe('Make "Quản lý" the manager chat of "Nxsys"');
    expect(summary.facts).toEqual([
      { label: "Project", value: "Nxsys" },
      { label: "Chat", value: "Quản lý (quanly)" },
      { label: "Provider", value: "Claude" },
      { label: "Last activity", value: "2026-11-13T08:30:00.000Z" },
      { label: "Mode (unchanged)", value: "Ask before risky tools (default)" },
    ]);
    expect(summary.warning).toContain(MANAGER_ASSIGN_CONSEQUENCE);
    expect(summary.warning).toContain(".ppm/manager.md");
    expect(summary.warning).not.toContain(MANAGER_ASSIGN_BYPASS);
  });

  test("calls out a chat that runs without asking", async () => {
    const h = harness();
    h.modes.set("quanly", "bypassPermissions");
    await run(h, MANAGER_ASSIGN_TOOL, { project: "Nxsys", sessionId: "quanly" });
    const { summary } = h.asks[0]!;
    expect(summary.facts.find((f) => f.label === "Mode (unchanged)")).toMatchObject({ tone: "warning" });
    expect(summary.warning).toContain(MANAGER_ASSIGN_BYPASS);
  });

  test.each([
    ["an unregistered project", { project: "nope", sessionId: "quanly" }, "No registered project"],
    ["the Assistant's own project", { project: "__assistant__", sessionId: "quanly" }, "not a project"],
    ["a missing chat", { project: "Nxsys", sessionId: "gone" }, "is not a chat of project"],
    ["a chat of another project", { project: "Nxsys", sessionId: "elsewhere" }, "is not a chat of project"],
    ["an Assistant chat", { project: "Nxsys", sessionId: "assistant1" }, "PPM Assistant chat"],
    ["a Codex chat", { project: "Nxsys", sessionId: "codex1" }, "Manager chats run on Claude"],
    ["a Codex provider asked for", { project: "Nxsys", sessionId: "quanly", providerId: "codex" }, "Manager chats run on Claude"],
    ["a design chat", { project: "Nxsys", sessionId: "design1" }, "A design chat cannot be a manager chat"],
    ["a non-boolean replace", { project: "Nxsys", sessionId: "quanly", replace: "yes" }, "`replace`"],
  ])("refuses %s before asking", async (_what, args, message) => {
    const h = harness();
    const r = await run(h, MANAGER_ASSIGN_TOOL, args);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(message);
    expect(h.asks).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  test("refuses in a turn PPM started, before asking", async () => {
    const h = harness();
    h.unattended.on = true;
    const r = await run(h, MANAGER_ASSIGN_TOOL, { project: "Nxsys", sessionId: "quanly" });
    expect(text(r)).toBe(UNATTENDED_TURN_REFUSAL);
    expect(h.asks).toEqual([]);
  });

  test("names the current manager and refuses without replace", async () => {
    const h = harness();
    h.managers.set("Nxsys", "old");
    const r = await run(h, MANAGER_ASSIGN_TOOL, { project: "Nxsys", sessionId: "quanly" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('"Old manager" (session old)');
    expect(text(r)).toContain("manager_unassign");
    expect(text(r)).toContain("`replace: true`");
    expect(h.asks).toEqual([]);
  });

  test("refuses a chat that already is the manager", async () => {
    const h = harness();
    h.managers.set("Nxsys", "quanly");
    const r = await run(h, MANAGER_ASSIGN_TOOL, { project: "Nxsys", sessionId: "quanly", replace: true });
    expect(text(r)).toContain("already is the manager chat");
    expect(h.asks).toEqual([]);
  });

  test("with replace, the card names the chat that stops being the manager", async () => {
    const h = harness();
    h.managers.set("Nxsys", "old");
    const r = await run(h, MANAGER_ASSIGN_TOOL, { project: "Nxsys", sessionId: "quanly", replace: true });
    expect(JSON.parse(text(r))).toMatchObject({ outcome: "assigned", replaced: "old" });
    const { input, summary } = h.asks[0]!;
    expect(input).toEqual({ project: "Nxsys", sessionId: "quanly", replace: true });
    expect(summary.headline).toBe('Make "Quản lý" the manager chat of "Nxsys", replacing "Old manager"');
    expect(summary.facts).toContainEqual({ label: "Stops being the manager", value: "Old manager (old)", tone: "warning" });
    expect(h.calls).toEqual(["assign Nxsys quanly onlyIfNone=false"]);
  });

  test("changes nothing when the user declines", async () => {
    const h = harness({ verdict: { verdict: "denied", reason: "The user declined." } });
    const r = await run(h, MANAGER_ASSIGN_TOOL, { project: "Nxsys", sessionId: "quanly" });
    expect(JSON.parse(text(r))).toMatchObject({ outcome: "declined", action: MANAGER_ASSIGN_TOOL });
    expect(h.calls).toEqual([]);
  });

  test("reads the project's manager again after the answer", async () => {
    const h = harness({ onAsk: (x) => x.managers.set("Nxsys", "old") });
    const r = await run(h, MANAGER_ASSIGN_TOOL, { project: "Nxsys", sessionId: "quanly" });
    expect(text(r)).toContain("Not assigned (stale)");
    expect(text(r)).toContain("session old");
    expect(h.calls).toEqual([]);
  });

  test("reads the chat again after the answer", async () => {
    const h = harness({ onAsk: (x) => x.chats.delete("quanly") });
    const r = await run(h, MANAGER_ASSIGN_TOOL, { project: "Nxsys", sessionId: "quanly" });
    expect(text(r)).toContain("Not assigned (stale)");
    expect(h.calls).toEqual([]);
  });

  test("reports the service's own refusal", async () => {
    const h = harness();
    h.deps.assign = async () => { throw new Error("Nxsys already has a manager chat (session x)"); };
    const r = await run(h, MANAGER_ASSIGN_TOOL, { project: "Nxsys", sessionId: "quanly" });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("Not assigned: Nxsys already has a manager chat (session x)");
  });
});

describe("manager_unassign", () => {
  test("asks, then unassigns through the session list's call; the chat is kept", async () => {
    const h = harness();
    h.managers.set("Nxsys", "quanly");
    const r = await run(h, MANAGER_UNASSIGN_TOOL, { project: "Nxsys" });
    expect(JSON.parse(text(r))).toMatchObject({ outcome: "unassigned", project: "Nxsys", sessionId: "quanly" });
    expect(h.calls).toEqual(["unassign Nxsys"]);
    const { tool, input, summary } = h.asks[0]!;
    expect({ tool, input }).toEqual({ tool: MANAGER_UNASSIGN_TOOL, input: { project: "Nxsys" } });
    expect(summary.headline).toBe('Stop "Quản lý" being the manager chat of "Nxsys"');
    expect(summary.facts).toEqual([{ label: "Project", value: "Nxsys" }, { label: "Chat", value: "Quản lý (quanly)" }]);
    expect(summary.warning).toContain("The chat itself is kept");
  });

  test("refuses a project with no manager, before asking", async () => {
    const h = harness();
    const r = await run(h, MANAGER_UNASSIGN_TOOL, { project: "Nxsys" });
    expect(text(r)).toContain("has no manager chat");
    expect(h.asks).toEqual([]);
  });

  test("refuses in a turn PPM started, before asking", async () => {
    const h = harness();
    h.managers.set("Nxsys", "quanly");
    h.unattended.on = true;
    expect(text(await run(h, MANAGER_UNASSIGN_TOOL, { project: "Nxsys" }))).toBe(UNATTENDED_TURN_REFUSAL);
    expect(h.asks).toEqual([]);
  });

  test("changes nothing when the manager changed while the card waited", async () => {
    const h = harness({ onAsk: (x) => x.managers.set("Nxsys", "old") });
    h.managers.set("Nxsys", "quanly");
    const r = await run(h, MANAGER_UNASSIGN_TOOL, { project: "Nxsys" });
    expect(text(r)).toContain("Not unassigned (stale)");
    expect(h.calls).toEqual([]);
  });
});
