/**
 * OpenGL and Vulkan versions for the GPU page. Both come from a one-shot tool
 * and neither ever changes while the machine is up, so the result is cached for
 * the process lifetime and the tools are never spawned from a tick.
 *
 * `eglinfo` is asked with `EGL_PLATFORM=surfaceless`, which is what lets this
 * answer at all on a headless host or from a systemd unit with no display —
 * `glxinfo` needs an X connection and would simply fail there.
 */
import type { Runner } from "../host-info/spawn-runner.ts";
import { defaultRunner } from "../host-info/spawn-runner.ts";

/** `env` carries the platform override because the shared `Runner` takes an argv
 *  and no environment — and without it `eglinfo` needs a display, which a PPM
 *  started from a systemd unit does not have. */
export const EGLINFO_ARGV = ["env", "EGL_PLATFORM=surfaceless", "eglinfo"];
export const VULKANINFO_ARGV = ["vulkaninfo", "--summary"];
const SPAWN_TIMEOUT_MS = 8000;

export interface GpuApiVersions {
  /** Highest context the driver offers: "4.6", or "ES 3.2" when that is all. */
  opengl?: string;
  /** Vulkan API version, e.g. "1.4.354". */
  vulkan?: string;
  /** Mesa's own version, which is the meaningful "driver version" for i915,
   *  xe and amdgpu — none of those modules publish one in sysfs. */
  mesa?: string;
}

/** "OpenGL core profile version string: 4.6 (Core Profile) Mesa 26.2.2" → "4.6".
 *  A driver with no desktop GL at all reports its ES version instead, which is
 *  what Mission Center shows for those. */
export function parseOpenglVersion(text: string): string | undefined {
  const core = /^OpenGL core profile version(?: string)?:\s*(\d+\.\d+)/m.exec(text);
  if (core) return core[1];
  const compat = /^OpenGL version(?: string)?:\s*(\d+\.\d+)/m.exec(text);
  if (compat) return compat[1];
  const es = /^OpenGL ES profile version(?: string)?:\s*OpenGL ES (\d+\.\d+)/m.exec(text);
  return es ? `ES ${es[1]}` : undefined;
}

/** `vulkaninfo --summary` prints one `apiVersion = 1.4.354` per device; the
 *  highest is what the machine supports. */
export function parseVulkanVersion(text: string): string | undefined {
  const versions = [...text.matchAll(/apiVersion\s*[=:]\s*(?:0x[0-9a-f]+\s*\()?(\d+\.\d+\.\d+)/gi)]
    .map((m) => m[1]!)
    .sort(compareVersions);
  return versions.at(-1);
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The Mesa build out of an OpenGL version line: "OpenGL core profile version:
 *  4.6 (Core Profile) Mesa 26.2.2-arch3.2" -> "Mesa 26.2.2-arch3.2".
 *
 *  Anchored to that line on purpose. eglinfo also prints "EGL vendor string: Mesa
 *  Project" much earlier, so an unanchored search reports the version as
 *  "Mesa Project" — well-formed, plausible, and wrong. */
export function parseMesaVersion(text: string): string | undefined {
  const m = /^OpenGL [^\n]*version(?: string)?:[^\n]*\bMesa ([\w.+-]+)/m.exec(text);
  return m ? `Mesa ${m[1]}` : undefined;
}

export interface GpuApiVersionReader {
  read(): Promise<GpuApiVersions>;
}

export function createGpuApiVersionReader(run: Runner = defaultRunner): GpuApiVersionReader {
  let cached: Promise<GpuApiVersions> | null = null;
  return {
    read() {
      // One in-flight promise, reused forever: two windows opening at once must
      // not spawn `vulkaninfo` twice, and the answer cannot change afterwards.
      cached ??= probe(run);
      return cached;
    },
  };
}

async function probe(run: Runner): Promise<GpuApiVersions> {
  const [gl, vk] = await Promise.all([
    tryRun(run, EGLINFO_ARGV),
    tryRun(run, VULKANINFO_ARGV),
  ]);
  return {
    ...(gl ? optional("opengl", parseOpenglVersion(gl)) : {}),
    ...(gl ? optional("mesa", parseMesaVersion(gl)) : {}),
    ...(vk ? optional("vulkan", parseVulkanVersion(vk)) : {}),
  };
}

/**
 * A missing tool is not an error worth surfacing — the page hides the row.
 *
 * The exit code is deliberately NOT a gate. `eglinfo` sweeps every EGL platform
 * it knows and exits 1 when any of them fails, which on a headless host means
 * every run — while still printing a complete, correct surfaceless report to
 * stdout. Gating on the code threw away 2784 good lines and left the OpenGL row
 * permanently blank. Output is the signal; the parsers reject anything else.
 */
async function tryRun(run: Runner, argv: readonly string[]): Promise<string | null> {
  try {
    const r = await run([...argv], SPAWN_TIMEOUT_MS);
    return !r.timedOut && r.stdout.trim() ? r.stdout : null;
  } catch {
    return null;
  }
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}
