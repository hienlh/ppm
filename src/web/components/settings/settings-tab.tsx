import { useState } from "react";
import { resolveSettingsLink } from "./assistant-settings-tab-store";
import { SettingsBody } from "./settings-body";

/**
 * Settings as a tab — the mobile route, since the window layer does not render there.
 *
 * Layout comes from the shell's own width, so no viewport hint is passed. A category in the
 * tab's metadata is a deep link (open Accounts, not the index); tabs already carry and persist
 * metadata, so this needed no new tab field. It is resolved once, on mount: following a retired
 * id moves a sub-tab, which must not happen again on every render.
 */
export const SettingsTab = ({ metadata }: { metadata?: Record<string, unknown> }) => {
  const [initialCategory] = useState(() => resolveSettingsLink(metadata?.category));
  return <SettingsBody initialCategory={initialCategory} />;
};
