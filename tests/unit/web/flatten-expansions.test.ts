import { describe, expect, test } from "bun:test";
import { flattenWithExpansions, prefixPreCompactIds } from "../../../src/web/lib/flatten-expansions";
import type { ChatMessage } from "../../../src/types/chat";

function msg(id: string, role: ChatMessage["role"] = "user", content = ""): ChatMessage {
  return { id, role, content, timestamp: "2026-04-21T00:00:00Z" };
}

describe("prefixPreCompactIds", () => {
  test("adds deterministic prefix per jsonlPath", () => {
    const a = prefixPreCompactIds([msg("1"), msg("2")], "/a/b.jsonl");
    expect(a[0].id).toMatch(/^pc-[a-z0-9]+-1$/);
    expect(a[1].id).toMatch(/^pc-[a-z0-9]+-2$/);
    expect(a[0].id).not.toBe("1");
  });

  test("different paths produce different prefixes", () => {
    const a = prefixPreCompactIds([msg("x")], "/path/a.jsonl");
    const b = prefixPreCompactIds([msg("x")], "/path/b.jsonl");
    expect(a[0].id).not.toBe(b[0].id);
  });

  test("same path produces same prefix (stable)", () => {
    const a = prefixPreCompactIds([msg("x")], "/same.jsonl");
    const b = prefixPreCompactIds([msg("x")], "/same.jsonl");
    expect(a[0].id).toBe(b[0].id);
  });

  test("preserves non-id fields", () => {
    const out = prefixPreCompactIds([msg("1", "assistant", "hello")], "/p.jsonl");
    expect(out[0].role).toBe("assistant");
    expect(out[0].content).toBe("hello");
  });

  test("passes through messages without id", () => {
    const out = prefixPreCompactIds([{ ...msg(""), id: "" } as ChatMessage], "/p.jsonl");
    expect(out[0].id).toBe(""); // no prefix when id is falsy
  });
});

describe("flattenWithExpansions", () => {
  test("returns same reference when expansions empty", () => {
    const msgs = [msg("a"), msg("b")];
    const out = flattenWithExpansions(msgs, new Map());
    expect(out).toBe(msgs);
  });

  test("prepends single expansion before matching compact message", () => {
    const msgs = [msg("compact-1"), msg("b")];
    const pre = [msg("pc-pre1"), msg("pc-pre2")];
    const exp = new Map([["compact-1", pre]]);
    const out = flattenWithExpansions(msgs, exp);
    expect(out.map((m) => m.id)).toEqual(["pc-pre1", "pc-pre2", "compact-1", "b"]);
  });

  test("handles multiple expansions interleaved", () => {
    const msgs = [msg("c1"), msg("mid"), msg("c2"), msg("tail")];
    const exp = new Map([
      ["c1", [msg("pre1a")]],
      ["c2", [msg("pre2a"), msg("pre2b")]],
    ]);
    const out = flattenWithExpansions(msgs, exp);
    expect(out.map((m) => m.id)).toEqual(["pre1a", "c1", "mid", "pre2a", "pre2b", "c2", "tail"]);
  });

  test("skips expansion entries with empty array", () => {
    const msgs = [msg("c1")];
    const exp = new Map([["c1", [] as ChatMessage[]]]);
    const out = flattenWithExpansions(msgs, exp);
    expect(out.map((m) => m.id)).toEqual(["c1"]);
  });

  test("ignores expansions for non-existent compact ids", () => {
    const msgs = [msg("a")];
    const exp = new Map([["missing", [msg("x")]]]);
    const out = flattenWithExpansions(msgs, exp);
    expect(out.map((m) => m.id)).toEqual(["a"]);
  });
});

describe("flattenWithExpansions — chained compaction segments", () => {
  test("an expansion nested inside another expansion is rendered", () => {
    // Each expansion now arrives as one compaction segment headed by the
    // summary before it, so expanding that one keys its messages off an id
    // that only exists *inside* another expansion. A flat pass would fetch
    // them and render nothing — indistinguishable from the load failing.
    const messages = [msg("summary-2"), msg("live-1")];
    const expansions = new Map<string, ChatMessage[]>([
      ["summary-2", [msg("summary-1"), msg("seg2-a")]],
      ["summary-1", [msg("oldest"), msg("seg1-a")]],
    ]);

    const out = flattenWithExpansions(messages, expansions).map((m) => m.id);
    expect(out).toEqual(["oldest", "seg1-a", "summary-1", "seg2-a", "summary-2", "live-1"]);
  });

  test("three levels deep still resolve in order", () => {
    const messages = [msg("s3")];
    const expansions = new Map<string, ChatMessage[]>([
      ["s3", [msg("s2")]],
      ["s2", [msg("s1")]],
      ["s1", [msg("root")]],
    ]);
    expect(flattenWithExpansions(messages, expansions).map((m) => m.id))
      .toEqual(["root", "s1", "s2", "s3"]);
  });

  test("a self-referencing expansion cannot spin the walk", () => {
    const messages = [msg("a")];
    const expansions = new Map<string, ChatMessage[]>([["a", [msg("a")]]]);
    expect(() => flattenWithExpansions(messages, expansions)).not.toThrow();
  });
});
