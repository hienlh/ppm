/**
 * The browser's calls behind Settings → PPM Assistant → Changes and the chat card's Undo:
 * the settings the Assistant changed, Undo of one, and the switch that offers the tools at all.
 */
import { api } from "./api-client";
import { patchAssistantSettings } from "./assistant-settings-api";
import { SETTING_CHANGES_API, type SettingChangeRow, type SettingChangesList } from "../../shared/assistant-settings-changes";

export function listSettingChanges(): Promise<SettingChangesList> {
  return api.get<SettingChangesList>(SETTING_CHANGES_API);
}

/** The user's own Undo: no card. Rejects with the server's reason when the value moved since. */
export function undoSettingChange(id: number): Promise<{ change: SettingChangeRow; undone: SettingChangeRow }> {
  return api.post(`${SETTING_CHANGES_API}/${id}/undo`, {});
}

/** "Let the Assistant change settings": answers the "PPM has new features" question too. */
export async function setSettingsToolsOn(on: boolean): Promise<void> {
  await patchAssistantSettings({ settings_tools: on });
}
