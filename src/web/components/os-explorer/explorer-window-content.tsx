/**
 * `WINDOW_CONTENT["explorer"]` — the adapter between the generic floating-window frame and
 * the explorer body.
 *
 * It owns only two things the body should not care about: turning the window payload into
 * a starting path, and dropping the window's slice when the window closes.
 */

import { useEffect } from "react";
import type { WindowContentProps } from "@/components/floating-window/window-content-registry";
import { ExplorerBody } from "./explorer-body";
import { useExplorerStore } from "./explorer-store";
import { cachedHomedir, useHostInfo } from "./use-host-info";

export default function ExplorerWindowContent({ id, payload }: WindowContentProps) {
  const { host, error } = useHostInfo();
  const discard = useExplorerStore((s) => s.discard);

  // A window's state is per-window; leaving it behind would leak one slice per open.
  useEffect(() => () => discard(id), [id, discard]);

  const requested = typeof payload?.path === "string" ? payload.path : "";
  // Without a path (or before host info lands) there is nothing safe to browse: "/" does
  // not exist on Windows, so wait for the home directory rather than showing a bogus error.
  const initialPath = requested || cachedHomedir() || host?.homedir || "";

  if (!initialPath) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-xs text-text-2">
        {error ? `Could not reach the host: ${error}` : "Loading…"}
      </div>
    );
  }

  return <ExplorerBody windowId={id} initialPath={initialPath} />;
}
