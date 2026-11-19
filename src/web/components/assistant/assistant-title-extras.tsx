/**
 * The Assistant window's own titlebar buttons: the "quiet while I'm at PPM" bell (while Telegram
 * is on) and the gear that opens Settings → PPM Assistant. The
 * "Working" / "Idle" state beside the title is the frame's (`showIdle` in the extras registry).
 */
import { Settings } from "@/lib/icons";
import { openSettings } from "@/components/settings/open-settings";
import { TitleExtrasButton } from "./title-extras-button";
import { TelegramQuietTitleButton } from "./telegram-quiet-button";
import { AssistantModeTitleButton } from "./assistant-mode-button";

export const ASSISTANT_SETTINGS_LABEL = "PPM Assistant settings";

export function AssistantTitleExtras({ skin }: { skin: "windows" | "macos" }) {
  return (
    <>
      <AssistantModeTitleButton skin={skin} />
      <TelegramQuietTitleButton skin={skin} />
      <TitleExtrasButton skin={skin} label={ASSISTANT_SETTINGS_LABEL} onClick={() => openSettings("assistant")}>
        <Settings className="size-3.5" />
      </TitleExtrasButton>
    </>
  );
}
