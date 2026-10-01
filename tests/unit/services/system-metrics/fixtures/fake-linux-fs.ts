import type { LinuxFs } from "../../../../../src/services/system-metrics/linux-fs.ts";

export interface FakeFsSpec {
  /** Absolute path → file contents. */
  files?: Record<string, string>;
  /** Absolute directory path → entry names. */
  dirs?: Record<string, string[]>;
  /** Absolute symlink path → its target as written. */
  links?: Record<string, string>;
  /** Absolute path → fully resolved path. Defaults to the path itself. */
  real?: Record<string, string>;
  /** Extra paths that exist but hold nothing (an empty `slaves`, a `partition`). */
  present?: string[];
}

/** An in-memory `/proc` + `/sys`. Anything not listed is missing, which is what
 *  the real reader reports for an unreadable or absent file. */
export function fakeLinuxFs(spec: FakeFsSpec): LinuxFs {
  const { files = {}, dirs = {}, links = {}, real = {}, present = [] } = spec;
  return {
    read: (p) => files[p] ?? null,
    list: (p) => dirs[p] ?? null,
    readlink: (p) => links[p] ?? null,
    realpath: (p) => real[p] ?? (exists(p) ? p : null),
    exists,
  };

  function exists(p: string): boolean {
    return p in files || p in dirs || p in links || p in real || present.includes(p);
  }
}
