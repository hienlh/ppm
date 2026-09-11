import { describe, it, expect } from "bun:test";
import { mapCodexEvent } from "../../../src/providers/codex-app-server/codex-event-mapper.ts";

const SID = "thread-1";

/** Stand-in for the megabyte of base64 the real item carries in `result`. */
const BASE64 = "iVBORw0KGgoAAAANSUhE" + "A".repeat(4096);
const SAVED = "C:\\Users\\PC\\.ppm\\codex-accounts\\acct-1\\generated_images\\th-1\\call_abc.png";

const ITEM = {
  type: "imageGeneration",
  id: "call_abc",
  status: "completed",
  revisedPrompt: "Use case: product-mockup\nSubject: one simple red cube",
  result: BASE64,
  transparentBackground: false,
  failure: null,
  savedPath: SAVED,
};

describe("imageGeneration → tool_use", () => {
  it("maps to ImageGen carrying the saved path as file_path", () => {
    const out = mapCodexEvent({ method: "item/started", params: { item: ITEM } }, SID);
    expect(out).toEqual([{
      type: "tool_use",
      tool: "ImageGen",
      input: {
        file_path: SAVED,
        prompt: "Use case: product-mockup\nSubject: one simple red cube",
        transparentBackground: false,
      },
      toolUseId: "call_abc",
    }]);
  });

  it("never carries the base64 payload into the event", () => {
    // The event is buffered in RAM, appended to the session JSONL, and broadcast
    // to every client — one megabyte per image on all three if this regresses.
    const out = mapCodexEvent({ method: "item/started", params: { item: ITEM } }, SID);
    expect(JSON.stringify(out)).not.toContain("iVBORw0KGgo");
    // Generous ceiling: the whole event must stay far under the payload's size.
    expect(JSON.stringify(out).length).toBeLessThan(1000);
  });

  it("survives an item with no savedPath", () => {
    const out = mapCodexEvent({
      method: "item/started",
      params: { item: { type: "imageGeneration", id: "c2", result: BASE64 } },
    }, SID);
    expect((out[0] as { input: Record<string, unknown> }).input.file_path).toBeNull();
  });
});

describe("imageGeneration → tool_result", () => {
  it("reports the saved path, not the payload", () => {
    const out = mapCodexEvent({ method: "item/completed", params: { item: ITEM } }, SID);
    const result = out.find((e) => e.type === "tool_result") as { output: string; isError: boolean };
    expect(result.output).toBe(SAVED);
    expect(result.isError).toBe(false);
    expect(JSON.stringify(out)).not.toContain("iVBORw0KGgo");
  });

  it("marks a failed generation as an error and shows the reason", () => {
    const failed = { ...ITEM, status: "failed", failure: "content_policy_violation", savedPath: null };
    const out = mapCodexEvent({ method: "item/completed", params: { item: failed } }, SID);
    const result = out.find((e) => e.type === "tool_result") as { output: string; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.output).toContain("content_policy_violation");
  });
});

describe("imageGeneration announced before the picture exists", () => {
  // What the app-server really sends first: the call has begun, so there is no
  // file to preview and no revised prompt to read yet.
  const STARTED = { type: "imageGeneration", id: "call_abc", status: "in_progress" };

  it("starts with nothing to show", () => {
    const out = mapCodexEvent({ method: "item/started", params: { item: STARTED } }, SID);
    const use = out[0] as { input: Record<string, unknown> };
    expect(use.input.file_path).toBeNull();
    expect(use.input.prompt).toBeNull();
  });

  it("re-emits the call once it has a file, so the card can show the picture", () => {
    const out = mapCodexEvent({ method: "item/completed", params: { item: ITEM } }, SID);
    const use = out.find((e) => e.type === "tool_use") as { input: Record<string, unknown>; toolUseId: string };
    expect(use).toBeDefined();
    expect(use.input.file_path).toBe(SAVED);
    expect(use.input.prompt).toContain("product-mockup");
  });

  it("keys the re-emitted call to the same id, so it replaces rather than duplicates", () => {
    const started = mapCodexEvent({ method: "item/started", params: { item: STARTED } }, SID);
    const completed = mapCodexEvent({ method: "item/completed", params: { item: ITEM } }, SID);
    const first = (started[0] as { toolUseId: string }).toolUseId;
    const again = (completed.find((e) => e.type === "tool_use") as { toolUseId: string }).toolUseId;
    expect(again).toBe(first);
  });

  it("still refuses to carry the payload on the second pass", () => {
    const out = mapCodexEvent({ method: "item/completed", params: { item: ITEM } }, SID);
    expect(JSON.stringify(out)).not.toContain("iVBORw0KGgo");
  });

  it("does not re-emit calls for other tools, which describe themselves up front", () => {
    const out = mapCodexEvent({
      method: "item/completed",
      params: { item: { type: "commandExecution", id: "c9", command: "ls", exitCode: 0 } },
    }, SID);
    expect(out.filter((e) => e.type === "tool_use")).toHaveLength(0);
  });
});
