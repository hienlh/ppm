/**
 * App id to an icon file on disk, for the icon route.
 *
 * The security property lives here rather than in the route: the caller supplies
 * an APP ID, this looks up that app, and only the file that app's own metadata
 * pointed at is ever returned. There is no request shape that names a file, so
 * the route cannot become an arbitrary file read.
 *
 * Linux: the id is a desktop entry, and its Icon resolves through the icon themes.
 * Both caches are lazy and built once, so a host where nobody opens the Apps page
 * pays nothing: the entry scan measured 9 ms and the icon index 100 ms here.
 *
 * macOS: the id is a bundle the last tick listed, and the file is a PNG converted
 * from that bundle's own icon. An app no tick listed has no icon to ask for.
 */
import { join } from "node:path";
import { realLinuxFs, type LinuxFs } from "../system-metrics/linux-fs.ts";
import { getPpmDir } from "../ppm-dir.ts";
import { createLinuxAppCollector } from "./apps-linux.ts";
import { darwinAppCollector, type DarwinAppCollector } from "./apps-darwin.ts";
import { createIconResolver } from "./app-icons-linux.ts";
import { createDarwinIconConverter, type DarwinIconConverter } from "./app-icons-darwin.ts";

export interface AppIconService {
  /** Absolute path to the icon file, or null when the app or its icon is unknown. */
  path(appId: string): string | null | Promise<string | null>;
}

const isAppId = (id: string) => id !== "" && !id.includes("/") && !id.includes("..");

export function createAppIconService(platform: NodeJS.Platform = process.platform): AppIconService {
  return platform === "darwin" ? createDarwinAppIconService() : createLinuxAppIconService();
}

export function createLinuxAppIconService(fs: LinuxFs = realLinuxFs): AppIconService {
  const apps = createLinuxAppCollector(fs);
  const icons = createIconResolver(fs);
  return {
    path(appId: string): string | null {
      if (!isAppId(appId)) return null;
      const entry = apps.entries().get(appId);
      return entry ? icons.resolve(entry.icon) : null;
    },
  };
}

export function createDarwinAppIconService(
  apps: Pick<DarwinAppCollector, "iconSource"> = darwinAppCollector(),
  icons: DarwinIconConverter = createDarwinIconConverter(join(getPpmDir(), "app-icons")),
): AppIconService {
  return {
    async path(appId: string): Promise<string | null> {
      const source = isAppId(appId) ? apps.iconSource(appId) : null;
      return source ? icons.png(source.bundle, source.iconPath) : null;
    },
  };
}
