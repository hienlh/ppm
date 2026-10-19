import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Cross-platform basename — handles both / and \ separators */
export function basename(filePath: string): string {
  return filePath.split(/[/\\]/).pop() ?? filePath;
}

/**
 * A short random id: 8 characters, not a UUID. Works on plain HTTP, where `crypto.randomUUID`
 * does not exist; `uuidV4()` in `device-id.ts` makes a real one.
 */
export function randomId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}
