/**
 * Floating-window body for Settings.
 *
 * The open category rides on the window's payload, so a reload puts the user back on the pane
 * they were reading instead of the default one. The payload is untrusted (it survives in
 * localStorage and can be hand-edited), hence the narrowing before it reaches the shell.
 */

import { useState } from "react";
import { useWindowStore } from "@/components/floating-window/window-store";
import type { WindowContentProps } from "@/components/floating-window/window-content-registry";
import { resolveSettingsLink } from "./assistant-settings-tab-store";
import { SettingsBody } from "./settings-body";

export default function SettingsWindowContent({ id, payload }: WindowContentProps) {
  const setPayload = useWindowStore((s) => s.setPayload);
  // Only the first render's category is used by the shell, and following a retired id moves a
  // sub-tab, so it is resolved once rather than on every render.
  const [category] = useState(() => resolveSettingsLink(payload?.category));

  return (
    <SettingsBody
      initialCategory={category}
      onCategoryChange={(next) => setPayload(id, { category: next })}
    />
  );
}
