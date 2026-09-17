/**
 * Follow one teammate's work session live, while its window or sheet is open.
 *
 * The window used to read the transcript once and never again, so a teammate
 * that kept working looked frozen on whatever step it was on when the window
 * opened — the only way forward was the manual refresh button. Polling the whole
 * transcript instead is not an option at several MB per member, so each tick
 * asks the server only for the bytes past the offset already consumed and
 * appends the steps they carry.
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import type { ChatEvent } from "../../types/chat";

/** Matches the roster poll's feel without the roster's per-tick directory scan. */
const POLL_INTERVAL_MS = 3_000;
/** Mirrors the server's per-transcript child cap so a long session stays renderable. */
const MAX_EVENTS = 2000;

interface TranscriptSlice {
  events?: ChatEvent[];
  nextBytes?: number;
  restarted?: boolean;
}

export interface MemberTranscriptTail {
  events: ChatEvent[];
  /** True only for the first read — later polls must not blank the view. */
  loading: boolean;
  error: string | null;
  /** Re-read the session from byte zero, for the refresh button. */
  refresh: () => void;
}

export function useMemberTranscriptTail(teamName: string, memberName: string): MemberTranscriptTail {
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped by refresh; re-runs the effect from a clean offset.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!teamName || !memberName) {
      setError("Missing team or member");
      setLoading(false);
      return;
    }

    let cancelled = false;
    // Byte offset consumed so far, and a guard so a slow poll is never doubled.
    let offset = 0;
    let inFlight = false;
    setEvents([]);
    setLoading(true);
    setError(null);

    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      // A read from zero returns the whole file, so it replaces rather than appends
      // — otherwise a refresh would stack a second copy of the session on screen.
      const fromStart = offset === 0;
      try {
        const res = await api.get<TranscriptSlice>(
          `/api/teams/${encodeURIComponent(teamName)}/members/${encodeURIComponent(memberName)}/transcript?sinceBytes=${offset}`,
        );
        if (cancelled) return;
        offset = res?.nextBytes ?? offset;
        const incoming = res?.events ?? [];
        // A rotated transcript also invalidates what is on screen.
        if (fromStart || res?.restarted) setEvents(incoming.slice(-MAX_EVENTS));
        else if (incoming.length > 0) setEvents((prev) => [...prev, ...incoming].slice(-MAX_EVENTS));
        setError(null);
      } catch {
        // Keep the steps already on screen; a transient poll failure is not an
        // empty session. Only the very first read has nothing to fall back on.
        if (!cancelled && fromStart) setError("Could not read this member's session");
      } finally {
        inFlight = false;
        if (!cancelled) setLoading(false);
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [teamName, memberName, reloadKey]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);
  return { events, loading, error, refresh };
}
