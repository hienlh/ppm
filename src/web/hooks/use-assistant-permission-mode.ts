/**
 * The PPM Assistant's permission mode (Full or Ask) for the Settings pane and the Assistant
 * window's quick switch. Every copy follows a change however it was made: on this page
 * (`MODE_CHANGED_EVENT`), on another device or tab (`assistant:permission-mode` from `/ws/global`),
 * or by answering the "PPM has new features" question (`feature-intros:changed`, then a re-read).
 *
 * `null` while loading; "unset" when the user has not chosen yet, which the server treats as Ask.
 */
import { useCallback, useEffect, useState } from "react";
import { getAssistantSettings, patchAssistantSettings } from "@/lib/assistant-settings-api";
import {
  ASSISTANT_PERMISSION_MODE_EVENT, type AssistantPermissionMode, type AssistantPermissionModeEvent,
} from "../../shared/assistant-settings";
import { FEATURE_INTROS_CHANGED_EVENT } from "../../shared/feature-intros";

export type PermissionModeState = AssistantPermissionMode | "unset";

const MODE_CHANGED_EVENT = "ppm:assistant-permission-mode";

/** What switching to Full lets the Assistant do, shown before it is switched on (Settings and the window chip). */
export const FULL_MODE_CONFIRM = "In turns you start, the Assistant will message and open chats, change schedules, projects and git, edit files and run commands without asking. It reads other chats, logs and web pages, and text in them can try to steer it. Pushing, publishing, sending to other people, database writes (unless you tick a connection), the vault and your private folders still ask; turns PPM starts on its own (watch reports, the digest, restart news) never act. Edits become available from the Assistant's next session start.";

/** Turns a mode read from the server into the hook's state. */
export function modeState(mode: AssistantPermissionMode | null | undefined): PermissionModeState {
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
    const read = () => getAssistantSettings()
      .then((res) => { if (live) setModeState(modeState(res.settings.permission_mode)); })
      .catch(() => { if (live) setModeState((m) => m ?? "unset"); });
    void read();
    const onLocal = (e: Event) => setModeState((e as CustomEvent<PermissionModeState>).detail);
    const onServer = (e: Event) => setModeState(modeState((e as CustomEvent<AssistantPermissionModeEvent>).detail?.mode));
    const onIntro = () => { void read(); };
    window.addEventListener(MODE_CHANGED_EVENT, onLocal);
    window.addEventListener(ASSISTANT_PERMISSION_MODE_EVENT, onServer);
    window.addEventListener(FEATURE_INTROS_CHANGED_EVENT, onIntro);
    return () => {
      live = false;
      window.removeEventListener(MODE_CHANGED_EVENT, onLocal);
      window.removeEventListener(ASSISTANT_PERMISSION_MODE_EVENT, onServer);
      window.removeEventListener(FEATURE_INTROS_CHANGED_EVENT, onIntro);
    };
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
