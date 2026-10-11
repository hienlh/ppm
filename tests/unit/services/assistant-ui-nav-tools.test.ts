/**
 * The Assistant's navigation tools on the server: the project and every target are checked
 * against what PPM has registered before the device is asked, the device gets only the
 * normalised target, its answer is passed on with `previousProject`, and a close the device
 * refused for unsaved work happens only once the user approves it.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configService } from "../../../src/services/config.service.ts";
import { insertConnection, updateConnection } from "../../../src/services/db.service.ts";
import { ASSISTANT_TOOL_DEFINITIONS } from "../../../src/services/assistant-mcp/assistant-mcp-tools.ts";
import {
  UI_NAV_WAIT_MS, uiCloseTab, uiFocusTab, uiOpenTab, uiSwitchProject,
} from "../../../src/services/assistant-mcp/assistant-ui-nav-tools.ts";
import { UI_NAV_TOOL_DEFINITIONS } from "../../../src/services/assistant-mcp/assistant-ui-tool-definitions.ts";
import { ASSISTANT_UI_NO_DEVICE_MESSAGE, type AssistantUiBody, type AssistantUiOutcome } from "../../../src/services/assistant-mcp/assistant-ui-tools.ts";
import { noApprover, type ApprovalAsk } from "../../../src/services/assistant-mcp/assistant-approval-broker.ts";

let root: string;
let saved: unknown;
const text = (result: any): string => result.content[0].text;

/** A device that records what it was asked and answers `data`. */
function device(data: unknown) {
  const asked: Array<{ sessionId: string; body: AssistantUiBody; waitMs: number }> = [];
  const request = async (sessionId: string, body: AssistantUiBody, waitMs: number): Promise<AssistantUiOutcome> => {
    asked.push({ sessionId, body, waitMs });
    return { ok: true, result: { type: "assistant_ui_result", requestId: "r", ok: true, data } };
  };
  return { asked, request };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-asst-nav-"));
  mkdirSync(join(root, "api", "src"), { recursive: true });
  writeFileSync(join(root, "api", "src", "main.ts"), "export {};\n");
  writeFileSync(join(root, "outside.txt"), "x\n");
  saved = configService.get("projects");
  configService.set("projects", [{ name: "api", path: join(root, "api") }]);
});
afterAll(() => {
  configService.set("projects", saved as never);
  rmSync(root, { recursive: true, force: true });
});

describe("the navigation tools", () => {
  it("are served after ui_get_state and change nothing but the screen", () => {
    const names = ASSISTANT_TOOL_DEFINITIONS.map((d) => d.name);
    expect(names.slice(names.indexOf("ui_get_state") + 1, names.indexOf("ui_get_state") + 5))
      .toEqual(["ui_open_tab", "ui_focus_tab", "ui_switch_project", "ui_close_tab"]);
    for (const def of UI_NAV_TOOL_DEFINITIONS) expect(def.annotations).toMatchObject({ destructiveHint: false, openWorldHint: false });
  });
});

describe("ui_open_tab", () => {
  it("sends the device a file resolved against the named project, and answers previousProject", async () => {
    const d = device({ tabId: "editor:src/main.ts", project: "api", previousProject: "web" });
    const result = await uiOpenTab("s1", { project: "api", kind: "file", target: { path: "src/main.ts", line: 3 } }, d.request);
    expect(d.asked).toEqual([{
      sessionId: "s1", waitMs: UI_NAV_WAIT_MS,
      body: { op: "open_tab", args: { project: "api", target: { kind: "file", filePath: "src/main.ts", projectName: "api", line: 3 } } },
    }]);
    expect(JSON.parse(text(result))).toEqual({ tabId: "editor:src/main.ts", project: "api", previousProject: "web" });
  });

  it("names a file outside the project by its absolute path", async () => {
    const d = device({ tabId: "t", project: "api", previousProject: "api" });
    await uiOpenTab("s1", { project: "api", kind: "file", target: { path: join(root, "outside.txt") } }, d.request);
    expect((d.asked[0]!.body.args as any).target).toEqual({ kind: "file", filePath: join(root, "outside.txt"), projectName: null });
  });

  it("refuses an unknown project, kind or target without asking the device", async () => {
    const d = device({});
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ project: "nope", kind: "terminal" }, "No registered project"],
      [{ project: "__assistant__", kind: "terminal" }, "not a project"],
      [{ project: "api", kind: "shell" }, "`kind` must be one of"],
      [{ project: "api", kind: "file", target: { path: "missing.ts" } }, "There is no file"],
      [{ project: "api", kind: "chat", target: { sessionId: "../../etc" } }, "not a valid session id"],
      [{ project: "api", kind: "database", target: { connectionId: 999_999 } }, "No saved connection"],
      [{ project: "api", kind: "git", target: { view: "blame" } }, "`target.view`"],
      [{ project: "api", kind: "settings", target: { section: "../x" } }, "Settings section"],
    ];
    for (const [args, message] of cases) {
      const result = await uiOpenTab("s1", args, d.request);
      expect((result as any).isError).toBe(true);
      expect(text(result)).toContain(message);
    }
    expect(d.asked).toHaveLength(0);
  });

  it("opens only a connection the user left available to the AI, without its address", async () => {
    const open = insertConnection("sqlite", "shop", { type: "sqlite", path: join(root, "shop.db") }).id;
    const hidden = insertConnection("sqlite", "secret", { type: "sqlite", path: join(root, "secret.db") }).id;
    updateConnection(hidden, { aiAccess: 0 });
    const d = device({ tabId: "database:x", project: "api", previousProject: "api" });
    await uiOpenTab("s1", { project: "api", kind: "database", target: { connectionId: "shop", table: "orders" } }, d.request);
    expect((d.asked[0]!.body.args as any).target).toEqual({ kind: "database", connectionId: open, connectionName: "shop", dbType: "sqlite", table: "orders" });
    const refused = await uiOpenTab("s1", { project: "api", kind: "database", target: { connectionId: hidden } }, d.request);
    expect(text(refused)).toContain("not available to the AI");
    expect(d.asked).toHaveLength(1);
  });

  it("passes on no-device and a device's refusal", async () => {
    const none = await uiOpenTab("s1", { project: "api", kind: "terminal" },
      async () => ({ ok: false, reason: "no-device", message: ASSISTANT_UI_NO_DEVICE_MESSAGE }));
    expect(text(none)).toBe(`no-device: ${ASSISTANT_UI_NO_DEVICE_MESSAGE}`);
    const refused = await uiOpenTab("s1", { project: "api", kind: "terminal" },
      async () => ({ ok: true, result: { type: "assistant_ui_result", requestId: "r", ok: false, error: "This device has no project named \"api\"." } }));
    expect((refused as any).isError).toBe(true);
    expect(text(refused)).toContain("could not open the tab");
  });
});

