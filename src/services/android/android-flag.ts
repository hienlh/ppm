/**
 * Feature switch. Android emulator support is **off by default** — unlike Remote Desktop, which
 * ships on, because this surface spawns multi-gigabyte emulator processes on the host and most
 * PPM installs have no Android SDK at all. `ANDROID_EMULATOR_ENABLED=1` (or `true`) turns it on.
 *
 * Every entry point (REST routes, WS upgrade) checks this independently rather than trusting a
 * single call site to stay correct as routing evolves — same rule as `remote-desktop-flag.ts`.
 */
export function isAndroidEmulatorEnabled(): boolean {
  const v = process.env.ANDROID_EMULATOR_ENABLED?.trim().toLowerCase();
  return v === "1" || v === "true";
}
