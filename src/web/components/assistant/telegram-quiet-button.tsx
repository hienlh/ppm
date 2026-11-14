/**
 * The Assistant window's switch for "Quiet while I'm at PPM": a bell in the head (phone, docked
 * tab) or in the window's titlebar (desktop window). Struck through while on, so the phone stays
 * silent while the user is here; plain while off. It flips the same setting as Settings → PPM
 * Assistant → Telegram and `/quiet` on the phone, and follows it when either changes it.
 *
 * Shown only while the Assistant's Telegram side is switched on: with nothing going to Telegram
 * there is nothing to silence.
 */
import { toast } from "sonner";
import { Bell, BellOff } from "@/lib/icons";
import { useAssistantTelegramBinding } from "@/hooks/use-assistant-telegram-binding";
import { QUIET_SWITCH_LABEL } from "../../../shared/assistant-telegram-quiet";
import { TitleExtrasButton } from "./title-extras-button";

/** What the button says it will do, for its label and tooltip. */
export function quietButtonLabel(on: boolean): string {
  return on
    ? `${QUIET_SWITCH_LABEL}: on — Telegram stays silent while you are here. Click to turn off.`
    : `${QUIET_SWITCH_LABEL}: off — Telegram rings for every message. Click to turn on.`;
}

function useQuietSwitch(): { visible: boolean; on: boolean; toggle: () => void } {
  const { state, setQuiet } = useAssistantTelegramBinding();
  const on = state?.quietWhileInPpm !== false;
  const toggle = () => {
    setQuiet(!on).then(
      () => toast.success(!on ? "Telegram stays silent while you are at PPM" : "Telegram rings for every message again"),
      (e: unknown) => toast.error("Could not change it", { description: e instanceof Error ? e.message : String(e) }),
    );
  };
  return { visible: state?.enabled === true, on, toggle };
}

/** In the Assistant's own head (a phone, or the tab docked in a desktop grid). */
export function TelegramQuietHeadButton() {
  const { visible, on, toggle } = useQuietSwitch();
  if (!visible) return null;
  const label = quietButtonLabel(on);
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      aria-pressed={on}
      title={label}
      data-telegram-quiet={on ? "on" : "off"}
      className="grid size-11 place-items-center rounded-lg text-text-secondary hover:bg-surface-elevated md:size-8"
    >
      {on ? <BellOff className="size-[18px] md:size-4" /> : <Bell className="size-[18px] md:size-4" />}
    </button>
  );
}

/** In the desktop window's titlebar, beside the settings gear. */
export function TelegramQuietTitleButton({ skin }: { skin: "windows" | "macos" }) {
  const { visible, on, toggle } = useQuietSwitch();
  if (!visible) return null;
  return (
    <TitleExtrasButton skin={skin} label={quietButtonLabel(on)} onClick={toggle}>
      <span data-telegram-quiet={on ? "on" : "off"} className="flex">
        {on ? <BellOff className="size-3.5" /> : <Bell className="size-3.5" />}
      </span>
    </TitleExtrasButton>
  );
}
