/**
 * Which host display the viewer is on. Reads the list from `/capabilities`, defaults to the
 * primary, and exposes `next()` for a one-button cycle (mobile toolbar) plus `select()` for a
 * dropdown (desktop). Hosts with a single display never surface a control — `displays.length`
 * tells the caller whether to render one.
 */
import { useCallback, useState } from "react";
import { useRemoteDesktopReadiness, type RemoteDisplay } from "./use-remote-desktop-readiness";

export interface RemoteDesktopDisplayChoice {
  displays: RemoteDisplay[];
  /** undefined until the list arrives or when the pick is the primary — the server treats both as "primary". */
  displayId: string | undefined;
  current: RemoteDisplay | undefined;
  select: (id: string) => void;
  next: () => void;
}

export function useRemoteDesktopDisplayChoice(): RemoteDesktopDisplayChoice {
  const { caps } = useRemoteDesktopReadiness(false);
  const displays = caps?.displays ?? [];
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const current = displays.find((d) => d.id === picked) ?? displays.find((d) => d.primary) ?? displays[0];
  const next = useCallback(() => {
    if (displays.length < 2) return;
    const i = displays.findIndex((d) => d.id === (current?.id));
    setPicked(displays[(i + 1) % displays.length]?.id);
  }, [displays, current]);
  return { displays, displayId: picked, current, select: setPicked, next };
}
