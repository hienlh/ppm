/**
 * The single titlebar every floating window wears, whatever its kind.
 *
 * It resolves the active OS skin (Settings override, otherwise the host platform) and
 * delegates to that skin's chrome, so an explorer, a system monitor, a team-member session
 * and a detached tab are visually the same window — the complaint that produced this file
 * was two kinds shipping two different titlebars.
 *
 * `FloatingWindow` renders the chrome directly with no `<Suspense>` around it, so this entry
 * point cannot be `lazy()` the way a window body is: it has to resolve synchronously, which
 * is exactly what a small wrapper component (rather than a whole feature body) affords.
 */

import { useExplorerSkin } from "@/components/os-explorer/skins/use-explorer-skin";
import type { WindowChromeProps } from "./window-chrome-contract";

export function WindowSkinChrome(props: WindowChromeProps) {
  const skin = useExplorerSkin();
  const Chrome = skin.chrome;
  return <Chrome {...props} />;
}
