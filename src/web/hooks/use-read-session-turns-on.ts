/**
 * Whether `read_session_turns` is on in Settings → Tools. A turn chip sends either way; with the
 * tool off it warns that the AI will see the reference and not be able to read the turn.
 *
 * Read once and shared by every chip on the page, refreshed when a composer chip mounts after the
 * answer has gone stale, so turning the tool back on is noticed without a reload. Until the first
 * answer arrives the tool counts as on, so a chip never flashes a warning it turns out not to need.
 */
import { useEffect, useState } from "react";
import { getAISettings } from "@/lib/api-settings";
import { ppmToolOn } from "../../shared/ppm-tools";
import { READ_SESSION_TURNS_TOOL } from "../../shared/session-history-tools";

const STALE_MS = 30_000;

let known: { on: boolean; at: number } | null = null;
let inFlight: Promise<boolean> | null = null;
const listeners = new Set<(on: boolean) => void>();

function refresh(): Promise<boolean> {
  inFlight ??= getAISettings()
    .then((settings) => ppmToolOn(settings, READ_SESSION_TURNS_TOOL))
    .catch(() => known?.on ?? true)
    .then((on) => {
      known = { on, at: Date.now() };
      for (const listener of listeners) listener(on);
      return on;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

export function useReadSessionTurnsOn(): boolean {
  const [on, setOn] = useState(() => known?.on ?? true);
  useEffect(() => {
    listeners.add(setOn);
    if (!known || Date.now() - known.at > STALE_MS) void refresh();
    else setOn(known.on);
    return () => { listeners.delete(setOn); };
  }, []);
  return on;
}

/** Test hook: forget the cached answer. */
export function resetReadSessionTurnsCache(): void {
  known = null;
  inFlight = null;
}
