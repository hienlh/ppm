/**
 * The top-sentinel loader, which nothing referenced at all.
 *
 * Three behaviours with real failure modes ride on it, and each fails quietly.
 * The observer is rebuilt whenever `loadMore` changes identity, so its
 * `rootMargin` decides how early the next segment is fetched; `compactLoadError`
 * disables the observer entirely until Retry, so one transient 500 would
 * otherwise stop auto-loading for the rest of the session; and a failed expand
 * used to be invisible — the fetch rejected, nothing caught it, and scrolling to
 * the top of a long chat simply did nothing forever.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { installDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();

/**
 * happy-dom ships no `IntersectionObserver`, and a real one would need real
 * layout anyway. This records who observes what and lets a test say "the top
 * came into range" directly, which is the event the component waits for.
 */
interface FakeIo {
  fire: (intersecting: boolean) => void;
  options: { rootMargin?: string };
  observed: unknown[];
  disconnected: boolean;
}
const observers: FakeIo[] = [];
(globalThis as Record<string, unknown>).IntersectionObserver = class {
  private self: FakeIo;
  constructor(cb: (e: Array<{ isIntersecting: boolean }>) => void, options: FakeIo["options"] = {}) {
    this.self = {
      fire: (intersecting) => cb([{ isIntersecting: intersecting }]),
      options, observed: [], disconnected: false,
    };
    observers.push(this.self);
  }
  observe(target: unknown) { this.self.observed.push(target); }
  disconnect() { this.self.disconnected = true; }
  unobserve() { /* not used */ }
};
(globalThis as Record<string, unknown>).ResizeObserver ??= class {
  observe() {} unobserve() {} disconnect() {}
};

/**
 * Observers still watching something — a rebuild disconnects the previous one.
 *
 * Assert on the *count*, never with `toEqual`: an entry holds the sentinel
 * element, so a deep comparison walks the document and its React fibers and
 * simply never returns — a failing expectation that reads as a hung suite.
 */
const live = () => observers.filter((o) => !o.disconnected && o.observed.length > 0);

const { MessageList } = await import("../../../src/web/components/chat/message-list.tsx");

const JSONL = "/home/u/.claude/projects/p/older.jsonl";

/**
 * The oldest message is a compact summary. `extractJsonlPath` is what makes it
 * one — it reads the transcript path out of the text Claude writes, so the
 * wording here is load-bearing rather than decorative.
 */
const messages = () => ([
  {
    id: "m0", role: "assistant",
    content: `This session is being continued from a previous conversation. If you need specific details from before compaction, read the full transcript at: ${JSONL}`,
  },
  { id: "m1", role: "user", content: "a question" },
  { id: "m2", role: "assistant", content: "an answer" },
] as never[]);

let view: Mounted | null = null;
beforeEach(() => { observers.length = 0; });
afterEach(async () => { await view?.unmount(); view = null; });

const render = async (over: Record<string, unknown> = {}) => {
  view = await mount(
    <MessageList
      messages={messages()}
      pendingApproval={null}
      onApprovalResponse={() => {}}
      isStreaming={false}
      sessionId="s1"
      isCompactExpanded={() => false}
      {...over}
    />,
  );
  return view.container;
};

const fire = async () => {
  const { act } = await import("react");
  await act(async () => { live()[0]!.fire(true); });
};

describe("the top sentinel", () => {
  it("is built once and not rebuilt by an unrelated re-render", async () => {
    // `findTopUnexpandedCompact` runs on every render and answers with a fresh
    // object literal, so depending on *that* made `loadMore` new every render
    // and this effect tore the observer down and built another one with it —
    // during streaming, every token batch. Measured before the fix: 1 at mount
    // and +1 per re-render against an unchanged message list.
    //
    // The props have to be hoisted for the measurement to mean anything: an
    // inline arrow is a new identity per render and would show the same count
    // for a reason that is the caller's, not this component's. Both real
    // callers pass `useCallback`s (`expandCompact`, `isCompactExpanded`).
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const onExpandCompact = async () => {};
    const isCompactExpanded = () => false;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const draw = async () => {
      await act(async () => {
        root.render(
          <MessageList
            messages={messages()}
            pendingApproval={null}
            onApprovalResponse={() => {}}
            isStreaming={false}
            sessionId="s1"
            isCompactExpanded={isCompactExpanded}
            onExpandCompact={onExpandCompact}
          />,
        );
      });
    };

    await draw();
    expect(observers).toHaveLength(1);
    await draw();
    await draw();
    await draw();
    expect(observers).toHaveLength(1);

    await act(async () => { root.unmount(); });
    container.remove();
  });

  it("watches nothing until there is older history to fetch", async () => {
    // No `onExpandCompact` means nothing can be expanded, so an observer here
    // would be watching for an event it could not answer.
    await render({ onExpandCompact: undefined });
    expect(live()).toHaveLength(0);
  });

  it("watches the top once a compact summary names a transcript", async () => {
    await render({ onExpandCompact: async () => {} });
    expect(live()).toHaveLength(1);
    // A screenful of lead time, so the next segment is usually there before the
    // reader reaches the end of this one.
    expect(live()[0]!.options.rootMargin).toBe("400px 0px 0px 0px");
  });

  it("fetches the segment the summary points at when the top comes into range", async () => {
    const asked: Array<[string, string]> = [];
    await render({ onExpandCompact: async (id: string, p: string) => { asked.push([id, p]); } });
    await fire();
    expect(asked).toEqual([["m0", JSONL]]);
  });

  it("does not start a second fetch while the first is still running", async () => {
    // The observer keeps firing as long as the sentinel is in range, and a
    // prepend moves it — so repeat intersections have to be free.
    let calls = 0;
    let release: (() => void) | null = null;
    await render({
      onExpandCompact: () => { calls++; return new Promise<void>((r) => { release = r; }); },
    });
    await fire();
    await fire();
    await fire();
    expect(calls).toBe(1);
    const { act } = await import("react");
    await act(async () => { release?.(); });
  });

  it("shows a failed expand instead of silently doing nothing", async () => {
    const container = await render({
      onExpandCompact: async () => { throw new Error("boom"); },
    });
    await fire();
    expect(container.textContent).toContain("Could not load previous conversation: boom");
  });

  it("stops observing after a failure, so it cannot retry into the same error", async () => {
    let calls = 0;
    await render({
      onExpandCompact: async () => { calls++; throw new Error("boom"); },
    });
    await fire();
    expect(live()).toHaveLength(0);
    expect(calls).toBe(1);
  });

  it("Retry clears the error, fetches again, and puts the observer back", async () => {
    let calls = 0;
    const container = await render({
      onExpandCompact: async () => { calls++; if (calls === 1) throw new Error("boom"); },
    });
    await fire();

    const retry = [...container.querySelectorAll("button")]
      .find((b) => b.textContent?.includes("Retry"));
    expect(retry).toBeTruthy();
    await click(retry ?? null);

    expect(calls).toBe(2);
    expect(container.textContent).not.toContain("Could not load previous conversation");
    expect(live()).toHaveLength(1);
  });
});
