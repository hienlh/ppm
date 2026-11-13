/**
 * Sent on `/ws/global` after an extension write answers with a 2xx (install, dev-link, remove,
 * enable, disable), whoever made it: Settings → Extensions, the `ppm ext` CLI, the Assistant. Every
 * open PPM then reads the extension list and the contributions again, so a disabled extension's
 * commands leave the palette without a reload.
 */
export const EXTENSIONS_CHANGED_EVENT = "extensions:changed";
