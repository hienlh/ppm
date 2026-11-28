/**
 * Size of the phone viewer's virtual cursor (Mouse mode). Kept apart from the settings store so
 * it can be tested: the store reads `localStorage` when it is imported.
 */
export type RemoteDesktopCursorSize = "small" | "medium" | "large";

/** Diameter in CSS pixels on the phone's screen, whatever the zoom. Small is the size the
 *  marker has always had. */
export const CURSOR_SIZE_PX: Record<RemoteDesktopCursorSize, number> = { small: 14, medium: 22, large: 32 };

export const CURSOR_SIZES: readonly { id: RemoteDesktopCursorSize; label: string }[] = [
  { id: "small", label: "Small" },
  { id: "medium", label: "Medium" },
  { id: "large", label: "Large" },
];

/** A stored value, read back from `localStorage`, is untrusted: anything else is Small. */
export function parseCursorSize(value: unknown): RemoteDesktopCursorSize {
  return value === "medium" || value === "large" ? value : "small";
}
