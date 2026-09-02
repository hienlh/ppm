/**
 * Resolves which skin an explorer window should wear: the user's Settings override when
 * set, otherwise the host `platform` — Linux gets the macOS look since there is no single
 * dominant Linux file-manager chrome to imitate (same call the plan made for pinned
 * folders and known folders).
 */

import { useSettingsStore } from "@/stores/settings-store";
import { useHostInfo } from "../use-host-info";
import { macosSkin } from "./macos-skin";
import type { ExplorerSkin } from "./skin-types";
import { windowsSkin } from "./windows-skin";

export function useExplorerSkin(): ExplorerSkin {
  const override = useSettingsStore((s) => s.explorerSkin);
  const { host } = useHostInfo();

  if (override === "windows") return windowsSkin;
  if (override === "macos") return macosSkin;
  return host?.platform === "win32" ? windowsSkin : macosSkin;
}
