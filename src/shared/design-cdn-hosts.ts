/**
 * Hosts a design canvas may load scripts, styles, fonts and images from. The canvas CSP
 * allows exactly these (over https) and the design instructions list the same array, so the
 * agent is told up front instead of discovering a blocked host as a blank preview.
 *
 * `cdn.jsdelivr.net` and `unpkg.com` proxy all of npm (jsdelivr also GitHub), so anything
 * published there can run in the sandbox. That is accepted: the frame has an opaque origin,
 * no PPM token, and `connect-src` limited to its own design, so it can render but not phone
 * home through `fetch`.
 */
export const DESIGN_CDN_HOSTS = [
  "cdn.tailwindcss.com",
  "cdn.jsdelivr.net",
  "unpkg.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
] as const;
