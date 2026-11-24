/**
 * TEMPORARY DIAGNOSTIC — remove once the cause of the chat's unexplained upward jumps is known.
 * Removing it is: delete this file, its test, the `watchScrollJumps` effect in `message-list.tsx`
 * and the `noteScrollJumpEvent` line in `use-chat.ts`. Or set `SCROLL_JUMP_LOG_ENABLED` to false.
 *
 * The chat's scroller sometimes moves up on its own around the end of a turn, and no test could
 * make it happen. This records, on the real installs where it does happen, every upward move of
 * more than `MIN_DROP_PX` that no wheel, touch, key or scrollbar press asked for in the
 * `INTENT_WINDOW_MS` before it, with what the list looked like around it.
 *
 * Numbers only: offsets, heights, counts, event types, flags and a call stack. Never message text,
 * never a card's words. Each record is one `console.warn` line starting `[scroll-jump]`, which
 * `trace-client.ts` already ships to the session trace (a `console_warn` row with `source =
 * 'browser'`), so nothing on the server changes and the rows are read with one query.
 */

export const SCROLL_JUMP_LOG_ENABLED = true;

/** An upward move smaller than this is not what was reported (a clamp of a few pixels). */
export const MIN_DROP_PX = 40;
/** A move this soon after the reader's own wheel, touch, key or scrollbar press is theirs. */
export const INTENT_WINDOW_MS = 300;
/** Scroll events this close together are one fling: the first being the reader's makes all of them. */
export const FLING_GAP_MS = 50;
/**
 * A write to the offset this close before the move is taken to be what made it. The scroll event a
 * write causes comes with the next frame, which a busy main thread (a long render) delays well
 * past one frame's length.
 */
export const WRITE_WINDOW_MS = 300;
/** Records per minute per page, so a tab stuck in a loop costs a counter and not the trace. */
export const MAX_RECORDS_PER_MINUTE = 20;
/** Frames of a stack kept: enough to name the caller, short enough to stay under one entry. */
const STACK_FRAMES = 8;
const STACK_LINE_CHARS = 160;

/** What the list knows about itself at the moment of a move. All numbers, flags and short ids. */
export interface ScrollJumpContext {
  surface: "assistant" | "chat";
  sessionId: string | null;
  phase: string | null;
  isStreaming: boolean;
  /** use-stick-to-bottom's view: following the bottom. */
  isAtBottom: boolean;
  rows: number;
  /** The last row's id reduced to its kind (`streaming`, `final`, `user`, `uuid`…). */
  lastRowKind: string | null;
  hiddenRows: number;
  timelineItems: number;
  pinned: boolean;
  historyWindow: boolean;
}

export interface ScrollJumpRecord {
  at: number;
  drop: number;
  top: [number, number];
  scrollHeight: [number, number];
  clientHeight: [number, number];
  /**
   * Distance from the bottom before and after. A move that ends at the bottom is the browser
   * fitting the offset to content that got shorter (nothing the reader sees jump); one that ends
   * far from it is the jump that was reported.
   */
  distFromBottom: [number, number];
  msSinceIntent: number | null;
  msSinceLayoutChange: number | null;
  /** Rows and last row kind at the previous commit, and how long ago it was. */
  before: { rows: number; lastRowKind: string | null; hiddenRows: number; timelineItems: number; msAgo: number } | null;
  after: ScrollJumpContext;
  /** Chat socket messages this tab received in the last few seconds, newest last. */
  recentEvents: Array<{ type: string; msAgo: number }>;
  /** A write to the offset by code just before the move: what it asked for, and from where. */
  write: { kind: string; asked: string; msAgo: number; stack: string[] } | null;
  device: { width: number; height: number; coarse: boolean };
  /**
   * How far this browser's clock runs ahead of the server's (negative: behind), null until known.
   * The Assistant places cards (server time) among messages this browser stamped itself, so a
   * clock ahead of the server's puts a card made during an answer above the message just sent.
   */
  clockSkewMs: number | null;
}

// ------------------------------------------------------------------ the browser's clock

let clockSkewMs: number | null = null;
let clockAsked = false;

/** Measures, once per page, the browser's clock against the server's `Date` header (whole seconds). */
function measureClockSkew(): void {
  if (clockAsked || typeof fetch === "undefined") return;
  clockAsked = true;
  const sent = Date.now();
  fetch("/", { method: "HEAD", cache: "no-store" }).then((res) => {
    const server = Date.parse(res.headers.get("date") ?? "");
    if (!Number.isFinite(server)) return;
    // The header drops the milliseconds: +500 is the middle of the second it names.
    clockSkewMs = Math.round((sent + Date.now()) / 2 - (server + 500));
  }).catch(() => {});
}

