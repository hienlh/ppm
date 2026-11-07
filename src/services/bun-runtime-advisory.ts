/**
 * Bun releases with a defect PPM cannot work around in its own code, and what to tell the user.
 *
 * Bun before 1.3.11 on Windows never closes the handle of a JavaScriptCore helper thread. Those
 * threads exit after 10 s idle and come back with the next bit of work, so any PPM process that
 * wakes on a timer (every one of them) recreates and leaks a few every minute. Measured on the
 * supervisor after 37 hours on 1.3.10: 7,352 `Thread` handles with 17 threads alive, and private
 * bytes at 15.4 GB against a 1.4 GB working set — 484 fully committed 32 MB allocator segments,
 * growing ~400 MB an hour until the machine ran out of commit. A script that does nothing but
 * sleep in 15 s gaps leaks 7–8 handles a cycle on 1.2.23, 1.3.9 and 1.3.10, and none on 1.3.11,
 * 1.3.12, 1.3.13, 1.3.14, 1.4.0 or 1.4.4, so the only fix is the runtime: `bun upgrade`.
 */

/** First release measured clean, per platform where older ones were measured to leak. */
const FIXED_IN: Partial<Record<NodeJS.Platform, string>> = {
  win32: "1.3.11",
};

/** A warning for `ppm.log` when this runtime is known to leak, else null. */
export function bunRuntimeAdvisory(
  version: string = Bun.version,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const fixedIn = FIXED_IN[platform];
  if (!fixedIn || Bun.semver.order(version, fixedIn) >= 0) return null;
  return `Bun ${version} on Windows leaks a thread handle and allocator memory every time an idle ` +
    `helper thread exits, so this process grows by about 400 MB an hour for as long as it runs. ` +
    `Run \`bun upgrade\` (${fixedIn} and later are fixed), then restart PPM.`;
}
