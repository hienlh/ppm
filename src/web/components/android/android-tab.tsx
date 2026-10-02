/**
 * The Android tab: a device picker until one is chosen, then that device's screen.
 *
 * The choice lives in the tab's metadata rather than in component state so it survives the tab
 * pool unmounting and remounting the body, and so a reload reopens the same device. It is pinned
 * to `avdId` — the stable identity — with `deviceId` alongside it as the *runtime* one: an
 * emulator that restarts gets a new deviceId, and the tab then shows the picker again rather
 * than pointing a session at a process that no longer exists.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { useTabStore } from "@/stores/tab-store";
import { AndroidDeviceList, type DeviceRow } from "./android-device-list";
import { AndroidViewer } from "./android-viewer";

export interface AndroidTabProps {
  metadata?: Record<string, unknown>;
  tabId?: string;
}

export function AndroidTab({ metadata, tabId }: AndroidTabProps) {
  const updateTab = useTabStore((s) => s.updateTab);
  const avdId = typeof metadata?.avdId === "string" ? metadata.avdId : null;

  const [device, setDevice] = useState<DeviceRow | null>(null);
  const [checking, setChecking] = useState(avdId !== null);

  // Resolve the pinned AVD to a *running* device on mount. A deviceId from a previous session
  // names a pid that may be long gone, so it is never trusted — only re-derived.
  useEffect(() => {
    if (!avdId) { setChecking(false); return; }
    let cancelled = false;
    void (async () => {
      try {
        const { devices } = await api.get<{ devices: DeviceRow[] }>("/api/android/devices");
        if (cancelled) return;
        setDevice(devices.find((d) => d.avdId === avdId && d.runtime !== null) ?? null);
      } catch {
        if (!cancelled) setDevice(null);
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => { cancelled = true; };
  }, [avdId]);

  const open = useCallback((row: DeviceRow) => {
    setDevice(row);
    if (tabId) updateTab(tabId, { title: row.name, metadata: { ...metadata, avdId: row.avdId } });
  }, [tabId, updateTab, metadata]);

  const back = useCallback(() => {
    setDevice(null);
    if (tabId) updateTab(tabId, { title: "Android", metadata: { ...metadata, avdId: undefined } });
  }, [tabId, updateTab, metadata]);

  if (checking) return <div className="h-full" />;

  if (!device?.runtime) {
    return <AndroidDeviceList onOpen={open} />;
  }

  // The header is the viewer's own: it carries the app tools beside the device name, and two
  // header rows stacked would cost a phone a fifth of the picture.
  return <AndroidViewer deviceId={device.runtime.deviceId} deviceName={device.name} onBack={back} />;
}
