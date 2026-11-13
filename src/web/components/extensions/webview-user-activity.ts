/**
 * A webview's own claim that a person just interacted with it.
 *
 * Pointer and keyboard events inside a sandboxed iframe never reach the parent document, so
 * without this an extension's own UI could never count toward presence. But ordinary protocol
 * traffic the parent's message listener also sees — a `graph:get` round trip, a file-icon
 * request, an iframe reload — must never count on its own (an open panel would otherwise pause
 * its own runs and open the spend gate by doing nothing). Only this explicit message counts,
 * and it is never forwarded to the extension, the way `webview-external-link.ts`'s message
 * is not.
 */
export const USER_ACTIVITY_COMMAND = "__ppm.userActivity";

export function isUserActivityMessage(data: unknown): boolean {
  return !!data && typeof data === "object" && (data as { command?: unknown }).command === USER_ACTIVITY_COMMAND;
}
