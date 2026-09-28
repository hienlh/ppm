import type { DesignKind } from "../../../../shared/design-types";

/**
 * The sizes a design can be previewed at. `desktop` is the canvas itself (whatever room
 * the pane has); every other frame is a fixed CSS size that is scaled down to fit, so a
 * phone layout is laid out at 390px even on a narrow pane.
 */
export const DEVICE_FRAME_IDS = ["desktop", "tablet", "phone", "slide"] as const;
export type DeviceFrameId = (typeof DEVICE_FRAME_IDS)[number];

export interface DeviceFramePreset {
  id: DeviceFrameId;
  label: string;
  /** CSS pixels, or null for "fill the pane". */
  size: { width: number; height: number } | null;
}

export const DEVICE_FRAMES: readonly DeviceFramePreset[] = [
  { id: "desktop", label: "Desktop", size: null },
  { id: "tablet", label: "Tablet", size: { width: 820, height: 1180 } },
  { id: "phone", label: "Phone", size: { width: 390, height: 844 } },
  // The deck format the design instructions ask for, so a slide fills its frame exactly.
  { id: "slide", label: "Slide", size: { width: 1280, height: 720 } },
];

export function isDeviceFrameId(value: unknown): value is DeviceFrameId {
  return typeof value === "string" && (DEVICE_FRAME_IDS as readonly string[]).includes(value);
}

export function framePreset(id: DeviceFrameId): DeviceFramePreset {
  return DEVICE_FRAMES.find((f) => f.id === id) ?? DEVICE_FRAMES[0]!;
}

/** A deck opens on its slide frame; everything else on the plain canvas. */
export function defaultFrameFor(kind: DesignKind | undefined): DeviceFrameId {
  return kind === "slides" ? "slide" : "desktop";
}
