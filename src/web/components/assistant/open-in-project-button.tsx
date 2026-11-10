/**
 * "Open in project" in the titlebar of a manager chat the Assistant opened beside another project:
 * the window closes, the project becomes the active one and the chat opens in its grid. Drawn only
 * for that kind of window; every other chat window gets nothing. The flow is loaded on click, so
 * the window manager does not pull project switching in with its titlebars.
 */
import { LogIn } from "@/lib/icons";
import type { Tab } from "@/stores/tab-store";
import { TitleExtrasButton } from "./title-extras-button";

export const OPEN_IN_PROJECT_LABEL = "Open in project";

export function OpenInProjectTitleExtras({ tab, skin }: { tab: Tab; skin: "windows" | "macos" }) {
  if (tab.type !== "chat" || tab.metadata?.managerWindow !== true) return null;
  const open = () => {
    void import("./open-manager-chat").then(({ openManagerChatInProject }) => openManagerChatInProject(tab));
  };
  return (
    <TitleExtrasButton skin={skin} label={OPEN_IN_PROJECT_LABEL} onClick={open} wide>
      <LogIn className="size-3.5" />
      <span className="@max-[420px]/window:hidden">{OPEN_IN_PROJECT_LABEL}</span>
    </TitleExtrasButton>
  );
}
