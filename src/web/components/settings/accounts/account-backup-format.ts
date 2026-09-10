/**
 * Shared bits of the encrypted account-backup format.
 *
 * The password default is part of the format, not a UI nicety: an export written with it
 * must import with it, so export and import have to read the same constant.
 */

/** Used when the user leaves the password field empty on either side of the round trip. */
export const DEFAULT_PASSWORD = "ppm-hienlh";

/** Save the backup text as a file — the fallback when the clipboard is unavailable. */
export function downloadBackup(text: string): void {
  const blob = new Blob([text], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "ppm-accounts-backup.json";
  a.click();
  URL.revokeObjectURL(a.href);
}
