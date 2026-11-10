/**
 * The Assistant window's own titlebar button: the gear that opens Settings → PPM Assistant. The
 * "Working" / "Idle" state beside the title is the frame's (`showIdle` in the extras registry).
 */
import { Settings } from "@/lib/icons";
import { openSettings } from "@/components/settings/open-settings";
import { TitleExtrasButton } from "./title-extras-button";

export const ASSISTANT_SETTINGS_LABEL = "PPM Assistant settings";

export function AssistantTitleExtras({ skin }: { skin: "windows" | "macos" }) {
  return (
    <TitleExtrasButton skin={skin} label={ASSISTANT_SETTINGS_LABEL} onClick={() => openSettings("assistant")}>
      <Settings className="size-3.5" />
    </TitleExtrasButton>
  );
}
