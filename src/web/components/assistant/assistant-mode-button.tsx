/**
 * The Assistant window's quick switch between Full and Ask (Settings → PPM Assistant →
 * Permissions holds the same setting). A word as well as an icon, because which mode is on is
 * the thing to see at a glance: "Full" with a bolt, "Ask" with a hand. Going back to Ask is one
 * press; going to Full shows the same confirmation as Settings first, because a stray tap on a
 * phone would otherwise switch every card off. The toast offers Undo either way.
 *
 * In the Assistant's own head (a phone, or the tab docked in a desktop grid) it is a chip with
 * text, 28 px on a desktop and 26 px on a phone (docs/design-guidelines.md rule 3); in a desktop
 * window's titlebar it is a caption button.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Hand, Zap } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { TEXT_CONTROL_HEIGHT } from "@/lib/control-size";
import { FULL_MODE_CONFIRM, useAssistantPermissionMode, type PermissionModeState } from "@/hooks/use-assistant-permission-mode";
import { ConfirmDialog } from "@/components/settings/assistant/assistant-settings-dialog";
import type { AssistantPermissionMode } from "../../../shared/assistant-settings";
import { TitleExtrasButton } from "./title-extras-button";

/** What the button says, for its label and tooltip. */
export function modeButtonLabel(mode: PermissionModeState): string {
  return mode === "full"
    ? "Full mode: the Assistant does what you ask without cards. Click to switch to Ask."
    : "Ask mode: the Assistant shows a card before each change. Click to switch to Full.";
}

const TOAST: Record<AssistantPermissionMode, string> = {
  full: "Full mode: the Assistant does what you ask without cards",
  ask: "Ask mode: the Assistant asks before each change",
};

/** The confirmation's buttons follow the chip-row standard, as in Settings. */
const CONFIRM_BUTTON = `${TEXT_CONTROL_HEIGHT} px-2.5 text-xs`;

function useModeSwitch() {
  const { mode, setMode, saving } = useAssistantPermissionMode();
  const [confirming, setConfirming] = useState(false);
  const apply = (from: AssistantPermissionMode, to: AssistantPermissionMode) => {
    setMode(to).then(
      () => toast.success(TOAST[to], {
        description: "Pushing, publishing, sending to other people and the vault always ask.",
        action: { label: "Undo", onClick: () => void setMode(from).catch(() => {}) },
      }),
      (e: unknown) => toast.error("Could not change the mode", { description: e instanceof Error ? e.message : String(e) }),
    );
  };
  const flip = () => {
    if (mode === null || saving) return;
    if (mode === "full") apply("full", "ask");
    else setConfirming(true);
  };
  const confirm = (
    <ConfirmDialog open={confirming} title="Switch the Assistant to Full mode?" confirmLabel="Use Full" buttonClassName={CONFIRM_BUTTON}
      onClose={() => setConfirming(false)}
      onConfirm={() => { setConfirming(false); apply("ask", "full"); }}>
      {FULL_MODE_CONFIRM}
    </ConfirmDialog>
  );
  return { mode, flip, saving, confirm };
}

function ModeIcon({ full, className }: { full: boolean; className: string }) {
  return full ? <Zap className={className} /> : <Hand className={className} />;
}

/** In the Assistant's own head. */
export function AssistantModeHeadButton() {
  const { mode, flip, saving, confirm } = useModeSwitch();
  if (mode === null) return null;
  const full = mode === "full";
  const label = modeButtonLabel(mode);
  return (
    <>
    <button
      type="button"
      onClick={flip}
      disabled={saving}
      aria-label={label}
      aria-pressed={full}
      title={label}
      data-assistant-mode={full ? "full" : "ask"}
      className={cn(
        TEXT_CONTROL_HEIGHT,
        "inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 text-[11.5px] font-medium hover:bg-surface-elevated max-md:px-[5px]",
        full ? "text-warning-ink" : "text-text-secondary",
      )}
    >
      <ModeIcon full={full} className="size-3.5" />
      {full ? "Full" : "Ask"}
    </button>
    {confirm}
    </>
  );
}

/** In the desktop window's titlebar, beside the settings gear. */
export function AssistantModeTitleButton({ skin }: { skin: "windows" | "macos" }) {
  const { mode, flip, confirm } = useModeSwitch();
  if (mode === null) return null;
  const full = mode === "full";
  return (
    <>
    <TitleExtrasButton skin={skin} label={modeButtonLabel(mode)} onClick={flip} pressed={full} wide>
      <span data-assistant-mode={full ? "full" : "ask"} className={cn("flex items-center gap-1", full && "text-warning-ink")}>
        <ModeIcon full={full} className="size-3.5" />
        {full ? "Full" : "Ask"}
      </span>
    </TitleExtrasButton>
    {confirm}
    </>
  );
}
