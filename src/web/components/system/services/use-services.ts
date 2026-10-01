/**
 * The Services page's data: a poll, not a stream.
 *
 * The list costs two `systemctl` spawns per scope, so it rides its own timer at
 * SERVICES_POLL_INTERVAL_MS while the page is visible rather than being folded
 * into the 2 s metrics tick — a status bar on every page must not spawn anything.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, getAuthToken } from "@/lib/api-client";
import type {
  ServiceAction, ServiceActionResult, ServiceDetails, ServicesSnapshot, ServiceScope,
} from "../../../../types/system-services";
import { SERVICES_POLL_INTERVAL_MS } from "../../../../types/system-services";

/**
 * `api.post` cannot add the `X-PPM-Request` header the mutating routes require
 * (CSRF hardening for the auth-disabled configuration), so this mirrors
 * `killProcess`: a raw fetch with the same single-Error-on-any-failure contract.
 */
export async function runServiceAction(
  scope: ServiceScope,
  unit: string,
  action: ServiceAction,
): Promise<ServiceActionResult> {
  const token = getAuthToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-PPM-Request": "1",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(
    `/api/system/services/${scope}/${encodeURIComponent(unit)}/${action}`,
    { method: "POST", headers, body: "{}" },
  );
  let json: { ok: boolean; data?: ServiceActionResult; error?: string };
  try {
    json = await res.json();
  } catch {
    throw new Error(res.ok ? "Empty response from server" : `Server error (HTTP ${res.status})`);
  }
  if (json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json.data as ServiceActionResult;
}

export function fetchServiceDetails(scope: ServiceScope, unit: string): Promise<ServiceDetails> {
  return api.get<ServiceDetails>(`/api/system/services/${scope}/${encodeURIComponent(unit)}`);
}

export interface UseServicesResult {
  snapshot: ServicesSnapshot | null;
  error: string | null;
  /** True only before the FIRST answer — a refresh must not blank the list. */
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useServices(active: boolean): UseServicesResult {
  const [snapshot, setSnapshot] = useState<ServicesSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await api.get<ServicesSnapshot>("/api/system/services");
      if (!mounted.current) return;
      setSnapshot(next);
      setError(null);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "Could not list services");
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = setInterval(() => void refresh(), SERVICES_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active, refresh]);

  return { snapshot, error, loading: snapshot === null && error === null, refresh };
}
