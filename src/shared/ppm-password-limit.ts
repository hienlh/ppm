/**
 * What the server says once too many wrong PPM passwords were typed in a row: every check is then
 * refused for a while, the right password included. Shared so a client can tell a lock from a
 * wrong password and offer the action again, rather than matching the server's wording.
 */
export const PPM_PASSWORD_LOCKED_PREFIX = "Too many wrong PPM passwords";

export function ppmPasswordLockedText(seconds: number): string {
  return `${PPM_PASSWORD_LOCKED_PREFIX}. Try again in ${Math.max(1, Math.ceil(seconds / 60))} min.`;
}

export function isPpmPasswordLockedText(text: string | null | undefined): boolean {
  return !!text && text.startsWith(PPM_PASSWORD_LOCKED_PREFIX);
}