/** Keys that scroll a focused list; typed into a field they are text, not scrolling. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Spacebar"]);

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && typeof el.closest === "function" && !!el.closest("input, textarea, select, [contenteditable]:not([contenteditable=\"false\"])");
}

/** Whether an upward move is one to record: big enough and not asked for by the reader. */
export function isUnexplainedDrop(prevTop: number, top: number, now: number, lastIntentAt: number): boolean {
  if (prevTop - top <= MIN_DROP_PX) return false;
  return now - lastIntentAt > INTENT_WINDOW_MS;
}

/** A message id reduced to what kind of row it is, so no id or text of a message leaves the page. */
export function rowKind(id: string | null | undefined): string | null {
  if (!id) return null;
  const prefix = /^([a-z]+)-/.exec(id)?.[1];
  if (prefix && !/^[0-9a-f]{8}$/.test(id.slice(0, 8))) return prefix;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(id) ? "uuid" : "other";
}

/**
 * The caller's stack as a few short frames, origin and query strings stripped. The first three
 * lines are the error's own head, the recorder and the wrapper that caught the write.
 */
export function shortStack(raw: string | undefined): string[] {
  return (raw ?? "").split("\n").slice(3, 3 + STACK_FRAMES)
    .map((line) => line.trim().replace(/https?:\/\/[^/\s)]+/g, "").replace(/\?[^:)\s]*/g, "").slice(0, STACK_LINE_CHARS));
}

// ------------------------------------------------------------------ socket events, per session

const EVENT_MEMORY_MS = 5_000;
const recent = new Map<string, Array<{ type: string; at: number }>>();

/** Called for every chat socket message; keeps a few seconds of types per session. */
export function noteScrollJumpEvent(sessionId: string | null | undefined, type: unknown): void {
  if (!SCROLL_JUMP_LOG_ENABLED || !sessionId || typeof type !== "string") return;
  const now = Date.now();
  const list = recent.get(sessionId) ?? [];
  list.push({ type, at: now });
  while (list.length > 0 && now - list[0]!.at > EVENT_MEMORY_MS) list.shift();
  if (list.length > 40) list.splice(0, list.length - 40);
  recent.set(sessionId, list);
}

function recentEvents(sessionId: string | null, now: number): ScrollJumpRecord["recentEvents"] {
  const list = sessionId ? recent.get(sessionId) ?? [] : [];
  // Streamed deltas are folded away: what matters is which control messages came, not how many tokens.
  const kept = list.filter((e) => !["text", "thinking", "status_update"].includes(e.type)).slice(-8);
  return kept.map((e) => ({ type: e.type, msAgo: now - e.at }));
}

// ------------------------------------------------------------------ the watcher

let windowStart = 0;
let windowCount = 0;

/** Records kept on the page as well, so an e2e can read them without the server. */
function keep(record: ScrollJumpRecord): void {
  const now = record.at;
  if (now - windowStart > 60_000) { windowStart = now; windowCount = 0; }
  if (++windowCount > MAX_RECORDS_PER_MINUTE) return;
  const w = window as unknown as { __ppmScrollJumps?: ScrollJumpRecord[] };
  (w.__ppmScrollJumps ??= []).push(record);
  if (w.__ppmScrollJumps.length > 50) w.__ppmScrollJumps.shift();
  // Three arguments: the trace keeps each one up to 2,000 characters, and the stack alone can
  // come close to that.
  const { write, ...rest } = record;
  console.warn("[scroll-jump]", JSON.stringify(rest), JSON.stringify(write));
}

/**
 * Watches one chat scroller until the returned function is called. `context` is read at the
 * moment of a move; `commit` is called by the list after every render it commits, so the record
 * can say what the list held just before.
 */
