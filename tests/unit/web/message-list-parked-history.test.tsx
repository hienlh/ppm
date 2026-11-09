/**
 * The history loader of a transcript first observed while its tab was parked out of sight.
 *
 * Parked at 0×0 a transcript's top reads as in range whatever its length, so the loader ignores
 * what it is told there. But an `IntersectionObserver` reports changes only: once the tab is
 * shown, a top that was in range all along is never reported again. A compacted chat whose tail
 * fit the view then had no way to reach what was above it, since the compaction divider is not
 * a control. On a phone it takes no more than a history load finishing while another panel's
 * tab is in front.
 *
 * Both observers here behave the way Chromium's do: an entry on `observe()`, then one per change.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { installDom, uninstallDom, installGlobal, mount, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

/** What the next entry will say. */
let topInRange = true;
/** The scroller the loader observes the top within. */
let root: HTMLElement | null = null;
installGlobal("IntersectionObserver", class {
  private watching = 0;
  constructor(private readonly cb: (e: Array<{ isIntersecting: boolean }>) => void, options: { root?: HTMLElement } = {}) {
    root = options.root ?? null;
  }
  observe() {
    const at = ++this.watching;
    queueMicrotask(() => { if (this.watching === at) this.cb([{ isIntersecting: topInRange }]); });
  }
  unobserve() { this.watching++; }
  disconnect() { this.watching++; }
});

const resizeObservers: Array<{ cb: ResizeObserverCallback; targets: Element[] }> = [];
installGlobal("ResizeObserver", class {
  private readonly self: { cb: ResizeObserverCallback; targets: Element[] };
  constructor(cb: ResizeObserverCallback) {
    this.self = { cb, targets: [] };
    resizeObservers.push(this.self);
  }
  observe(target: Element) { this.self.targets.push(target); }
  unobserve(target: Element) { this.self.targets = this.self.targets.filter((t) => t !== target); }
  disconnect() { this.self.targets = []; }
});

const { MessageList } = await import("../../../src/web/components/chat/message-list.tsx");

/** The oldest message names a transcript, which makes it a compact summary with history above it. */
const messages = () => ([
  {
    id: "m0", role: "assistant",
    content: "This session is being continued from a previous conversation. If you need specific details from before compaction, read the full transcript at: /home/u/.claude/projects/p/older.jsonl",
  },
  { id: "m1", role: "user", content: "a question" },
  { id: "m2", role: "assistant", content: "an answer" },
] as never[]);

const settle = () => new Promise((r) => setTimeout(r, 10));

let view: Mounted | null = null;
beforeEach(() => {
  topInRange = true;
  root = null;
  resizeObservers.length = 0;
});
afterEach(async () => { await view?.unmount(); view = null; });

/** Mounted parked: happy-dom lays nothing out, so the scroller has no height. */
const renderParked = async (asked: string[]) => {
  const { act } = await import("react");
  view = await mount(
    <MessageList
      messages={messages()}
      pendingApproval={null}
      onApprovalResponse={() => {}}
      isStreaming={false}
      sessionId="s1"
      isCompactExpanded={() => false}
      // A load puts older messages above, and the top out of range with them.
      onExpandCompact={async (id: string) => { asked.push(id); topInRange = false; }}
    />,
  );
  await act(settle);
};

/** Moved into a panel slot: the scroller gets a height, and every ResizeObserver hears of it. */
const show = async (height = 600) => {
  const { act } = await import("react");
  Object.defineProperty(root!, "clientHeight", { configurable: true, value: height });
  await act(async () => {
    for (const { cb, targets } of [...resizeObservers]) {
      for (const target of targets) {
        const contentRect = { width: 800, height: target === root ? height : 0 };
        cb([{ target, contentRect } as unknown as ResizeObserverEntry], {} as ResizeObserver);
      }
    }
    await settle();
  });
};

describe("a transcript first observed while parked", () => {
  it("loads what is above it once shown, when its top is still in range", async () => {
    const asked: string[] = [];
    await renderParked(asked);
    expect(root).toBeTruthy();
    expect(asked).toEqual([]);

    await show();
    expect(asked).toEqual(["m0"]);
  });

  it("loads nothing once shown away from its top", async () => {
    // A tall chat comes back at the reader's place, which `ReparentingTab` restores before the
    // transcript is laid out: what was in range while parked is not any more.
    const asked: string[] = [];
    await renderParked(asked);
    topInRange = false;
    await show();
    expect(asked).toEqual([]);
  });
});