describe("ui_focus_tab and ui_switch_project", () => {
  it("asks the device and answers previousProject", async () => {
    const d = device({ tabId: "terminal:2", project: "api", previousProject: "web", extra: "dropped" });
    expect(JSON.parse(text(await uiFocusTab("s1", { tabId: "terminal:2" }, d.request))))
      .toEqual({ tabId: "terminal:2", project: "api", previousProject: "web" });
    const s = device({ tabId: null, project: "api", previousProject: "web" });
    expect(JSON.parse(text(await uiSwitchProject("s1", { project: "api" }, s.request))).previousProject).toBe("web");
    expect(s.asked[0]!.body).toEqual({ op: "switch_project", args: { project: "api" } });
  });

  it("refuses a malformed tab id and an unknown project", async () => {
    const d = device({});
    expect(text(await uiFocusTab("s1", { tabId: "" }, d.request))).toContain("`tabId` is required");
    expect(text(await uiFocusTab("s1", { tabId: "a\nb" }, d.request))).toContain("`tabId` is required");
    expect(text(await uiSwitchProject("s1", { project: "web" }, d.request))).toContain("No registered project");
    expect(d.asked).toHaveLength(0);
  });
});

describe("ui_close_tab", () => {
  it("answers what was closed", async () => {
    const d = device({ closed: true, tabId: "editor:a", project: "api", closedTab: { type: "editor", title: "a.ts", project: "api", details: { filePath: "a.ts" } } });
    const body = JSON.parse(text(await uiCloseTab("s1", { tabId: "editor:a" }, noApprover, d.request)));
    expect(body).toMatchObject({ closed: true, tabId: "editor:a", closedTab: { type: "editor", title: "a.ts", project: "api", details: { filePath: "a.ts" } } });
  });

  /** A device that refuses the first close for unsaved work and closes on the approved one. */
  function dirtyDevice() {
    const asked: AssistantUiBody[] = [];
    const request = async (_s: string, body: AssistantUiBody): Promise<AssistantUiOutcome> => {
      asked.push(body);
      const data = body.args.discardUnsaved === true
        ? { closed: true, tabId: "editor:a", project: "api", closedTab: { type: "editor", title: "a.ts", project: "api" } }
        : { closed: false, tabId: "editor:a", needsApproval: { reason: "Its editor has changes that are not saved yet.", tab: { type: "editor", title: "a.ts", project: "api" } } };
      return { ok: true, result: { type: "assistant_ui_result", requestId: "r", ok: true, data } };
    };
    return { asked, request };
  }

  it("leaves a tab holding unsaved work open when the user declines, and says it is final", async () => {
    const d = dirtyDevice();
    const asks: ApprovalAsk[] = [];
    const result = await uiCloseTab("s1", { tabId: "editor:a", discardUnsaved: true }, async (a) => {
      asks.push(a);
      return { verdict: "denied", reason: "The user declined." };
    }, d.request);
    expect((result as any).isError).toBe(true);
    expect(JSON.parse(text(result))).toMatchObject({ outcome: "declined", action: "close_tab", tabId: "editor:a" });
    // The agent's own `discardUnsaved` is never passed on: the device was asked once, plainly.
    expect(d.asked).toEqual([{ op: "close_tab", args: { tabId: "editor:a" } }]);
    expect(asks[0]!.summary).toMatchObject({ headline: "Close a tab and discard its unsaved work", warning: "Its editor has changes that are not saved yet." });
    expect(asks[0]!.summary.facts).toContainEqual({ label: "Tab", value: "a.ts" });
  });

  it("closes it once the user approves", async () => {
    const d = dirtyDevice();
    const body = JSON.parse(text(await uiCloseTab("s1", { tabId: "editor:a" }, async () => ({ verdict: "approved" }), d.request)));
    expect(body).toMatchObject({ closed: true, tabId: "editor:a", closedTab: { title: "a.ts" } });
    expect(d.asked.map((b) => b.args)).toEqual([{ tabId: "editor:a" }, { tabId: "editor:a", discardUnsaved: true }]);
  });

  it("does not close it when the approval times out", async () => {
    const d = dirtyDevice();
    const result = await uiCloseTab("s1", { tabId: "editor:a" }, async () => ({ verdict: "timeout", reason: "No answer." }), d.request);
    expect(JSON.parse(text(result))).toMatchObject({ outcome: "no-answer", action: "close_tab" });
    expect(d.asked).toHaveLength(1);
  });
});
