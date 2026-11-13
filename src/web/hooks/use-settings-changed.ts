import { useEffect, useRef } from "react";
import { SETTINGS_CHANGED_EVENT, type SettingsSection } from "../../shared/settings-events";

/**
 * Calls `onChange` when the server announces that one of `sections` changed (another device, the
 * `ppm` CLI), so an open Settings pane reads its section again instead of showing the old value
 * until it is reopened. `onChange` may change between renders; the listener keeps the latest.
 */
export function useSettingsChanged(sections: SettingsSection | readonly SettingsSection[], onChange: () => void): void {
  const callback = useRef(onChange);
  callback.current = onChange;
  const key = (typeof sections === "string" ? [sections] : [...sections]).join(",");

  useEffect(() => {
    const wanted = new Set(key.split(","));
    const listener = (event: Event) => {
      const section = (event as CustomEvent<{ section?: string }>).detail?.section;
      if (section && wanted.has(section)) callback.current();
    };
    window.addEventListener(SETTINGS_CHANGED_EVENT, listener);
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, listener);
  }, [key]);
}
