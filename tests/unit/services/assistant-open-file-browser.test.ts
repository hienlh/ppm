/**
 * `ui_open_file_browser` on the server: any folder on this machine's drives, a file as its folder
 * with the file selected, held to the file browser's rules before the device is asked; the device
 * is handed the folder and file the server resolved, and its answer is passed on. Navigation only,
 * so no card.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSISTANT_TOOL_DEFINITIONS } from "../../../src/services/assistant-mcp/assistant-mcp-tools.ts";
import { uiOpenFileBrowser } from "../../../src/services/assistant-mcp/assistant-open-file-browser.ts";
import { UI_NAV_WAIT_MS } from "../../../src/services/assistant-mcp/assistant-ui-nav-tools.ts";
import { assistantPrivateScope } from "../../../src/services/assistant/assistant-private-paths.ts";
import { assistantToolDecision } from "../../../src/services/assistant/assistant-tool-policy.ts";
import type { AssistantUiBody, AssistantUiOutcome } from "../../../src/services/assistant-mcp/assistant-ui-tools.ts";

let root: string;
const text = (result: any): string => result.content[0].text;
const deps = () => ({ scope: assistantPrivateScope({ projectRoots: [], home: join(root, "home"), roots: [join(root, "home", ".ssh")] }) });

function device(answer: { ok: true; data: unknown } | { ok: false; error: string }) {
  const asked: Array<{ sessionId: string; body: AssistantUiBody; waitMs: number }> = [];
  const request = async (sessionId: string, body: AssistantUiBody, waitMs: number): Promise<AssistantUiOutcome> => {
    asked.push({ sessionId, body, waitMs });
    return { ok: true, result: { type: "assistant_ui_result", requestId: "r", ...answer } as never };
  };
  return { asked, request };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-asst-file-browser-"));
  mkdirSync(join(root, "tiktok", "story-2026-11-19-london"), { recursive: true });
  writeFileSync(join(root, "tiktok", "story-2026-11-19-london", "cut.mp4"), "x");
  mkdirSync(join(root, "home", ".ssh"), { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("ui_open_file_browser", () => {
  it("is described to the agent as navigation and needs no card", () => {
    const def = ASSISTANT_TOOL_DEFINITIONS.find((t) => t.name === "ui_open_file_browser");
    expect(def?.inputSchema.required).toEqual(["path"]);
    expect(def?.annotations.readOnlyHint).toBe(false);
    expect(assistantToolDecision("mcp__ppm-assistant__ui_open_file_browser", {}, { projectRoots: [root], cwd: null } as never)).toBe("allow");
  });

  it("opens a folder on the chatting device and passes its answer on", async () => {
    const dir = join(root, "tiktok", "story-2026-11-19-london");
    const { asked, request } = device({ ok: true, data: { dir, select: null, surface: "sheet" } });
    const result = await uiOpenFileBrowser("s1", { path: dir }, request, deps());
    expect(asked).toEqual([{ sessionId: "s1", body: { op: "open_file_browser", args: { dir, select: null } }, waitMs: UI_NAV_WAIT_MS }]);
    expect(JSON.parse(text(result))).toEqual({ dir, select: null, surface: "sheet", kind: "folder" });
  });

  it("opens a file's folder with the file selected", async () => {
    const dir = join(root, "tiktok", "story-2026-11-19-london");
    const file = join(dir, "cut.mp4");
    const { asked, request } = device({ ok: true, data: { dir, select: file, surface: "window" } });
    const result = await uiOpenFileBrowser("s1", { path: file }, request, deps());
    expect(asked[0]!.body.args).toEqual({ dir, select: file });
    expect(JSON.parse(text(result))).toMatchObject({ select: file, kind: "file", surface: "window" });
  });

  it("asks no device for a refused, missing or relative path", async () => {
    for (const path of [join(root, "home", ".ssh", "id_rsa"), join(root, "nope"), "tiktok"]) {
      const { asked, request } = device({ ok: true, data: {} });
      const result: any = await uiOpenFileBrowser("s1", { path }, request, deps());
      expect(result.isError).toBe(true);
      expect(asked).toHaveLength(0);
    }
  });

  it("reports a device that could not open it, or answered nonsense", async () => {
    const dir = join(root, "tiktok");
    const failed: any = await uiOpenFileBrowser("s1", { path: dir }, device({ ok: false, error: "no window" }).request, deps());
    expect(failed.isError).toBe(true);
    expect(text(failed)).toContain("no window");
    const odd: any = await uiOpenFileBrowser("s1", { path: dir }, device({ ok: true, data: { dir: 3 } }).request, deps());
    expect(odd.isError).toBe(true);
  });
});
