/**
 * Whether the Android entry should surface at all.
 *
 * Hidden only when the host opted out — `ANDROID_EMULATOR_ENABLED` is unset, so `/capabilities`
 * answers `enabled: false`. Everything the user can fix in place (no SDK, no AVD, no KVM) keeps
 * the entry visible, because the device list is what explains which of those it is; hiding it
 * would answer "why is there no Android?" with silence.
 *
 * Unlike Remote Desktop this feature is **off by default**: it spawns a VM, and a host that
 * happens to have an Android SDK installed has not thereby asked PPM to run emulators on it.
 */
import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";

interface Capabilities { enabled: boolean; authRequired: boolean }

export function useAndroidAvailable(): { available: boolean; authRequired: boolean } {
  const [caps, setCaps] = useState<Capabilities | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.get<Capabilities>("/api/android/capabilities")
      .then((c) => { if (!cancelled) setCaps(c); })
      .catch(() => { /* an older server has no such route; the entry stays hidden */ });
    return () => { cancelled = true; };
  }, []);

  return { available: !!caps?.enabled, authRequired: !!caps?.authRequired };
}
