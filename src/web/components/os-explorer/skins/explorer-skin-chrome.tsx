/**
 * The one thing `window-content-registry.ts` needs to import to give explorer windows a
 * skinned titlebar: a plain (non-lazy) component matching `WindowChromeProps` that picks
 * the current skin and delegates to its real chrome. `FloatingWindow` renders `chrome`
 * directly with no `<Suspense>` around it, so this entry point cannot be `lazy()` the way
 * the window body is — it has to resolve synchronously, which is exactly what a small
 * wrapper component (rather than the whole explorer body) affords.
 */

import type { WindowChromeProps } from "@/components/floating-window/window-chrome-contract";
import { useExplorerSkin } from "./use-explorer-skin";

export function ExplorerSkinChrome(props: WindowChromeProps) {
  const skin = useExplorerSkin();
  const Chrome = skin.chrome;
  return <Chrome {...props} />;
}
