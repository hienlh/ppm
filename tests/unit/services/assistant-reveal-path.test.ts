/**
 * `ui_reveal_path` on the server: a folder or file of the named project, resolved under the same
 * read rules a file tab uses, inside the project only (as written and after links), never in a
 * store the Assistant keeps private; the device gets the path relative to the project with its
 * kind, and its answer is passed on with `previousProject`. Navigation only, so no card.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configService } from "../../../src/services/config.service.ts";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";
import { ASSISTANT_TOOL_DEFINITIONS } from "../../../src/services/assistant-mcp/assistant-mcp-tools.ts";
import { resolveRevealPath, uiRevealPath } from "../../../src/services/assistant-mcp/assistant-reveal-path.ts";
import { UI_NAV_WAIT_MS } from "../../../src/services/assistant-mcp/assistant-ui-nav-tools.ts";
import { assistantToolDecision } from "../../../src/services/assistant/assistant-tool-policy.ts";
import type { AssistantUiBody, AssistantUiOutcome } from "../../../src/services/assistant-mcp/assistant-ui-tools.ts";

let root: string;
let api: string;
let saved: unknown;
const project = () => ({ name: "api", path: api });
const text = (result: any): string => result.content[0].text;
/** No private store but the one a test names. */
const deps = (privateRoots: string[] = []) => ({ projectRoots: () => [api], home: () => join(root, "home"), privateRoots: () => privateRoots });

function device(answer: { ok: true; data: unknown } | { ok: false; error: string }) {
  const asked: Array<{ sessionId: string; body: AssistantUiBody; waitMs: number }> = [];
  const request = async (sessionId: string, body: AssistantUiBody, waitMs: number): Promise<AssistantUiOutcome> => {
    asked.push({ sessionId, body, waitMs });
    return { ok: true, result: { type: "assistant_ui_result", requestId: "r", ...answer } as never };
  };
  return { asked, request };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-asst-reveal-"));
  api = join(root, "api");
  mkdirSync(join(api, "src", "server", "routes"), { recursive: true });
  mkdirSync(join(api, "keys"), { recursive: true });
  writeFileSync(join(api, "src", "server", "routes", "chat.ts"), "export {};\n");
  writeFileSync(join(root, "outside.txt"), "x\n");
  saved = configService.get("projects");
  configService.set("projects", [{ name: "api", path: api }]);
});
afterAll(() => {
  configService.set("projects", saved as never);
  rmSync(root, { recursive: true, force: true });
});

describe("resolveRevealPath", () => {
  it("names a deep folder, a file and the project's folder as the tree does", async () => {
    expect(await resolveRevealPath(project(), "src/server/routes", deps())).toEqual({ ok: true, value: { path: "src/server/routes", kind: "folder" } });
    expect(await resolveRevealPath(project(), join(api, "src", "server", "routes", "chat.ts"), deps()))
      .toEqual({ ok: true, value: { path: "src/server/routes/chat.ts", kind: "file" } });
    expect(await resolveRevealPath(project(), ".", deps())).toEqual({ ok: true, value: { path: "", kind: "folder" } });
  });

  it("refuses a path outside the project, written as one or through ..", async () => {
    for (const p of [join(root, "outside.txt"), "../outside.txt", "src/../../outside.txt"]) {
      const r = await resolveRevealPath(project(), p, deps());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("not inside project \"api\"");
    }
  });

  it("refuses a link inside the project that leads out of it", async () => {
    try {
      symlinkSync(root, join(api, "escape"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      return; // no links on this machine
    }
    const r = await resolveRevealPath(project(), "escape", deps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("leads outside project");
  });

  it("refuses a store the Assistant keeps private, a missing path and an empty one", async () => {
    const priv = await resolveRevealPath(project(), "keys", deps([join(api, "keys")]));
    expect(priv.ok).toBe(false);
    if (!priv.ok) expect(priv.error).toContain("logins or keys");
    const missing = await resolveRevealPath(project(), "src/nope", deps());
    expect(missing.ok).toBe(false);
    expect((await resolveRevealPath(project(), "  ", deps())).ok).toBe(false);
  });

  it("refuses PPM's own folder with the editor's read rule, when a project holds it", async () => {
    const ppm = getPpmDir();
    const r = await resolveRevealPath({ name: "home", path: join(ppm, "..") }, ppm, { ...deps(), projectRoots: () => [join(ppm, "..")] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("PPM does not show");
  });
});

describe("ui_reveal_path", () => {
  it("is served beside the navigation tools, changes nothing but the screen, and runs without asking", () => {
    const def = ASSISTANT_TOOL_DEFINITIONS.find((d) => d.name === "ui_reveal_path")!;
    expect(def.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    expect(assistantToolDecision("mcp__ppm-assistant__ui_reveal_path", {}, { projectRoots: [api], cwd: null } as never)).toBe("allow");
  });

  it("sends the device the project-relative path and its kind, and passes on previousProject", async () => {
    const d = device({ ok: true, data: { path: "src/server/routes", kind: "folder", project: "api", previousProject: "web" } });
    const result = await uiRevealPath("S1", { project: "api", path: "src/server/routes" }, d.request, deps());
    expect(d.asked).toEqual([{ sessionId: "S1", body: { op: "reveal_path", args: { project: "api", path: "src/server/routes", kind: "folder" } }, waitMs: UI_NAV_WAIT_MS }]);
    expect(JSON.parse(text(result))).toEqual({ path: "src/server/routes", kind: "folder", project: "api", previousProject: "web" });
  });

  it("asks no device for a refused path or an unknown project, and passes on the device's own refusal", async () => {
    const d = device({ ok: true, data: {} });
    expect((await uiRevealPath("S1", { project: "api", path: join(root, "outside.txt") }, d.request, deps())).isError).toBe(true);
    expect((await uiRevealPath("S1", { project: "nope", path: "src" }, d.request, deps())).isError).toBe(true);
    expect(d.asked).toEqual([]);
    const refusing = device({ ok: false, error: "The Explorer does not list .git: PPM's file tree leaves it out." });
    const r = await uiRevealPath("S1", { project: "api", path: "src" }, refusing.request, deps());
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("does not list .git");
  });
});
