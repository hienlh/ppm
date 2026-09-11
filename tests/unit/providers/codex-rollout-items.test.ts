import { describe, it, expect } from "bun:test";
import { mapRolloutItem } from "../../../src/providers/codex-app-server/codex-rollout-items.ts";
import { parseRolloutJsonl } from "../../../src/providers/codex-app-server/codex-history.ts";

/**
 * Shapes taken verbatim from a real rollout written by codex 0.154: PascalCase
 * item types, snake_case fields, a `command` array, and image generation
 * arriving as a generic `Extension`.
 */

describe("mapRolloutItem", () => {
  it("reads a user message", () => {
    expect(mapRolloutItem({
      type: "UserMessage",
      id: "u1",
      content: [{ type: "text", text: "tạo ảnh giúp tôi" }],
    })).toEqual({ kind: "user", text: "tạo ảnh giúp tôi" });
  });

  it("reads an assistant message despite the capitalised content type", () => {
    expect(mapRolloutItem({
      type: "AgentMessage",
      id: "m1",
      content: [{ type: "Text", text: "Xong rồi" }],
    })).toEqual({ kind: "assistant", text: "Xong rồi" });
  });

  it("drops reasoning rather than showing the model's private notes", () => {
    expect(mapRolloutItem({ type: "Reasoning", id: "r1", summary_text: [], raw_content: [] }))
      .toEqual({ kind: "ignore" });
  });

  it("drops an empty message instead of emitting a blank turn", () => {
    expect(mapRolloutItem({ type: "AgentMessage", content: [] })).toEqual({ kind: "ignore" });
  });

  describe("CommandExecution", () => {
    const item = {
      type: "CommandExecution",
      id: "call_1",
      command: ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-Command", "Get-Content README.md"],
      parsed_cmd: [{ type: "unknown", cmd: "Get-Content README.md" }],
      cwd: "file:///C:/Users/PC/ppm",
      aggregated_output: "# PPM",
      exit_code: 0,
    };

    it("shows the unwrapped script, not the interpreter wrapper", () => {
      const mapped = mapRolloutItem(item);
      expect(mapped.kind).toBe("events");
      const use = (mapped as any).events[0];
      expect(use.input.command).toBe("Get-Content README.md");
      expect(JSON.stringify(use.input)).not.toContain("powershell.exe");
    });

    it("still detects the shell from the wrapper", () => {
      expect((mapRolloutItem(item) as any).events[0].tool).toBe("PowerShell");
    });

    it("turns the file:// cwd back into a path", () => {
      expect((mapRolloutItem(item) as any).events[0].input.cwd).toBe("C:/Users/PC/ppm");
    });

    it("carries the output and a clean exit", () => {
      const result = (mapRolloutItem(item) as any).events[1];
      expect(result.output).toBe("# PPM");
      expect(result.isError).toBe(false);
    });

    it("marks a non-zero exit as an error", () => {
      const failed = { ...item, exit_code: 1, aggregated_output: "boom" };
      expect((mapRolloutItem(failed) as any).events[1].isError).toBe(true);
    });

    it("falls back to the raw command when there is no parsed form", () => {
      const bare = { type: "CommandExecution", id: "c", command: ["ls", "-la"] };
      expect((mapRolloutItem(bare) as any).events[0].input.command).toBe("ls -la");
    });
  });

  describe("Extension → image generation", () => {
    const item = {
      type: "Extension",
      kind: "image_gen.generation",
      id: "call_img",
      status: "completed",
      revisedPrompt: "a single red cube",
      result: "iVBORw0KGgoAAAANSUhE" + "A".repeat(2000),
      transparentBackground: false,
      failure: null,
      savedPath: "C:\\Users\\PC\\.ppm\\codex-accounts\\acct\\generated_images\\t\\call_img.png",
    };

    it("becomes an ImageGen card pointing at the saved file", () => {
      const use = (mapRolloutItem(item) as any).events[0];
      expect(use.tool).toBe("ImageGen");
      expect(use.input.file_path).toBe(item.savedPath);
      expect(use.input.prompt).toBe("a single red cube");
    });

    it("never carries the base64 payload", () => {
      expect(JSON.stringify(mapRolloutItem(item))).not.toContain("iVBORw0KGgo");
    });

    it("reports a failed generation as an error", () => {
      const failed = { ...item, failure: "content_policy", savedPath: null };
      const result = (mapRolloutItem(failed) as any).events[1];
      expect(result.isError).toBe(true);
      expect(result.output).toContain("content_policy");
    });

    it("shows an unknown extension rather than dropping it, minus any payload", () => {
      const other = { type: "Extension", kind: "something.else", id: "x", result: "iVBORw0KGgoAAA" };
      const use = (mapRolloutItem(other) as any).events[0];
      expect(use.tool).toBe("Extension");
      expect(JSON.stringify(use)).not.toContain("iVBORw0KGgo");
    });
  });

  it("shows an unknown item type rather than dropping it", () => {
    const use = (mapRolloutItem({ type: "SomethingNew", id: "z", detail: 1 }) as any).events[0];
    expect(use.tool).toBe("SomethingNew");
  });
});

describe("parseRolloutJsonl with item_completed records", () => {
  const line = (payload: unknown, type = "event_msg") =>
    JSON.stringify({ type, timestamp: "2026-09-10T18:20:17.000Z", payload });

  const rollout = [
    line({ type: "item_completed", item: { type: "UserMessage", id: "u", content: [{ type: "text", text: "hi" }] } }),
    line({ type: "item_completed", item: { type: "Reasoning", id: "r" } }),
    line({ type: "item_completed", item: { type: "CommandExecution", id: "c", command: ["ls"], parsed_cmd: [{ cmd: "ls" }], exit_code: 0, aggregated_output: "out" } }),
    line({ type: "item_completed", item: { type: "AgentMessage", id: "a", content: [{ type: "Text", text: "done" }] } }),
  ].join("\n") + "\n";

  it("reconstructs the conversation", () => {
    const msgs = parseRolloutJsonl(rollout);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[0]!.content).toBe("hi");
    expect(msgs[1]!.content).toBe("done");
  });

  it("nests the tool call into the assistant turn", () => {
    const events = (parseRolloutJsonl(rollout)[1] as any).events ?? [];
    expect(events.filter((e: any) => e.type === "tool_use").map((e: any) => e.tool)).toEqual(["Bash"]);
  });

  it("ignores the response_item copies of the same calls", () => {
    // Both record kinds describe one call. Counting both rendered every command
    // twice, and the response_item copy of an image carries its whole payload.
    const withDuplicate = rollout + line(
      { type: "function_call", name: "exec_command", call_id: "c", arguments: "{}" },
      "response_item",
    ) + "\n";
    const events = (parseRolloutJsonl(withDuplicate)[1] as any).events ?? [];
    expect(events.filter((e: any) => e.type === "tool_use")).toHaveLength(1);
  });

  it("still reads an older rollout that has no item events", () => {
    const legacy = [
      line({ type: "user_message", message: "hi" }),
      line({ type: "agent_message", message: "hello" }),
    ].join("\n") + "\n";
    expect(parseRolloutJsonl(legacy).map((m) => m.content)).toEqual(["hi", "hello"]);
  });
});
