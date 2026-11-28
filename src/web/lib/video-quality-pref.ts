import type { VideoQuality } from "../../shared/card-files";

/**
 * Which copy of a video this device plays: "original" (the file as it is) or "smooth" (~4 Mbit/s,
 * same resolution). Remembered per device in localStorage, never synced: a phone on mobile data
 * and a desktop on the LAN want different answers. Until the viewer chooses, a phone starts on
 * Smooth and a desktop on Original. Storage that throws (a private window) just means the default.
 */
const KEY = "ppm-video-quality";

export function readVideoQuality(isMobile: boolean): VideoQuality {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "original" || saved === "smooth") return saved;
  } catch { /* storage unavailable: the default */ }
  return isMobile ? "smooth" : "original";
}

export function writeVideoQuality(quality: VideoQuality): void {
  try { localStorage.setItem(KEY, quality); } catch { /* storage unavailable: not remembered */ }
}
