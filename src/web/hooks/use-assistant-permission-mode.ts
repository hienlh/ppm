/**
 * The PPM Assistant's permission mode (Full or Ask) for the Settings pane and the Assistant
 * window's quick switch. Both read it here, and a change made in one is announced to the other on
 * this page (`MODE_CHANGED_EVENT`), so the window's button and Settings never disagree.
 *
 * `null` while loading; "unset" when the user has not chosen yet, which the server treats as Ask.
 */
import { useCallback, useEffect, useState } from "react";
import { getAssistantSettings, patchAssistantSettings } from "@/lib/assistant-settings-api";
import type { AssistantPermissionMode } from "../../shared/assistant-settings";

export type PermissionModeState = AssistantPermissionMode | "unset";

const MODE_CHANGED_EVENT = "ppm:assistant-permission-mode";

/** Turns a mode read from the server into the hook's state. */
export function modeState(mode: AssistantPermissionMode | undefined): PermissionModeState {
  return mode === "full" || mode === "ask" ? mode : "unset";
}

/** Tells every mounted copy of the hook on this page. */
export function announcePermissionMode(mode: PermissionModeState): void {
  window.dispatchEvent(new CustomEvent<PermissionModeState>(MODE_CHANGED_EVENT, { detail: mode }));
}

export function useAssistantPermissionMode(): {
  mode: PermissionModeState | null;
  setMode: (mode: AssistantPermissionMode) => Promise<void>;
  saving: boolean;
} {
  const [mode, setModeState] = useState<PermissionModeState | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    getAssistantSettings()
      .then((res) => { if (live) setModeState(modeState(res.settings.permission_mode)); })
      .catch(() => { if (live) setModeState("unset"); });
    const onChange = (e: Event) => setModeState((e as CustomEvent<PermissionModeState>).detail);
    window.addEventListener(MODE_CHANGED_EVENT, onChange);
    return () => { live = false; window.removeEventListener(MODE_CHANGED_EVENT, onChange); };
  }, []);

  const setMode = useCallback(async (next: AssistantPermissionMode) => {
    setSaving(true);
    try {
      const res = await patchAssistantSettings({ permission_mode: next });
      announcePermissionMode(modeState(res.settings.permission_mode));
    } finally {
      setSaving(false);
    }
  }, []);

  return { mode, setMode, saving };
}
