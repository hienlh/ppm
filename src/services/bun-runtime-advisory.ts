/**
 * Bun releases with a defect PPM cannot work around in its own code, and what to tell the user.
 *
 * Two Windows leaks, both from JavaScriptCore helper threads that exit after 10 s idle and come
 * back with the next bit of work, so any PPM process that wakes on a timer (every one of them)
 * hits them all day:
 *
 * - Before 1.3.11 the thread's handle is never closed either. Measured on the supervisor after 37
 *   hours on 1.3.10: 7,352 `Thread` handles with 17 threads alive and 15.4 GB of private bytes, about
 *   400 MB an hour. A script that only sleeps in 15 s gaps leaks 7–8 handles a cycle on 1.2.23,
 *   1.3.9 and 1.3.10 and none from 1.3.11 on.
 * - Up to at least 1.3.12 a fully committed 32 MB allocator block is kept anyway, with the handle
 *   count flat. Measured 23/11/2026, two scratch PPM stacks side by side for 3.8 hours under the same
 *   light load: on 1.3.12 the supervisor grew 150 MB/h, the edge 236 MB/h and the server 108 MB/h;
 *   on 1.4.4 all three were flat (within ±1 MB/h) and started at half the size or less. Live, the
 *   supervisor and server reached 7.9 GB each after 30 hours. 1.3.13–1.4.3 were not measured, so
 *   they count as leaking.
 *
 * The only fix is the runtime: `bun upgrade`. `scripts/release.sh` refuses to build with a
 * runtime this answers for, because `bun build --compile` embeds the builder's own Bun.
 */

/** First release measured clean, per platform where older ones were measured to leak. */
const FIXED_IN: Partial<Record<NodeJS.Platform, string>> = {
  win32: "1.4.4",
};

/** First Windows release that closes the helper threads' handles (the allocator leak remains). */
const HANDLE_LEAK_FIXED_IN = "1.3.11";

/** A warning for `ppm.log` (and `ppm start`) when this runtime is known to leak, else null. */
export function bunRuntimeAdvisory(
  version: string = Bun.version,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const fixedIn = FIXED_IN[platform];
  if (!fixedIn || Bun.semver.order(version, fixedIn) >= 0) return null;
  const leak = Bun.semver.order(version, HANDLE_LEAK_FIXED_IN) < 0
    ? "leaks a thread handle and a 32 MB allocator block every time an idle helper thread exits, " +
      "so each PPM process grows by about 400 MB an hour for as long as it runs"
    : "keeps a 32 MB allocator block every time an idle helper thread exits, " +
      "so each PPM process grows by about 100–250 MB an hour for as long as it runs";
  return `Bun ${version} on Windows ${leak}. ` +
    `Run \`bun upgrade\` (${fixedIn} and later are fixed), then restart PPM with \`ppm stop --kill\` and \`ppm start\`.`;
}
