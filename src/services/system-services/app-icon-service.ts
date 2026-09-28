/**
 * App id to an icon file on disk, for the icon route.
 *
 * The security property lives here rather than in the route: the caller supplies
 * an APP ID, this looks up that id's desktop entry, and only the path that
 * entry's own Icon resolved to is ever returned. There is no request shape that
 * names a file, so the route cannot become an arbitrary file read.
 *
 * Both caches are lazy and built once, so a host where nobody opens the Apps page
 * pays nothing: the entry scan measured 9 ms and the icon index 100 ms here.
 */
import { realLinuxFs, type LinuxFs } from "../system-metrics/linux-fs.ts";
import { createLinuxAppCollector } from "./apps-linux.ts";
import { createIconResolver } from "./app-icons-linux.ts";

export interface AppIconService {
  /** Absolute path to the icon file, or null when the app or its icon is unknown. */
  path(appId: string): string | null;
}

export function createAppIconService(fs: LinuxFs = realLinuxFs): AppIconService {
  const apps = createLinuxAppCollector(fs);
  const icons = createIconResolver(fs);
  return {
    path(appId: string): string | null {
      if (!appId || appId.includes("/") || appId.includes("..")) return null;
      const entry = apps.entries().get(appId);
      return entry ? icons.resolve(entry.icon) : null;
    },
  };
}
