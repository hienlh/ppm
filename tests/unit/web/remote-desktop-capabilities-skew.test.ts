/**
 * Version skew between the viewer and the host.
 *
 * These are not one deployable: a tab holds its bundle until it reloads, a phone holds one until
 * its service worker updates, and `dist/ppm` is built separately — so a new viewer routinely
 * talks to an older `/capabilities`. Reading a field that predates the host does not degrade,
 * it throws past the last error boundary and blanks the page ("Cannot read properties of
 * undefined (reading 'modes')"). The repair is one normalisation, so the ten nested call sites
 * cannot each forget an optional chain.
 */
import { describe, expect, test } from "bun:test";
import {
  normalizeCapabilities,
  type RemoteDesktopCapabilities,
} from "../../../src/web/components/remote-desktop/use-remote-desktop-readiness.ts";

/** What a host from before any of this shipped actually answers with. */
const ANCIENT = {
  displays: [{ id: "HDMI-2", label: "HDMI-2", primary: true, x: 0, y: 0, width: 3440, height: 1440, captureIndex: 0 }],
  ffmpegAvailable: true,
  videoAvailable: true,
  inputAvailable: true,
  authRequired: true,
  platform: "linux",
  platformSupported: true,
  videoReady: true,
  inputReady: true,
} as unknown as RemoteDesktopCapabilities;

describe("normalizeCapabilities", () => {
  test("every field a newer viewer reads survives an older host", () => {
    const caps = normalizeCapabilities(ANCIENT);
    // The exact reads the viewer and both toolbars perform, in the shape they perform them.
    expect(caps.resolutions.modes).toEqual([]);
    expect(caps.resolutions.reason).toBeNull();
    expect(caps.encoders).toEqual([]);
    expect(caps.audio.available).toBe(false);
    expect(caps.privacy.available).toBe(false);
    expect(caps.privacy.canBlank).toBe(false);
    expect(caps.clipboard.available).toBe(false);
    expect(caps.requirements).toEqual([]);
  });

  test("the crash itself: the read that blanked the page no longer throws", () => {
    // `caps?.resolutions.modes ?? []` guards only the first hop, which is the whole bug.
    expect(() => normalizeCapabilities(ANCIENT).resolutions.modes.length).not.toThrow();
  });

  test("a current host is passed through untouched", () => {
    const modern: RemoteDesktopCapabilities = {
      ...ANCIENT,
      encoders: ["h264_qsv", "libx264"],
      requirements: [],
      clipboard: { available: true, action: null },
      audio: { available: true, reason: null },
      privacy: { available: true, reason: null, canBlank: true },
      resolutions: {
        output: "HDMI-2",
        modes: [{ id: "70", width: 3440, height: 1440, refresh: 60, current: true, preferred: true }],
        reason: null,
      },
    };
    const caps = normalizeCapabilities(modern);
    expect(caps.resolutions).toBe(modern.resolutions);
    expect(caps.encoders).toBe(modern.encoders);
    expect(caps.privacy.canBlank).toBe(true);
  });

  test("a partially-new host keeps what it did send", () => {
    // Fields arrived in separate commits, so the in-between shapes are real.
    const partial = { ...ANCIENT, audio: { available: true, reason: null } } as RemoteDesktopCapabilities;
    const caps = normalizeCapabilities(partial);
    expect(caps.audio.available).toBe(true);
    expect(caps.resolutions.modes).toEqual([]);
  });
});

describe("no call site reads a skew-prone field without going through the hook", () => {
  test("nothing double-dots into caps past a single optional chain", async () => {
    const files = [
      "src/web/components/remote-desktop/remote-desktop-window-content.tsx",
      "src/web/components/remote-desktop/remote-desktop-mobile-view.tsx",
    ];
    for (const file of files) {
      const src = await Bun.file(file).text();
      // `caps?.resolutions.modes` — optional on the first hop, plain on the second. That is the
      // exact shape that crashed, and it reads as safe, so it needs to fail as a test.
      const offenders = [...src.matchAll(/caps\?\.\w+\.\w+/g)].map((m) => m[0]);
      expect(offenders).toEqual([]);
    }
  });
});
