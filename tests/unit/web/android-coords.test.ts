import { describe, expect, test } from "bun:test";
import {
  containedRect, frameToDevice, pointerToDevice, pointerToFrame,
} from "../../../src/web/components/android/android-coords";
import { nextRotation } from "../../../src/web/components/android/android-controls";
import type { AndroidGeometry } from "../../../src/shared/android-protocol";

const portrait: AndroidGeometry = {
  width: 540, height: 1200, deviceWidth: 1080, deviceHeight: 2400, rotation: 0, generation: 1,
};

describe("object-contain letterboxing", () => {
  test("a wider box gets bars on the left and right", () => {
    const rect = containedRect({ width: 1000, height: 1200 }, 540, 1200);
    expect(rect.scale).toBe(1);
    expect(rect.left).toBe(230);
    expect(rect.top).toBe(0);
  });

  test("a shorter box scales down and centres vertically", () => {
    const rect = containedRect({ width: 540, height: 600 }, 540, 1200);
    expect(rect.scale).toBe(0.5);
    expect(rect.height).toBe(600);
    expect(rect.left).toBe(135);
  });

  test("a zero-sized box yields no scale rather than Infinity or NaN", () => {
    expect(containedRect({ width: 0, height: 0 }, 540, 1200).scale).toBe(0);
    expect(containedRect({ width: 100, height: 100 }, 0, 0).scale).toBe(0);
  });
});

describe("pointer to frame", () => {
  test("the centre of the picture is the centre of the frame", () => {
    expect(pointerToFrame({ width: 1000, height: 1200 }, 540, 1200, 500, 600))
      .toEqual({ x: 270, y: 600 });
  });

  // A tap on a bar beside a phone-shaped picture is not a tap on the phone's edge. Clamping
  // would make the guest's leftmost column absurdly easy to hit by accident.
  test("a tap on a letterbox bar is not a tap on the guest", () => {
    expect(pointerToFrame({ width: 1000, height: 1200 }, 540, 1200, 10, 600)).toBeNull();
    expect(pointerToFrame({ width: 1000, height: 1200 }, 540, 1200, 990, 600)).toBeNull();
  });

  test("the far edge maps to the last pixel, not one past it", () => {
    const p = pointerToFrame({ width: 540, height: 1200 }, 540, 1200, 540, 1200)!;
    expect(p).toEqual({ x: 539, y: 1199 });
  });
});

describe("frame to device", () => {
  // `Touch.x` is documented as "the physical location on the screen", so a downscaled frame's
  // own coordinates are NOT what the emulator wants — sending them lands every tap short.
  test("scales a downscaled frame back up to the guest's real pixels", () => {
    expect(frameToDevice({ x: 270, y: 600 }, portrait)).toEqual({ x: 540, y: 1200 });
    expect(frameToDevice({ x: 0, y: 0 }, portrait)).toEqual({ x: 0, y: 0 });
  });

  // `sendTouch` takes the panel's own UNROTATED pixels whatever the rotation — measured with
  // `getevent`, where x=2000 on a 1080-wide panel came back as 2000/1080 of full scale. So a
  // rotated frame has to be rotated back, and each direction below was measured by touching a
  // known panel point with `show_touches` on and finding the marker in the frame.
  test("a 90-degree frame is rotated back onto the panel", () => {
    const l: AndroidGeometry = { ...portrait, width: 1200, height: 540, rotation: 90 };
    // Frame top-left is the panel's BOTTOM-left; frame top-right is the panel's top-left.
    expect(frameToDevice({ x: 0, y: 0 }, l)).toEqual({ x: 1080, y: 0 });
    expect(frameToDevice({ x: 1200, y: 540 }, l)).toEqual({ x: 0, y: 2400 });
    expect(frameToDevice({ x: 600, y: 270 }, l)).toEqual({ x: 540, y: 1200 });
  });

  test("a 180-degree frame is mirrored on both axes", () => {
    const r: AndroidGeometry = { ...portrait, rotation: 180 };
    expect(frameToDevice({ x: 0, y: 0 }, r)).toEqual({ x: 1080, y: 2400 });
    expect(frameToDevice({ x: 270, y: 600 }, r)).toEqual({ x: 540, y: 1200 });
  });

  test("a 270-degree frame rotates the other way", () => {
    const l: AndroidGeometry = { ...portrait, width: 1200, height: 540, rotation: 270 };
    expect(frameToDevice({ x: 0, y: 0 }, l)).toEqual({ x: 0, y: 2400 });
    expect(frameToDevice({ x: 1200, y: 540 }, l)).toEqual({ x: 1080, y: 0 });
    expect(frameToDevice({ x: 600, y: 270 }, l)).toEqual({ x: 540, y: 1200 });
  });

  // The centre must stay the centre in every orientation, or a rotation shifts every tap.
  test("the centre of the frame is the centre of the panel at every rotation", () => {
    for (const rotation of [0, 90, 180, 270] as const) {
      const swapped = rotation === 90 || rotation === 270;
      const g: AndroidGeometry = {
        ...portrait, rotation,
        width: swapped ? 1200 : 540, height: swapped ? 540 : 1200,
      };
      expect(frameToDevice({ x: g.width / 2, y: g.height / 2 }, g)).toEqual({ x: 540, y: 1200 });
    }
  });

  test("a frame with no size yields the origin rather than NaN", () => {
    expect(frameToDevice({ x: 5, y: 5 }, { ...portrait, width: 0, height: 0 })).toEqual({ x: 0, y: 0 });
  });
});

describe("the whole path", () => {
  test("element offset to a coordinate the emulator accepts", () => {
    expect(pointerToDevice({ width: 1000, height: 1200 }, portrait, 500, 600))
      .toEqual({ x: 540, y: 1200 });
  });

  test("a letterbox tap stays null all the way through", () => {
    expect(pointerToDevice({ width: 1000, height: 1200 }, portrait, 5, 600)).toBeNull();
  });
});

describe("rotation cycling", () => {
  test("one button reaches every orientation and returns", () => {
    expect(nextRotation(0)).toBe(90);
    expect(nextRotation(90)).toBe(180);
    expect(nextRotation(180)).toBe(270);
    expect(nextRotation(270)).toBe(0);
  });
});