export function watchScrollJumps(el: HTMLElement, context: () => ScrollJumpContext): { stop: () => void; commit: () => void } {
  if (!SCROLL_JUMP_LOG_ENABLED || typeof window === "undefined") return { stop: () => {}, commit: () => {} };
  measureClockSkew();
  let lastTop = el.scrollTop;
  let lastSh = el.scrollHeight;
  let lastCh = el.clientHeight;
  let lastIntentAt = -Infinity;
  let lastReaderScrollAt = -Infinity;
  let lastLayoutAt = -Infinity;
  let lastWrite: { kind: string; asked: string; at: number; stack: string[] } | null = null;
  let prevCommit: ScrollJumpRecord["before"] & { at: number } | null = null;
  let curCommit: (ScrollJumpRecord["before"] & { at: number }) | null = null;

  /** A press on the scrollbar, held: every move until it is let go is the reader's. */
  let held = false;
  const intent = () => { lastIntentAt = performance.now(); };
  const onPointerDown = (e: PointerEvent) => { if (e.target === el) { held = true; intent(); } };
  const onPointerUp = () => { if (held) { held = false; intent(); } };
  const onKeyDown = (e: KeyboardEvent) => { if (SCROLL_KEYS.has(e.key) && !isEditable(e.target)) intent(); };

  // Code that writes the offset: caught on this element only, never on the prototype.
  const proto = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  const noteWrite = (kind: string, asked: string) => {
    lastWrite = { kind, asked, at: performance.now(), stack: shortStack(new Error().stack) };
  };
  if (proto?.get && proto.set) {
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get() { return proto.get!.call(this); },
      set(v: number) { noteWrite("scrollTop=", String(Math.round(v))); proto.set!.call(this, v); },
    });
  }
  const originals: Array<[string, unknown]> = [];
  for (const name of ["scrollTo", "scrollBy"] as const) {
    const original = el[name];
    originals.push([name, original]);
    (el as unknown as Record<string, unknown>)[name] = function (this: HTMLElement, ...args: unknown[]) {
      noteWrite(name, JSON.stringify(args).slice(0, 120));
      return (original as (...a: unknown[]) => void).apply(this, args);
    };
  }

  const onScroll = () => {
    const now = performance.now();
    const top = el.scrollTop;
    const sh = el.scrollHeight;
    const ch = el.clientHeight;
    // A fling keeps scrolling after the finger is gone, one event a frame: a move one frame or two
    // after a move of the reader's is still theirs. Wider than that would also take in the
    // follow-to-bottom's own scrolls, which come every flush while a turn streams.
    if (held || now - lastIntentAt <= INTENT_WINDOW_MS || now - lastReaderScrollAt <= FLING_GAP_MS) lastReaderScrollAt = now;
    // A hidden tab (no height) reads as offset 0 and means nothing.
    else if (ch > 0 && lastCh > 0 && isUnexplainedDrop(lastTop, top, now, lastIntentAt)) {
      const write = lastWrite && now - lastWrite.at <= WRITE_WINDOW_MS ? lastWrite : null;
      keep({
        at: Date.now(),
        drop: Math.round(lastTop - top),
        top: [Math.round(lastTop), Math.round(top)],
        scrollHeight: [Math.round(lastSh), Math.round(sh)],
        clientHeight: [Math.round(lastCh), Math.round(ch)],
        distFromBottom: [Math.round(lastSh - lastTop - lastCh), Math.round(sh - top - ch)],
        msSinceIntent: Number.isFinite(lastIntentAt) ? Math.round(now - lastIntentAt) : null,
        msSinceLayoutChange: Number.isFinite(lastLayoutAt) ? Math.round(now - lastLayoutAt) : null,
        before: prevCommit ? { rows: prevCommit.rows, lastRowKind: prevCommit.lastRowKind, hiddenRows: prevCommit.hiddenRows, timelineItems: prevCommit.timelineItems, msAgo: Math.round(now - prevCommit.at) } : null,
        after: context(),
        recentEvents: recentEvents(context().sessionId, Date.now()),
        write: write ? { kind: write.kind, asked: write.asked, msAgo: Math.round(now - write.at), stack: write.stack } : null,
        device: { width: window.innerWidth, height: window.innerHeight, coarse: !!window.matchMedia?.("(pointer: coarse)").matches },
        clockSkewMs,
      });
    }
    lastTop = top; lastSh = sh; lastCh = ch;
  };
  // Heights change without a scroll event (content growing below the view); keep the "before" fresh.
  const ro = new ResizeObserver(() => {
    lastLayoutAt = performance.now();
    lastSh = el.scrollHeight;
    lastCh = el.clientHeight;
    if (lastCh > 0 && el.scrollTop >= lastTop) lastTop = el.scrollTop;
  });
  ro.observe(el);
  if (el.firstElementChild) ro.observe(el.firstElementChild);

  el.addEventListener("scroll", onScroll, { passive: true });
  el.addEventListener("wheel", intent, { passive: true });
  el.addEventListener("touchstart", intent, { passive: true });
  el.addEventListener("touchmove", intent, { passive: true });
  el.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", onPointerUp, true);
  window.addEventListener("keydown", onKeyDown, true);

  return {
    commit: () => {
      const c = context();
      prevCommit = curCommit;
      curCommit = { rows: c.rows, lastRowKind: c.lastRowKind, hiddenRows: c.hiddenRows, timelineItems: c.timelineItems, msAgo: 0, at: performance.now() };
    },
    stop: () => {
      ro.disconnect();
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", intent);
      el.removeEventListener("touchstart", intent);
      el.removeEventListener("touchmove", intent);
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerUp, true);
      window.removeEventListener("keydown", onKeyDown, true);
      delete (el as unknown as Record<string, unknown>).scrollTop;
      for (const [name] of originals) delete (el as unknown as Record<string, unknown>)[name];
    },
  };
}
