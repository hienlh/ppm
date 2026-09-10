import { isSettingsCategoryId } from "./settings-categories";
import { SettingsBody } from "./settings-body";

/**
 * Settings as a tab — the mobile route, since the window layer does not render there.
 *
 * Layout comes from the shell's own width, so no viewport hint is passed. A category in the
 * tab's metadata is a deep link (open Accounts, not the index); tabs already carry and persist
 * metadata, so this needed no new tab field.
 */
export const SettingsTab = ({ metadata }: { metadata?: Record<string, unknown> }) => (
  <SettingsBody
    initialCategory={isSettingsCategoryId(metadata?.category) ? metadata.category : undefined}
  />
);
