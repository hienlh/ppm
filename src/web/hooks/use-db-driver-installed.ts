import { useEffect, useRef } from "react";
import { DB_DRIVER_INSTALLED_EVENT } from "@/lib/db-drivers";

/**
 * Call `onInstalled` with a driver's id whenever one is installed in this tab — from Settings or
 * from any Install notice — so a view waiting on it recovers without a second press.
 */
export function useDbDriverInstalled(onInstalled: (driverId: string) => void): void {
  const latest = useRef(onInstalled);
  useEffect(() => { latest.current = onInstalled; });
  useEffect(() => {
    const listener = (e: Event) => latest.current((e as CustomEvent<string>).detail);
    window.addEventListener(DB_DRIVER_INSTALLED_EVENT, listener);
    return () => window.removeEventListener(DB_DRIVER_INSTALLED_EVENT, listener);
  }, []);
}
