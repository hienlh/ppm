import { getDeviceId } from "./device-id";

/**
 * Tells the server this device's IANA zone over `/ws/extensions`, for extensions that show or
 * schedule things for the person (`vscode.env.clientTimeZone`): the host's own zone can be
 * another country's. Sent each time the socket connects, and again when the page comes back
 * into view with a different zone, which is when travel shows up.
 */

/** This device's IANA zone, or null where `Intl` cannot say. */
export function deviceTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === "string" && zone ? zone : null;
  } catch {
    return null;
  }
}

export interface TimeZoneReporterDeps {
  zone(): string | null;
  deviceId(): string;
  /** Subscribe to "the page may be back in front of the person"; returns the unsubscribe. */
  onResume(listener: () => void): () => void;
}

const defaultDeps: TimeZoneReporterDeps = {
  zone: deviceTimeZone,
  deviceId: getDeviceId,
  onResume(listener) {
    const onVisible = () => { if (document.visibilityState === "visible") listener(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", listener);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", listener);
    };
  },
};

export function createTimeZoneReporter(send: (json: string) => void, deps: TimeZoneReporterDeps = defaultDeps) {
  let lastSent: string | null = null;
  let connected = false;

  const report = (zone: string | null) => {
    if (!zone) return;
    lastSent = zone;
    send(JSON.stringify({ type: "client:timezone", timeZone: zone, deviceId: deps.deviceId() }));
  };

  const stopWatching = deps.onResume(() => {
    if (!connected) return;
    const zone = deps.zone();
    if (zone && zone !== lastSent) report(zone);
  });

  return {
    /** Call when the socket opens: a restarted server has forgotten the zone. */
    onConnectionChange(isConnected: boolean): void {
      connected = isConnected;
      if (isConnected) report(deps.zone());
    },
    dispose(): void {
      connected = false;
      stopWatching();
    },
  };
}
