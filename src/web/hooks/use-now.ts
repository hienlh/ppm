import { useEffect, useState } from "react";

/**
 * The current time, re-read every `intervalMs` while `active` — for a countdown that has to move
 * on screen. Inactive, it neither ticks nor re-renders.
 */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}
