const COLOR_PRIMARY = "#3b82f6";
const COLOR_STREAMING = "#f59e0b"; // amber-500

function buildSvg(bgColor: string, badgeDot: boolean): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="6" fill="${bgColor}"/>
  <text x="16" y="22" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="700" font-size="11" fill="white">PPM</text>
  ${badgeDot ? '<circle cx="26" cy="6" r="5" fill="#ef4444"/>' : ""}
</svg>`;
}

// Pre-encode all 4 variants
export const FAVICON_NORMAL = `data:image/svg+xml,${encodeURIComponent(buildSvg(COLOR_PRIMARY, false))}`;
export const FAVICON_BADGE = `data:image/svg+xml,${encodeURIComponent(buildSvg(COLOR_PRIMARY, true))}`;
const FAVICON_STREAMING = `data:image/svg+xml,${encodeURIComponent(buildSvg(COLOR_STREAMING, false))}`;
const FAVICON_STREAMING_BADGE = `data:image/svg+xml,${encodeURIComponent(buildSvg(COLOR_STREAMING, true))}`;

/**
 * Swap favicon. When `isStreamingAlt` is true, uses amber color to
 * create an alternation effect (caller toggles this on an interval).
 */
export function setFavicon(hasBadge: boolean, isStreamingAlt = false): void {
  const el = document.getElementById("ppm-favicon") as HTMLLinkElement | null;
  if (!el) return;
  if (isStreamingAlt) {
    el.href = hasBadge ? FAVICON_STREAMING_BADGE : FAVICON_STREAMING;
  } else {
    el.href = hasBadge ? FAVICON_BADGE : FAVICON_NORMAL;
  }
}
