/**
 * What the browser and the host both have to agree on when making an AVD.
 *
 * The name rule lives here rather than in the service because the create form validates as you
 * type: a second copy of the regex in the browser is a validator that drifts, and the way it
 * drifts is the form accepting a name the host then refuses — after the dialog has closed.
 */

/**
 * The names `avdmanager` accepts without quoting.
 *
 * It does accept spaces (`Galaxy Nexus` is a stock profile id), but an AVD name becomes a
 * **directory name** and part of a `-avd` argument, so anything that needs quoting is refused
 * here rather than escaped — the plan's "no shell string" rule read forwards.
 */
export const AVD_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export function validateAvdName(name: string): string | null {
  if (!AVD_NAME_PATTERN.test(name)) {
    return "use 1–63 letters, digits, dots, dashes or underscores, starting with a letter or digit";
  }
  return null;
}

/** Bounds that keep a typo from asking the host for more than it has. */
export const AVD_LIMITS = {
  ramMb: { min: 512, max: 16 * 1024, default: 2048 },
  storageMb: { min: 1024, max: 128 * 1024, default: 6144 },
  sdCardMb: { min: 0, max: 32 * 1024, default: 512 },
} as const;

export interface AvdDeviceProfile {
  /** What `--device` takes, e.g. `pixel_9` or `medium_tablet`. */
  id: string;
  name: string;
  oem: string;
  /** Present on a minority of entries; `pixel_9` has none. */
  tag: string | null;
  /** Best-effort from the name, so the picker can group phones and tablets. */
  kind: "phone" | "tablet" | "tv" | "wear" | "automotive" | "desktop" | "other";
}

export interface CreateAvdRequest {
  name: string;
  /** A `system-images;…` id the host reported as installed. */
  systemImage: string;
  /** A `--device` id the host reported. */
  deviceProfile: string;
  ramMb?: number;
  /** Internal storage, i.e. `disk.dataPartition.size`. */
  storageMb?: number;
  sdCardMb?: number;
}
