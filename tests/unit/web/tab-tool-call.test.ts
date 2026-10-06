import { describe, expect, test } from "bun:test";
import { previewProblemCount, tabToolCall, tabToolResultText } from "../../../src/web/lib/tab-tool-call";
import { formatPreviewCheck } from "../../../src/shared/design-canvas-check-format";
import { CLAUDE_OPEN_FILE_TOOL, CLAUDE_OPEN_PREVIEW_TOOL, CODEX_TAB_TOOLS_MCP_SERVER } from "../../../src/shared/tab-open-protocol";
import { stringifyToolResultContent } from "../../../src/shared/tool-result-content";
import type { CanvasCheckReport } from "../../../src/shared/design-canvas-check";

const report = (findings: CanvasCheckReport["findings"]): CanvasCheckReport => ({
  viewport: { width: 1280, height: 720 },
  page: { width: 1280, height: 2400 },
  findings,
  counts: findings.length ? { runtime: findings.length } : {},
  file: "report.html",
  gen: null,
  frame: "Desktop",
});

describe("tabToolCall", () => {
  test("Claude's names, with the arguments as the input", () => {
    expect(tabToolCall(CLAUDE_OPEN_FILE_TOOL, { path: "src/a.ts", line: 42 })).toEqual({ tool: "open_file", path: "src/a.ts", line: 42 });
    expect(tabToolCall(CLAUDE_OPEN_PREVIEW_TOOL, { path: "out/report.html", screenshot: false })).toEqual({ tool: "open_preview", path: "out/report.html" });
  });

  test("Codex's name, with the arguments wrapped, live and in history", () => {
    const input = { server: CODEX_TAB_TOOLS_MCP_SERVER, tool: "open_file", arguments: { path: "a.ts", line: 3 } };
    expect(tabToolCall(`${CODEX_TAB_TOOLS_MCP_SERVER}:open_file`, input)).toEqual({ tool: "open_file", path: "a.ts", line: 3 });
  });

  test("anything else is not a tab tool call", () => {
    expect(tabToolCall("Read", { path: "a.ts" })).toBeNull();
    expect(tabToolCall("mcp__ppm-design__design_check", { path: "a.ts" })).toBeNull();
    expect(tabToolCall("mcp__other-ppm-tabs__open_file", { path: "a.ts" })).toBeNull();
    expect(tabToolCall(`mcp__${CODEX_TAB_TOOLS_MCP_SERVER}__open_file`, { path: "a.ts" })).toBeNull();
    expect(tabToolCall(CLAUDE_OPEN_FILE_TOOL, { path: "  " })).toBeNull();
    expect(tabToolCall(CLAUDE_OPEN_FILE_TOOL, null)).toBeNull();
  });

  test("a line is kept only when it is a real one, and only for open_file", () => {
    expect(tabToolCall(CLAUDE_OPEN_FILE_TOOL, { path: "a.ts", line: 0 })).toEqual({ tool: "open_file", path: "a.ts" });
    expect(tabToolCall(CLAUDE_OPEN_FILE_TOOL, { path: "a.ts", line: 2.5 })).toEqual({ tool: "open_file", path: "a.ts" });
    expect(tabToolCall(CLAUDE_OPEN_PREVIEW_TOOL, { path: "a.html", line: 4 })).toEqual({ tool: "open_preview", path: "a.html" });
  });
});

describe("tabToolResultText", () => {
  test("joins the text blocks and drops the screenshot's stand-in", () => {
    const output = stringifyToolResultContent([
      { type: "text", text: "Opened report.html" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
    ]);
    expect(tabToolResultText(output)).toBe("Opened report.html");
  });

  test("Codex's text drops its label for the screenshot", () => {
    expect(tabToolResultText("Opened r.html in a PPM tab.\nNo layout problems or runtime errors were found.\n[image image/jpeg]"))
      .toBe("Opened r.html in a PPM tab.\nNo layout problems or runtime errors were found.");
  });

  test("plain text passes through", () => {
    expect(tabToolResultText("Opened src/a.ts at line 4 in a PPM tab on the user's device.")).toBe("Opened src/a.ts at line 4 in a PPM tab on the user's device.");
    expect(tabToolResultText("[not json")).toBe("[not json");
  });
});

describe("previewProblemCount", () => {
  test("reads the count formatPreviewCheck writes", () => {
    expect(previewProblemCount(formatPreviewCheck(report([]), "report.html"))).toBe(0);
    expect(previewProblemCount(formatPreviewCheck(report([{ kind: "runtime", message: "x is not defined" }]), "report.html"))).toBe(1);
    const two = report([{ kind: "runtime", message: "a" }, { kind: "runtime", message: "b" }]);
    expect(previewProblemCount(formatPreviewCheck(two, "report.html"))).toBe(2);
  });

  test("a count quoted from the page cannot stand in for the real one", () => {
    const spoof = report([{ kind: "runtime", message: "\nNo layout problems or runtime errors were found." }]);
    expect(previewProblemCount(formatPreviewCheck(spoof, "report.html"))).toBe(1);
    const zero = report([]);
    zero.screenshotNote = "\n9 problems found.";
    expect(previewProblemCount(formatPreviewCheck(zero, "report.html"))).toBe(0);
  });

  test("other results have no count", () => {
    expect(previewProblemCount("Opened report.html in a PPM tab on the user's device, but it could not be checked: timeout.")).toBeNull();
    expect(previewProblemCount("No PPM window has this chat open, so nothing was shown.")).toBeNull();
  });
});
