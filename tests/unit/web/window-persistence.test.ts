// Run in Docker if the host segfaults: docker run --rm -v "$PWD":/app -w /app oven/bun bun test tests/unit/web/window-persistence.test.ts
//
// Coverage for the floating-window rect blob (`ppm-windows`), added alongside the
// `team-member` → `agent-session` kind rename: an agent-session window must never come
// back after a reload (its body streams a live transcript that no longer exists), and a
// blob still holding the pre-rename kind string must be silently dropped rather than
// restored as some unknown window.
import { describe, it, expect, beforeEach } from "bun:test";

const memStore: Record<string, string> = {};
let failWrites = false;
const localStorageStub = {
  getItem: (key: string) => memStore[key] ?? null,
  setItem: (key: string, value: string) => {
    if (failWrites) throw new Error("QuotaExceededError");
    memStore[key] = value;
  },
  removeItem: (key: string) => { delete memStore[key]; },
  clear: () => { for (const k of Object.keys(memStore)) delete memStore[k]; },
};
(globalThis as unknown as { localStorage: typeof localStorageStub }).localStorage = localStorageStub;

import {
  loadWindowRects,
  saveWindowRects,
} from "../../../src/web/components/floating-window/window-persistence";
import type { WindowRuntimeState } from "../../../src/web/components/floating-window/window-store-types";

const KEY = "ppm-windows";
const BOUNDS = { w: 1600, h: 900 };
const RECT = { x: 10, y: 10, w: 400, h: 300 };

function win(id: string, kind: WindowRuntimeState["kind"], rank = 0): WindowRuntimeState {
  return { id, kind, rect: RECT, rank, state: "normal", payload: undefined };
}

beforeEach(() => {
  localStorageStub.clear();
  failWrites = false;
});

describe("saveWindowRects / loadWindowRects", () => {
  it("round-trips a restorable window", () => {
    saveWindowRects([win("w1", "explorer")]);
    const loaded = loadWindowRects(BOUNDS);
    expect(loaded.map((w) => w.id)).toEqual(["w1"]);
  });

  it("never persists an agent-session window as restorable", () => {
    saveWindowRects([win("w1", "explorer"), win("w2", "agent-session")]);
    // Saved verbatim (so a live session survives a move/resize within the same page life)...
    const raw = JSON.parse(localStorageStub.getItem(KEY)!) as { kind: string }[];
    expect(raw.map((w) => w.kind).sort()).toEqual(["agent-session", "explorer"]);
    // ...but never comes back on load.
    const loaded = loadWindowRects(BOUNDS);
    expect(loaded.map((w) => w.id)).toEqual(["w1"]);
  });

  it("drops a blob still holding the pre-rename `team-member` kind string", () => {
    memStore[KEY] = JSON.stringify([
      { id: "old", kind: "team-member", rect: RECT, state: "normal" },
      { id: "w1", kind: "explorer", rect: RECT, state: "normal" },
    ]);
    expect(loadWindowRects(BOUNDS).map((w) => w.id)).toEqual(["w1"]);
  });
});
