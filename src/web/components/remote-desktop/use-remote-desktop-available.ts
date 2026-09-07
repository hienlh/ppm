/**
 * Fetches remote-desktop capabilities once and reports whether the feature should surface in
 * the UI. Returns `available=false` when the server feature flag is off (the endpoint 404s) or
 * video capture is unavailable, so the nav entry stays hidden unless `REMOTE_DESKTOP_ENABLED`
 * is set and ffmpeg can capture.
 */
import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";

interface Capabilities {
  ffmpegAvailable: boolean;
  videoAvailable: boolean;
  inputAvailable: boolean;
  authRequired: boolean;
}

export function useRemoteDesktopAvailable(): { available: boolean; authRequired: boolean } {
  const [caps, setCaps] = useState<Capabilities | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get<Capabilities>("/api/remote-desktop/capabilities")
      .then((c) => { if (!cancelled) setCaps(c); })
      .catch(() => { if (!cancelled) setCaps(null); }); // 404 (flag off) or network error — stay hidden
    return () => { cancelled = true; };
  }, []);

  return { available: !!caps?.videoAvailable, authRequired: !!caps?.authRequired };
}
