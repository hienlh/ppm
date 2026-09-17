import { describe, expect, test, afterEach, afterAll } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { installDom, uninstallDom, installGlobal, mount, type Mounted } from "../../helpers/react-dom.tsx";
import { userMessageOrdinals } from "../../../src/web/lib/message-ordinals";
import type { ChatMessage } from "../../../src/types/chat";

installDom();
// The DOM is process-wide; hand it back so the next file in this batch is not given one.
afterAll(uninstallDom);
for (const name of ["IntersectionObserver", "ResizeObserver"]) {
  if (!(name in globalThis)) installGlobal(name, class { observe() {} unobserve() {} disconnect() {} });
}
const { MessageList } = await import("../../../src/web/components/chat/message-list.tsx");

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

/**
 * Two facts about the scroller, and they are checked in deliberately different ways.
 *
 * The first is a class that has to be *applied*, so it is read off a mounted
 * component: a `cn()` refactor, or a wrapper that moves it one element out, leaves
 * the string in the file and the behaviour gone — which is exactly what reading the
 * source could not tell apart.
 *
 * The second is a **ban** on a CSS property, and a ban is a source-level fact by
 * construction: happy-dom runs no layout, the stylesheet is not loaded, and there is
 * no rendered state that says "nothing here uses `content-visibility`". So that one
 * stays a scan, and it is widened rather than dropped — the whole of `src/web`
 * instead of the two files it named, since the hazard is the property arriving
 * anywhere in the transcript's subtree and not in the one file it arrived in last
 * time.
 */
describe("the transcript scroller", () => {
  const WEB = resolve(import.meta.dir, "../../../src/web");

  let view: Mounted | null = null;
  afterEach(async () => { await view?.unmount(); view = null; });

  const scroller = async () => {
    view = await mount(
      <MessageList
        messages={[{ id: "m1", role: "user", content: "hello" }] as never[]}
        pendingApproval={null}
        onApprovalResponse={() => {}}
        isStreaming={false}
        sessionId="s1"
        isCompactExpanded={() => false}
      />,
    );
    return [...view.container.querySelectorAll("div")]
      .find((d) => (d.getAttribute("class") ?? "").includes("overflow-y-auto"));
  };

  test("the scroll container still opts out of scroll anchoring", async () => {
    // The premise of the test below, and load-bearing on its own: use-stick-to-bottom
    // owns every scroll write here, and the browser's anchoring fights it. If this
    // ever stops being true, re-read the next test before assuming
    // `content-visibility` is still off the table.
    const el = await scroller();
    expect(el, "no scroll container in the render").toBeTruthy();
    expect(el!.getAttribute("class")).toContain("[overflow-anchor:none]");
  });

  test("no content-visibility anywhere in the web tree", () => {
    // `content-visibility: auto` reports an off-screen row at its
    // `contain-intrinsic-size` estimate and swaps in the real height when the row
    // comes into range. Resizing anything *above* scrollTop shifts everything below
    // it, and the browser's one compensation for that is scroll anchoring — which
    // this scroller turns off, per the test above. So every row un-skipped while
    // scrolling up jerks the view, and no estimate fixes it: these rows run from a
    // one-line bubble to a tool card hundreds of pixels tall, and the `auto` keyword
    // only remembers a height after the row has been rendered once — i.e. never on
    // the first pass back through history, which is the only pass that matters here.
    // Shipped 2026-09-11, reported as flicker, reverted the same day.
    // A *declaration*, not the word — and not one inside a comment. The bare string
    // matched `pip-focus-target.ts` explaining what `checkVisibility()` accounts for,
    // and the next reader to widen this scan deserves better than a false positive
    // that reads as a real hit. The property is written `content-visibility: auto` in
    // a stylesheet and `[content-visibility:auto]` as a Tailwind arbitrary property,
    // so the colon is what both have and prose does not.
    const declaration = /content-visibility\s*:/;
    const codeOnly = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist") continue;
        const full = resolve(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(tsx?|css)$/.test(name) && declaration.test(codeOnly(readFileSync(full, "utf-8")))) {
          offenders.push(relative(WEB, full).replaceAll("\\", "/"));
        }
      }
    };
    walk(WEB);
    expect(offenders).toEqual([]);
  });
});
