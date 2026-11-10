import { describe, expect, it } from "bun:test";
import { mapCodexEvent } from "../../../src/providers/codex-app-server/codex-event-mapper.ts";
import { parseRolloutJsonl } from "../../../src/providers/codex-app-server/codex-history.ts";

describe("Codex image views", () => {
  it("preserves native attachments without duplicating PPM markers or exposing shared context", () => {
    const record = (content: unknown[]) => JSON.stringify({ type: "event_msg", payload: {
      type: "item_completed", item: { type: "UserMessage", content },
    } }) + "\n";
    const native = parseRolloutJsonl(record([{ type: "local_image", path: "file:///tmp/picture%20one.png" }]));
    expect(native[0]!.content).toBe("[Attached image (contents included in this message): /tmp/picture one.png]");
    const marker = "[Attached image (contents included in this message): /tmp/picture one.png]";
    const uploaded = parseRolloutJsonl(record([
      { type: "local_image", path: "/tmp/picture one.png" },
      { type: "text", text: `<ppm-shared-context>\nprivate instructions\n</ppm-shared-context>\n\n${marker}\n\nLook at this` },
    ]));
    expect(uploaded[0]!.content).toBe(`${marker}\n\nLook at this`);
  });
  for (const [path, expected] of [
    ["/tmp/image.png", "/tmp/image.png"],
    ["file:///tmp/screenshot%20one.png", "/tmp/screenshot one.png"],
    ["file:///C:/Users/PC/screenshot%20one.png", "C:/Users/PC/screenshot one.png"],
  ]) {
    it(`makes the live image view previewable: ${path}`, () => {
      const item = { type: "imageView", id: "image-1", path };
      expect(mapCodexEvent({ method: "item/started", params: { item } }, "thread")).toEqual([
        { type: "tool_use", tool: "Read", input: { file_path: expected }, toolUseId: "image-1" },
      ]);
      expect(mapCodexEvent({ method: "item/completed", params: { item } }, "thread")).toEqual([
        { type: "tool_result", output: expected, isError: false, toolUseId: "image-1" },
      ]);
    });

    it(`retains the preview when reopening history: ${path}`, () => {
      const text = JSON.stringify({ type: "event_msg", payload: {
        type: "item_completed", item: { type: "ImageView", id: "image-1", path },
      } }) + "\n";
      const messages = parseRolloutJsonl(text);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.events).toEqual([
        { type: "tool_use", tool: "Read", input: { file_path: expected }, toolUseId: "image-1" },
        { type: "tool_result", output: expected, isError: false, toolUseId: "image-1" },
      ]);
    });
  }
});
