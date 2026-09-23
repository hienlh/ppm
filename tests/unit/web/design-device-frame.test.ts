import { describe, expect, it } from "bun:test";
import {
  DEVICE_FRAMES, DEVICE_FRAME_IDS, defaultFrameFor, framePreset, isDeviceFrameId,
} from "../../../src/web/components/design/canvas/device-frame-presets";

describe("device frame presets", () => {
  it("covers every id exactly once, desktop first", () => {
    expect(DEVICE_FRAMES.map((f) => f.id)).toEqual([...DEVICE_FRAME_IDS]);
    expect(DEVICE_FRAMES[0]!.id).toBe("desktop");
  });

  it("uses the sizes the design instructions promise", () => {
    expect(framePreset("desktop").size).toBeNull();
    expect(framePreset("tablet").size).toEqual({ width: 820, height: 1180 });
    expect(framePreset("phone").size).toEqual({ width: 390, height: 844 });
    expect(framePreset("slide").size).toEqual({ width: 1280, height: 720 });
  });

  it("opens a deck on the slide frame and anything else on the plain canvas", () => {
    expect(defaultFrameFor("slides")).toBe("slide");
    expect(defaultFrameFor("page")).toBe("desktop");
    expect(defaultFrameFor(undefined)).toBe("desktop");
  });

  it("rejects ids that are not frames, including prototype keys", () => {
    for (const bad of ["watch", "", "constructor", "__proto__", 3, null, undefined, {}]) {
      expect(isDeviceFrameId(bad)).toBe(false);
    }
    expect(isDeviceFrameId("phone")).toBe(true);
  });
});
