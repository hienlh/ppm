import { useEffect, useState } from "react";

/**
 * `Date.now()`, re-read once a minute.
 *
 * Re-read rather than counted: a phone that slept for six hours throttles timers or drops
 * them entirely, so an accumulated tally comes back six hours short — and every caller here
 * is measuring exactly the kind of gap a sleeping device produces.
 *
 * One minute because that is the finest unit any of this is displayed at; a second-resolution
 * tick would re-render the composer sixty times for a label that cannot change.
 */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}
