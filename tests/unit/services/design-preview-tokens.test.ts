import { describe, expect, it } from "bun:test";
import {
  CANVAS_HARD_TTL, CANVAS_IDLE_TTL, createDesignPreviewTokenStore, isDesignPreviewPurpose, ONE_SHOT_TTL, ROTATE_WINDOW,
} from "../../../src/services/design/preview/design-preview-tokens.ts";

const MIN = 60 * 1000;
const design = { projectPath: "/p", slug: "landing" };

function clock() {
  const state = { t: 1_000_000 };
  return { state, now: () => state.t };
}

describe("design preview tokens", () => {
  it("validates purposes", () => {
    for (const p of ["canvas", "print", "standalone"]) expect(isDesignPreviewPurpose(p)).toBe(true);
    for (const p of ["", "Canvas", "admin", null, 1]) expect(isDesignPreviewPurpose(p)).toBe(false);
  });

  it("never extends a token on resolve (what every unauthenticated GET does)", () => {
    const { state, now } = clock();
    const store = createDesignPreviewTokenStore(now);
    const cap = store.mint(design, "canvas");
    expect(cap.idleExpires - cap.mintedAt).toBe(CANVAS_IDLE_TTL);
    for (let i = 0; i < 29; i++) {
      state.t += MIN;
      expect(store.resolve(cap.token)).not.toBeNull();
    }
    expect(cap.idleExpires).toBe(cap.mintedAt + CANVAS_IDLE_TTL);
    state.t = cap.idleExpires;
    expect(store.resolve(cap.token)).toBeNull();
    // Gone for good: a refresh cannot revive it either.
    expect(store.refresh(cap.token, design)).toEqual({ ok: false, reason: "unknown" });
  });

  it("extends the idle expiry on refresh, but never past the hard cap", () => {
    const { state, now } = clock();
    const store = createDesignPreviewTokenStore(now);
    const cap = store.mint(design, "canvas");
    const hard = cap.mintedAt + CANVAS_HARD_TTL;
    // The canvas refreshes every 10 minutes, into the rotation window and up to the cap.
    while (state.t + 10 * MIN <= hard - 10 * MIN) {
      state.t += 10 * MIN;
      expect(store.refresh(cap.token, design)).toMatchObject({ ok: true });
      expect(cap.idleExpires).toBe(Math.min(state.t + CANVAS_IDLE_TTL, hard));
    }
    expect(cap.idleExpires).toBe(hard);
    state.t = hard;
    expect(store.resolve(cap.token)).toBeNull();
  });

  it("rotates inside the last hour; the old token keeps serving until its own expiry", () => {
    const { state, now } = clock();
    const store = createDesignPreviewTokenStore(now);
    const old = store.mint(design, "canvas");
    const rotateAt = old.mintedAt + CANVAS_HARD_TTL - ROTATE_WINDOW;
    // Kept alive by the canvas's periodic refresh up to the rotation window.
    while (state.t + 20 * MIN < rotateAt) {
      state.t += 20 * MIN;
      expect(store.refresh(old.token, design)).toMatchObject({ ok: true, rotated: false });
    }
    state.t = rotateAt + MIN;
    const r = store.refresh(old.token, design);
    if (!r.ok) throw new Error("refresh failed");
    expect(r.rotated).toBe(true);
    expect(r.capability.token).not.toBe(old.token);
    expect(r.capability.hardExpires).toBe(state.t + CANVAS_HARD_TTL);
    expect(store.resolve(r.capability.token)).toBe(r.capability);
    expect(store.resolve(old.token)).toBe(old);
    // A second refresh with the old token returns the same successor, not a new one each time.
    const again = store.refresh(old.token, design);
    expect(again).toMatchObject({ ok: true, rotated: true, capability: { token: r.capability.token } });
    // The canvas now refreshes with its successor; the old token simply runs out.
    for (const step of [20, 20]) {
      state.t += step * MIN;
      expect(store.refresh(r.capability.token, design)).toMatchObject({ ok: true, rotated: false });
      expect(store.resolve(old.token)).toBe(old);
    }
    state.t = old.hardExpires;
    expect(store.resolve(old.token)).toBeNull();
    expect(store.resolve(r.capability.token)).not.toBeNull();
  });

  it("gives print and standalone tokens 10 minutes and no refresh", () => {
    const { state, now } = clock();
    const store = createDesignPreviewTokenStore(now);
    for (const purpose of ["print", "standalone"] as const) {
      const cap = store.mint(design, purpose);
      expect(cap.hardExpires - cap.mintedAt).toBe(ONE_SHOT_TTL);
      expect(cap.idleExpires).toBe(cap.hardExpires);
      expect(store.refresh(cap.token, design)).toEqual({ ok: false, reason: "not-refreshable" });
    }
    state.t += ONE_SHOT_TTL;
    expect(store.size()).toBe(2);
    store.mint(design, "canvas");
    expect(store.size()).toBe(1);
  });

  it("refuses a refresh for another design, even in the same project", () => {
    const store = createDesignPreviewTokenStore(clock().now);
    const cap = store.mint(design, "canvas");
    expect(store.refresh(cap.token, { projectPath: "/p", slug: "other" })).toEqual({ ok: false, reason: "wrong-design" });
    expect(store.refresh(cap.token, { projectPath: "/q", slug: "landing" })).toEqual({ ok: false, reason: "wrong-design" });
  });

  it("caps the store, evicting the oldest", () => {
    const store = createDesignPreviewTokenStore(clock().now, 3);
    const [a, b, c, d] = [0, 1, 2, 3].map(() => store.mint(design, "canvas"));
    expect(store.size()).toBe(3);
    expect(store.resolve(a!.token)).toBeNull();
    for (const cap of [b, c, d]) expect(store.resolve(cap!.token)).not.toBeNull();
  });
});
