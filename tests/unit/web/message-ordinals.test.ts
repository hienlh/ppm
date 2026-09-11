import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { userMessageOrdinals } from "../../../src/web/lib/message-ordinals";
import type { ChatMessage } from "../../../src/types/chat";

const roles = (...rs: ChatMessage["role"][]) => rs.map((role) => ({ role }));

describe("userMessageOrdinals", () => {
  test("numbers user messages 1..n and leaves the rest at 0", () => {
    expect(userMessageOrdinals(roles("user", "assistant", "assistant", "user", "system", "user")))
      .toEqual([1, 0, 0, 2, 0, 3]);
  });

  test("empty list", () => {
    expect(userMessageOrdinals([])).toEqual([]);
  });

  test("matches the prefix-scan it replaced", () => {
    // The O(n²) form this was rewritten from, kept as the oracle: a version
    // group is keyed on this number, so an off-by-one silently re-anchors forks.
    const list = Array.from({ length: 500 }, (_, i) => ({
      role: (i % 3 === 0 ? "user" : i % 3 === 1 ? "assistant" : "system") as ChatMessage["role"],
    }));
    const oracle = list.map((m, i) =>
      m.role === "user"
        ? list.slice(0, i + 1).reduce((n, x) => n + (x.role === "user" ? 1 : 0), 0)
        : 0,
    );
    expect(userMessageOrdinals(list)).toEqual(oracle);
  });
});

describe("transcript row rendering", () => {
  const css = readFileSync(
    resolve(import.meta.dir, "../../../src/web/styles/globals.css"),
    "utf-8",
  );
  const list = readFileSync(
    resolve(import.meta.dir, "../../../src/web/components/chat/message-list.tsx"),
    "utf-8",
  );

  test("the scroll container still opts out of scroll anchoring", () => {
    // The premise of the test below. If this ever stops being true, re-read it
    // before assuming `content-visibility` is still off the table.
    expect(list).toContain("[overflow-anchor:none]");
  });

  test("no content-visibility on transcript rows", () => {
    // `content-visibility: auto` reports an off-screen row at its
    // `contain-intrinsic-size` estimate and swaps in the real height when the
    // row comes into range. Resizing anything *above* scrollTop shifts
    // everything below it, and the browser's one compensation for that is
    // scroll anchoring — which this scroller turns off, because
    // use-stick-to-bottom owns scroll writes. So every row un-skipped while
    // scrolling up jerks the view, and no estimate fixes it: these rows run
    // from a one-line bubble to a tool card hundreds of pixels tall, and the
    // `auto` keyword only remembers a height after the row has been rendered
    // once — i.e. never on the first pass back through history, which is the
    // only pass that matters here. Shipped 2026-09-11, reported as flicker,
    // reverted the same day.
    expect(css).not.toContain("content-visibility");
    expect(list).not.toContain("content-visibility");
  });
});
