import { useCallback, useEffect, useState } from "react";
import { FEATURE_INTROS_CHANGED_EVENT } from "../../shared/feature-intros";
import {
  fetchVoiceSettings, VOICE_SETTINGS_CHANGED_EVENT, type VoiceSettingsView,
} from "@/lib/voice-message-client";

/**
 * The voice-message settings for a composer: whether the feature is on, whether the transcript
 * waits for review, and whether Whisper is installed.
 *
 * Every chat tab stays mounted, so the answer is shared per project and fetched once rather than
 * once per tab. It is read again when the "PPM has new features" question is answered anywhere
 * (`feature-intros:changed`) or Settings changes it here, so turning the feature on needs no
 * reload. A failed read counts as off: the mic then does exactly what it did before the feature.
 */
const cache = new Map<string, Promise<VoiceSettingsView | null>>();

function load(project: string): Promise<VoiceSettingsView | null> {
  let pending = cache.get(project);
  if (!pending) {
    pending = fetchVoiceSettings(project || undefined).catch(() => {
      // Not cached: the next mount or event tries again instead of keeping "off" for good.
      cache.delete(project);
      return null;
    });
    cache.set(project, pending);
  }
  return pending;
}

/** The event that last emptied the cache: every mounted composer hears it, one clear is enough. */
let clearedBy: Event | null = null;

export function useVoiceMessageSettings(project: string | undefined): {
  view: VoiceSettingsView | null;
  /** Read the settings again now, e.g. to see whether Whisper was installed meanwhile. */
  refresh: () => Promise<VoiceSettingsView | null>;
} {
  const key = project ?? "";
  const [view, setView] = useState<VoiceSettingsView | null>(null);

  const refresh = useCallback(async () => {
    cache.delete(key);
    const next = await load(key);
    setView(next);
    return next;
  }, [key]);

  useEffect(() => {
    let live = true;
    const read = () => void load(key).then((next) => { if (live) setView(next); });
    const reread = (event: Event) => {
      if (clearedBy !== event) { clearedBy = event; cache.clear(); }
      read();
    };
    read();
    window.addEventListener(FEATURE_INTROS_CHANGED_EVENT, reread);
    window.addEventListener(VOICE_SETTINGS_CHANGED_EVENT, reread);
    return () => {
      live = false;
      window.removeEventListener(FEATURE_INTROS_CHANGED_EVENT, reread);
      window.removeEventListener(VOICE_SETTINGS_CHANGED_EVENT, reread);
    };
  }, [key]);

  return { view, refresh };
}
