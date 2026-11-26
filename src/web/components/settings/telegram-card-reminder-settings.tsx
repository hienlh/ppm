/**
 * Settings → PPM Assistant → Telegram: the reminder for a card nobody answered (`clawbot.card_reminders`,
 * `clawbot.card_reminder_minutes`). Rows of the same bordered list as "Quiet while I'm at PPM",
 * because only a card sent without a sound is ever reminded about.
 */
import { useEffect, useId, useState } from "react";
import { Loader2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TEXT_BUTTON, TEXT_CONTROL_HEIGHT } from "@/lib/control-size";
import { cn } from "@/lib/utils";
import { SwitchRow } from "./settings-rows";
import {
  CARD_REMINDER_MINUTES, CARD_REMINDERS_LABEL, CARD_REMINDERS_NOTE, validReminderMinutes,
} from "../../../shared/assistant-telegram-card-reminders";

export interface CardReminderOptions {
  card_reminders: boolean;
  card_reminder_minutes: number;
  quiet_while_in_ppm: boolean;
}

/** The minutes typed, when the server would take them. */
export function parseReminderMinutes(text: string): number | null {
  const t = text.trim();
  return /^\d+$/.test(t) ? validReminderMinutes(Number(t)) : null;
}

export function CardReminderRows({ options, saving, onSave }: {
  options: CardReminderOptions;
  saving: boolean;
  onSave: (patch: Partial<Pick<CardReminderOptions, "card_reminders" | "card_reminder_minutes">>) => void;
}) {
  const id = useId();
  const stored = options.card_reminder_minutes ?? CARD_REMINDER_MINUTES.default;
  const [text, setText] = useState(String(stored));
  useEffect(() => setText(String(stored)), [stored]);
  const minutes = parseReminderMinutes(text);
  const changed = minutes !== stored;
  const on = options.card_reminders !== false;
  const quietOff = options.quiet_while_in_ppm === false;

  return (
    <>
      <SwitchRow
        label={CARD_REMINDERS_LABEL}
        note={quietOff ? `${CARD_REMINDERS_NOTE} Quiet while I'm at PPM is off, so every card rings and none needs a reminder.` : CARD_REMINDERS_NOTE}
        checked={on}
        disabled={saving}
        onChange={(v) => onSave({ card_reminders: v })}
      />
      <form
        className="space-y-1 px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (minutes !== null && changed) onSave({ card_reminder_minutes: minutes });
        }}
      >
        <label htmlFor={id} className={cn("block text-sm", !on && "text-muted-foreground")}>Remind after (minutes)</label>
        <div className="flex items-center gap-2">
          <Input
            id={id}
            inputMode="numeric"
            value={text}
            disabled={saving || !on}
            onChange={(e) => setText(e.target.value)}
            aria-invalid={minutes === null}
            className={cn(TEXT_CONTROL_HEIGHT, "w-20 text-sm")}
          />
          {changed && on && (
            <Button type="submit" size="sm" disabled={saving || minutes === null} className={cn(TEXT_BUTTON, "cursor-pointer")}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : "Save"}
            </Button>
          )}
        </div>
        <p className={minutes === null ? "text-xs text-error" : "text-xs text-muted-foreground"}>
          {minutes === null
            ? `A whole number from ${CARD_REMINDER_MINUTES.min} to ${CARD_REMINDER_MINUTES.max}.`
            : "How long a card sent without a sound waits before its one reminder."}
        </p>
      </form>
    </>
  );
}
