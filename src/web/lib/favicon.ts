// SVG favicon with blue rounded rect + white "PPM" text
const FAVICON_SVG_NORMAL = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="6" fill="#3b82f6"/>
  <text x="16" y="22" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="700" font-size="11" fill="white">PPM</text>
</svg>`;

// Same + red notification dot (top-right)
const FAVICON_SVG_BADGE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="6" fill="#3b82f6"/>
  <text x="16" y="22" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="700" font-size="11" fill="white">PPM</text>
  <circle cx="26" cy="6" r="5" fill="#ef4444"/>
</svg>`;

export const FAVICON_NORMAL = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG_NORMAL)}`;
export const FAVICON_BADGE = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG_BADGE)}`;

/** Swap favicon between normal and badge (red dot) variant */
export function setFavicon(hasBadge: boolean): void {
  const el = document.getElementById("ppm-favicon") as HTMLLinkElement | null;
  if (el) el.href = hasBadge ? FAVICON_BADGE : FAVICON_NORMAL;
}
