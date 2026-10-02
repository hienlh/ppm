/**
 * Where a pointer landed, in the terms the emulator wants.
 *
 * Three coordinate spaces, and mixing any two of them looks like "taps land slightly off" rather
 * than like a bug:
 *
 *  1. **Element space** — CSS pixels inside the canvas's bounding box, which is what a
 *     `PointerEvent` gives. The canvas is drawn `object-contain`, so unless the aspect ratios
 *     match exactly there are letterbox bars that belong to no pixel at all.
 *  2. **Frame space** — the H.264 picture's own pixels. This is what the canvas holds.
 *  3. **Device space** — the guest's physical display. `Touch.x` is documented as "the physical
 *     location on the screen", so a scaled frame's coordinates are NOT what the emulator wants,
 *     and sending them makes every tap land proportionally short on a downscaled rung.
 *
 * Pure, so the arithmetic is testable without a canvas or a WebSocket.
 */
import type { AndroidGeometry } from "../../../shared/android-protocol";

export interface ElementBox {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Where the picture actually sits inside an `object-contain` box, letterbox bars excluded. */
export function containedRect(box: ElementBox, frameWidth: number, frameHeight: number): {
  left: number; top: number; width: number; height: number; scale: number;
} {
  if (frameWidth <= 0 || frameHeight <= 0 || box.width <= 0 || box.height <= 0) {
    return { left: 0, top: 0, width: 0, height: 0, scale: 0 };
  }
  const scale = Math.min(box.width / frameWidth, box.height / frameHeight);
  const width = frameWidth * scale;
  const height = frameHeight * scale;
  return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height, scale };
}

/**
 * Element-space offset -> frame pixels, or null when the point is on a letterbox bar.
 *
 * Null rather than a clamp: a tap on the bar beside a phone-shaped picture is not a tap on the
 * phone's edge, and clamping would make the guest's leftmost column absurdly easy to hit.
 */
export function pointerToFrame(
  box: ElementBox, frameWidth: number, frameHeight: number, offsetX: number, offsetY: number,
): Point | null {
  const rect = containedRect(box, frameWidth, frameHeight);
  if (rect.scale <= 0) return null;
  const x = (offsetX - rect.left) / rect.scale;
  const y = (offsetY - rect.top) / rect.scale;
  if (x < 0 || y < 0 || x > frameWidth || y > frameHeight) return null;
  // The far edge is inclusive in element space but exclusive in pixels.
  return { x: Math.min(x, frameWidth - 1), y: Math.min(y, frameHeight - 1) };
}

/**
 * Frame pixels -> the guest's own display pixels.
 *
 * Two measured facts decide this, and neither is derivable from the proto:
 *
 *  1. **`Touch.x/y` are always in the panel's own unrotated pixels** — `hw.lcd.width` by
 *     `hw.lcd.height` — whatever the device's current rotation is. Verified with `getevent`:
 *     the guest's touchscreen reports a 0..32767 absolute range, and sending x=2000 on a
 *     1080-wide panel produced 60679, i.e. 2000/1080 of full scale, clamped past the edge. The
 *     rotated display's coordinates are NOT what the emulator wants.
 *  2. **The frame is the rotated display**, so it has to be rotated back. The direction was
 *     measured per orientation by touching a known panel point with `show_touches` on and
 *     finding the marker in the frame; each rotation's winner beat the runner-up by an order of
 *     magnitude (90 deg: 0.040 against 0.449; 180: 0.003 against 0.433; 270: 0.080 against 0.420).
 *
 * Normalised coordinates throughout, so the frame being a scaled copy never enters into it.
 */
export function frameToDevice(point: Point, geometry: AndroidGeometry): Point {
  const { width, height, deviceWidth, deviceHeight, rotation } = geometry;
  if (width <= 0 || height <= 0) return { x: 0, y: 0 };
  const u = point.x / width;
  const v = point.y / height;
  let pu: number;
  let pv: number;
  switch (rotation) {
    case 90:  pu = 1 - v; pv = u; break;
    case 180: pu = 1 - u; pv = 1 - v; break;
    case 270: pu = v; pv = 1 - u; break;
    default:  pu = u; pv = v; break;
  }
  return { x: Math.round(pu * deviceWidth), y: Math.round(pv * deviceHeight) };
}

/** The whole path, element offset to something `sendTouch` accepts. */
export function pointerToDevice(
  box: ElementBox, geometry: AndroidGeometry, offsetX: number, offsetY: number,
): Point | null {
  const frame = pointerToFrame(box, geometry.width, geometry.height, offsetX, offsetY);
  return frame ? frameToDevice(frame, geometry) : null;
}
