/**
 * The frame every PPM Assistant card shares: a head naming what kind of card it is, the project
 * and the time; the server-written provenance line that sets a manager AI's words apart from
 * PPM's own; the body; and either the card's buttons (while it waits) or a status line saying how
 * it ended. Everything a manager wrote is rendered as plain text, never as markup.
 */
import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { AssistantCard } from "../../../../shared/assistant-cards";
import { CardMenu } from "./card-menu";

export type CardTone = "need" | "ok" | "fail" | "info" | "digest";

export interface CardLook {
  label: string;
  Icon: ComponentType<{ className?: string }>;
  tone: CardTone;
}

const TONE_HEAD: Record<CardTone, string> = {
  need: "text-error",
  ok: "text-success",
  fail: "text-error",
  info: "text-text-secondary",
  digest: "text-primary",
};

/** "09:40" today, "Nov 9, 14:02" on another day. */
export function cardTime(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return new Date(now).toDateString() === d.toDateString()
    ? time
    : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

/** How a card that no longer waits ended, in a few words; null while it waits. */
export function cardStatusLine(card: AssistantCard): string | null {
  const at = card.answer ? ` · ${cardTime(card.answer.at)}` : "";
  switch (card.status) {
    case "open":
    case "info":
      return null;
    case "dismissed":
      return `Dismissed${at}`;
    case "gone":
      return "No longer waiting";
    case "resolved":
      return `${card.answer?.note ?? "Resolved"}${at}`;
    case "answered":
      if (card.answer?.note) return `${card.answer.note}${at}`;
      if (card.kind === "approval") return `${card.answer?.approved ? "Allowed" : "Denied"} in PPM${at}`;
      return `Answered in PPM${at}`;
  }
}

export function CardButton({ children, onClick, variant = "default", disabled, secondary }: {
  children: ReactNode; onClick: () => void; variant?: "primary" | "default" | "danger" | "ghost"; disabled?: boolean;
  /** Below `md` this action lives in the card's long-press sheet instead of the button row. */
  secondary?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors disabled:opacity-50 md:h-8 md:w-auto md:text-xs",
        secondary && "max-md:hidden",
        variant === "primary" && "bg-primary text-primary-foreground can-hover:hover:bg-primary/90",
        variant === "default" && "border border-border text-text-primary can-hover:hover:bg-surface-elevated",
        variant === "danger" && "border border-error/40 text-error can-hover:hover:bg-error/10",
        variant === "ghost" && "text-text-secondary can-hover:hover:bg-surface-elevated",
      )}
    >
      {children}
    </button>
  );
}

export function CardShell({ card, look, children, actions, error, meta }: {
  card: AssistantCard; look: CardLook; children?: ReactNode; actions?: ReactNode; error?: string | null;
  /** Shown in the head after the label when the card has no project of its own ("3 projects"). */
  meta?: string;
}) {
  const status = cardStatusLine(card);
  const waiting = card.status === "open" && look.tone === "need";
  const article = (
    <article
      // A long press opens the card's menu on a phone, so it must not start a text selection there.
      className={cn("w-full overflow-hidden rounded-xl border bg-surface select-text max-md:select-none", waiting ? "border-error/40" : "border-border")}
      data-assistant-card={card.kind}
      data-card-status={card.status}
    >
      <header className={cn("flex items-center gap-2 border-b border-border px-3 py-2 text-xs", waiting && "bg-error/5")}>
        <span className={cn("inline-flex items-center gap-1.5 font-semibold", TONE_HEAD[look.tone])}>
          <look.Icon className="size-3.5 shrink-0" />
          {look.label}
        </span>
        {card.projectName && <span className="min-w-0 truncate font-semibold text-text-primary">{card.projectName}</span>}
        {!card.projectName && meta && <span className="min-w-0 truncate text-text-secondary">{meta}</span>}
        <time className="ml-auto shrink-0 text-[11px] text-text-subtle">{cardTime(card.createdAt)}</time>
      </header>
      {card.provenance && (
        <p className="px-3 pt-2 text-[11px] italic text-text-subtle" data-card-provenance="">{card.provenance}</p>
      )}
      {children && <div className="space-y-1.5 px-3 py-2 text-sm leading-relaxed text-text-primary">{children}</div>}
      {status
        ? <p className="px-3 pb-2.5 text-xs text-text-subtle" data-card-status-line="">{status}</p>
        : actions && <div className="flex flex-col-reverse gap-2 px-3 pb-3 md:flex-row md:flex-wrap">{actions}</div>}
      {error && <p className="px-3 pb-2 text-xs text-error">{error}</p>}
    </article>
  );
  return <CardMenu card={card}>{article}</CardMenu>;
}
