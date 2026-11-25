/** JSON written by PowerShell: tolerant of a UTF-8 BOM and of a missing or half-written file. */
export function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  try { return JSON.parse(text.replace(/^﻿/, "")) as T; } catch { return null; }
}
