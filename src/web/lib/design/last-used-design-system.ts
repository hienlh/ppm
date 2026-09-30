/**
 * Which app the New Design dialog preselects, remembered per project on this device only
 * (like `lspEnabled`) — the choice is a UI convenience, not something worth a server round
 * trip or syncing across devices.
 */
const KEY_PREFIX = "ppm-design-last-system:";

export function getLastUsedDesignSystem(projectName: string): string | null {
  try {
    return localStorage.getItem(KEY_PREFIX + projectName);
  } catch {
    return null;
  }
}

export function setLastUsedDesignSystem(projectName: string, systemId: string): void {
  try {
    localStorage.setItem(KEY_PREFIX + projectName, systemId);
  } catch {
    // Storage may be unavailable (private mode, quota); the picker just falls back to "default".
  }
}
