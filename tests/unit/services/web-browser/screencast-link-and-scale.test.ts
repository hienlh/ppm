import { describe, expect, test } from "bun:test";
import { LINK_WINDOW_MS, LinkMonitor } from "../../../../src/services/web-browser/screencast-link.ts";
import { SCROLL_TARGET_FPS, chooseScale } from "../../../../src/services/web-browser/screencast-scale.ts";

describe("LinkMonitor", () => {
  test("says nothing while the pacer never waited on the viewer", () => {
    const m = new LinkMonitor();
    for (let t = 0; t < 1000; t += 33) m.onViewerAck(t);
    expect(m.linkFps(1000)).toBeNull();
  });

  test("reports the viewer's ack rate once the pacer had to wait on it", () => {
    const m = new LinkMonitor();
    for (let t = 0; t <= 1000; t += 125) m.onViewerAck(t); // 8 a second
    m.onViewerLimited(900);
    expect(m.linkFps(1000)).toBeCloseTo(8, 5);
  });

  test("forgets a wait older than its window", () => {
    const m = new LinkMonitor();
    m.onViewerLimited(0);
    for (let t = 0; t <= 4000; t += 125) m.onViewerAck(t);
    expect(m.linkFps(4000)).toBeNull();
    expect(LINK_WINDOW_MS).toBeLessThan(4000);
  });

  test("needs a few acks before it answers", () => {
    const m = new LinkMonitor();
    m.onViewerLimited(0);
    m.onViewerAck(10);
    expect(m.linkFps(20)).toBeNull();
  });
});

describe("chooseScale", () => {
  test("full size when still, when the link keeps up, and on a fast link", () => {
    expect(chooseScale({ moving: false, linkFps: 2, capFps: 30 })).toBe(1);
    expect(chooseScale({ moving: true, linkFps: null, capFps: 30 })).toBe(1);
    expect(chooseScale({ moving: true, linkFps: 40, capFps: 30 })).toBe(1);
  });

  test("smaller pictures while scrolling over a slow link, the largest that keeps the pace", () => {
    expect(chooseScale({ moving: true, linkFps: 8, capFps: 30 })).toBe(0.75); // 8 / 0.57 = 14
    expect(chooseScale({ moving: true, linkFps: 5, capFps: 30 })).toBe(0.5);
    expect(chooseScale({ moving: true, linkFps: 1, capFps: 30 })).toBe(0.5);
  });

  test("a low ceiling asks for less, so pictures stay larger", () => {
    expect(chooseScale({ moving: true, linkFps: 8, capFps: 8 })).toBe(1);
    expect(SCROLL_TARGET_FPS).toBe(12);
  });
});
