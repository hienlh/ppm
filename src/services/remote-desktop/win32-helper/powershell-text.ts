/**
 * Helpers for PowerShell text that PPM generates and hands to an elevated or SYSTEM process.
 * Every value that reaches such a script goes through one of these, never string concatenation.
 */

/** A PowerShell single-quoted literal. PowerShell also treats the typographic quotes
 *  U+2018–U+201B as single quotes, so they are doubled too — a path like `C:\Users\O’Brien`
 *  would otherwise end the literal early. */
export function psQuote(value: string): string {
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
}

/** `-EncodedCommand` takes base64 of the UTF-16LE script. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** A local or domain account SID (`S-1-5-21-a-b-c-rid`). Built-in and service accounts are
 *  refused: the helper exists for one interactive user and nobody else. */
export function isUserSid(sid: string): boolean {
  return /^S-1-5-21(?:-\d{1,10}){4}$/.test(sid);
}

/** `whoami /user /fo csv /nh` → the SID, or null. Output is `"host\user","S-1-5-…"`; the
 *  header row is suppressed, so the parse does not depend on the display language. */
export function parseWhoamiUserCsv(output: string): string | null {
  const line = output.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return null;
  const fields = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, "\""));
  const sid = fields.at(-1) ?? "";
  return isUserSid(sid) ? sid : null;
}

/** Scripts written to disk for Windows PowerShell 5.1 must be ASCII: 5.1 reads a BOM-less file
 *  in the system code page, so anything else would be read differently than it was hashed. */
export function isAscii(text: string): boolean {
  return /^[\x00-\x7f]*$/.test(text);
}
