const COLOR_PRIMARY = "#3b82f6";
const COLOR_STREAMING = "#f59e0b"; // amber-500 — high-attention bg for typing state
const COLOR_BADGE = "#ef4444";

/** Idle favicon — "PPM" text on primary background, optional red badge dot. */
function buildIdleSvg(badgeDot: boolean): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="6" fill="${COLOR_PRIMARY}"/>
  <text x="16" y="22" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="700" font-size="11" fill="white">PPM</text>
  ${badgeDot ? `<circle cx="26" cy="6" r="5" fill="${COLOR_BADGE}"/>` : ""}
</svg>`;
}

/** Streaming favicon — 3 dots (Messenger typing style). `activeDot` (0-2) is raised, -1 = rest. */
function buildStreamingSvg(activeDot: number, badgeDot: boolean): string {
  const dots = [10, 16, 22].map((cx, i) => {
    const cy = i === activeDot ? 13 : 17;
    return `<circle cx="${cx}" cy="${cy}" r="3" fill="white"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="6" fill="${COLOR_STREAMING}"/>
  ${dots}
  ${badgeDot ? `<circle cx="26" cy="6" r="5" fill="${COLOR_BADGE}"/>` : ""}
</svg>`;
}

const encode = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`;

// Pre-encode all variants: [no-badge, with-badge]
const FAVICON_IDLE: [string, string] = [encode(buildIdleSvg(false)), encode(buildIdleSvg(true))];
// 4 frames: dot0 up, dot1 up, dot2 up, all rest (-1) — rest frame makes cycle boundary perceptible
const FAVICON_STREAM: [string, string][] = [0, 1, 2, -1].map((f) =>
  [encode(buildStreamingSvg(f, false)), encode(buildStreamingSvg(f, true))] as [string, string],
);
export const STREAM_FRAME_COUNT = FAVICON_STREAM.length;

/**
 * Swap favicon.
 * @param hasBadge — true if unread notifications exist
 * @param streamingFrame — 0..STREAM_FRAME_COUNT-1 for typing-dots animation, null for idle
 */
export function setFavicon(hasBadge: boolean, streamingFrame: number | null = null): void {
  const el = document.getElementById("ppm-favicon") as HTMLLinkElement | null;
  if (!el) return;
  const badgeIdx = hasBadge ? 1 : 0;
  if (streamingFrame === null) {
    el.href = FAVICON_IDLE[badgeIdx];
  } else {
    const frame = ((streamingFrame % STREAM_FRAME_COUNT) + STREAM_FRAME_COUNT) % STREAM_FRAME_COUNT;
    el.href = FAVICON_STREAM[frame]![badgeIdx];
  }
}
