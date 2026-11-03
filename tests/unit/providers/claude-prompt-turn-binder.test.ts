import { describe, expect, it } from "bun:test";
import { PromptTurnBinder } from "../../../src/providers/claude-prompt-turn-binder.ts";
import { buildToolHooks } from "../../../src/providers/claude-agent-sdk-query-options.ts";
import { withSharedContext } from "../../../src/shared/provider-context.ts";

const P = (n: number) => `33333333-0000-4000-8000-00000000000${n}`;

describe("PromptTurnBinder", () => {
  it("binds each submitted prompt to the push it came from, in the order the CLI submits them", () => {
    const b = new PromptTurnBinder();
    b.register("s", "first", "c1");
    b.register("s", "queued behind it", "c2");
    expect(b.bind("s", P(1), "first")).toEqual({ turnId: P(1), clientMessageId: "c1" });
    expect(b.bind("s", P(2), "queued behind it")).toEqual({ turnId: P(2), clientMessageId: "c2" });
  });

  it("a queued message gets its own turn even when a later one is submitted first", () => {
    const b = new PromptTurnBinder();
    b.register("s", "later", "c1");
    b.register("s", "now", "c2");
    expect(b.bind("s", P(1), "now")).toEqual({ turnId: P(1), clientMessageId: "c2" });
    expect(b.bind("s", P(2), "later")).toEqual({ turnId: P(2), clientMessageId: "c1" });
  });

  it("a prompt no browser sent — a notification, the CLI's continue — binds nothing", () => {
    const b = new PromptTurnBinder();
    b.register("s", "mine", "c1");
    expect(b.bind("s", P(1), "<task-notification>done</task-notification>")).toBeNull();
    expect(b.bind("s", P(2), "Continue from where you left off.")).toBeNull();
    expect(b.bind("s", P(3), "mine")).toEqual({ turnId: P(3), clientMessageId: "c1" });
  });

  it("matches across the shared context PPM prepends, and a prompt the CLI appended to", () => {
    const b = new PromptTurnBinder();
    b.register("s", withSharedContext("fix it", "rules"), "c1");
    b.register("s", "look at this", "c2");
    expect(b.bind("s", P(1), withSharedContext("fix it", "rules"))?.clientMessageId).toBe("c1");
    expect(b.bind("s", P(2), "look at this\n<pasted_content>x</pasted_content>")?.clientMessageId).toBe("c2");
  });

  it("a re-sent prompt binds to the same browser message; the stale push goes with it", () => {
    const b = new PromptTurnBinder();
    b.register("s", "do it", "c1");
    b.register("s", "do it", "c1");
    expect(b.bind("s", P(2), "do it")).toEqual({ turnId: P(2), clientMessageId: "c1" });
    expect(b.bind("s", P(3), "do it")).toBeNull();
  });

  it("the same words sent twice are two messages, each with its own turn", () => {
    const b = new PromptTurnBinder();
    b.register("s", "again", "c1");
    b.register("s", "again", "c2");
    expect(b.bind("s", P(1), "again")?.clientMessageId).toBe("c1");
    expect(b.bind("s", P(2), "again")?.clientMessageId).toBe("c2");
  });

  it("an id that is not a turn id is ignored, and sessions are kept apart", () => {
    const b = new PromptTurnBinder();
    b.register("s", "hi", "c1");
    expect(b.bind("s", "bad id!", "hi")).toBeNull();
    expect(b.bind("other", P(1), "hi")).toBeNull();
    expect(b.bind("s", P(1), "hi")?.clientMessageId).toBe("c1");
  });
});

describe("buildToolHooks", () => {
  it("adds the prompt hook when given one, in every permission mode", () => {
    const noop = async () => ({});
    for (const isBypass of [true, false]) {
      const hooks = buildToolHooks({ isBypass, preToolUse: noop, fileWrite: noop, shellCommand: noop, userPromptSubmit: noop }) as Record<string, Array<{ hooks: unknown[] }>>;
      expect(hooks.UserPromptSubmit?.[0]?.hooks).toEqual([noop]);
    }
    expect("UserPromptSubmit" in buildToolHooks({ isBypass: true, preToolUse: noop, fileWrite: noop, shellCommand: noop })).toBe(false);
  });
});
