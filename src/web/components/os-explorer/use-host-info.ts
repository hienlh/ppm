/**
 * Host facts (platform, separator, home, drives, known folders, OS pins) for the sidebar.
 *
 * Every explorer window needs the same answer, and the server call spawns PowerShell /
 * plutil / findmnt, so the result is cached module-wide and the in-flight promise is
 * shared: N windows opening at once produce exactly one request.
 */

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import type { HostInfo } from "../../../types/system";

const CACHE_TTL_MS = 60_000;

let cached: { at: number; value: HostInfo } | null = null;
let inFlight: Promise<HostInfo> | null = null;
const subscribers = new Set<(value: HostInfo) => void>();

function fetchHostInfo(): Promise<HostInfo> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return Promise.resolve(cached.value);
  if (inFlight) return inFlight;
  inFlight = api
    .get<HostInfo>("/api/system/host")
    .then((value) => {
      cached = { at: Date.now(), value };
      for (const notify of subscribers) notify(value);
      return value;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export interface HostInfoState {
  host: HostInfo | null;
  loading: boolean;
  error: string | null;
}

export function useHostInfo(): HostInfoState {
  const [state, setState] = useState<HostInfoState>(() => ({
    host: cached?.value ?? null,
    loading: cached == null,
    error: null,
  }));

  useEffect(() => {
    let alive = true;
    const notify = (value: HostInfo) => {
      if (alive) setState({ host: value, loading: false, error: null });
    };
    subscribers.add(notify);
    fetchHostInfo()
      .then(notify)
      .catch((e: unknown) => {
        if (alive) {
          setState({
            host: null,
            loading: false,
            error: e instanceof Error ? e.message : "Failed to read host info",
          });
        }
      });
    return () => {
      alive = false;
      subscribers.delete(notify);
    };
  }, []);

  return state;
}

/**
 * Host info for callers outside React (command palette, nav rail): resolves from cache
 * when warm, otherwise fetches. Used to pick a sensible starting directory.
 */
export function getHostInfo(): Promise<HostInfo> {
  return fetchHostInfo();
}

/** Best-effort home directory without waiting for the server. */
export function cachedHomedir(): string | null {
  return cached?.value.homedir ?? null;
}
