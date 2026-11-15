/**
 * The frame every PPM Assistant card shares: a head naming what kind of card it is (a tinted
 * chip), the project (a neutral chip) and the time; the server-written provenance line that sets
 * a manager AI's words apart from PPM's own; the body; and either the card's buttons (while it
 * waits) or a status line saying how it ended. Everything a manager wrote is rendered as plain
 * text, never as markup.
 *
 * Buttons come in two groups. The card's own answers (`actions`: OK, Reply, Allow…) lead on a
 * desktop; the rest (`secondary`: Open manager chat, Dismiss) sit at the right. On a phone the
 * answers share the bottom row, the first of them on the right under the thumb, with the rest as
 * one row of two above them. In the Assistant's stream a card is drawn whole with the row at its
 * end; only a manager chat's "Waiting on you" bar, which scrolls a card in a box, makes the row
 * stick to that box's bottom.
 */
import { createContext, useContext, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { ChevronDown } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { AssistantCard } from "../../../../shared/assistant-cards";
import { CardMenu } from "./card-menu";
import { FollowUpNewCards } from "./card-followup-new-cards";
import { MarkdownRenderer } from "@/components/shared/markdown-renderer";

/**
 * Set by a manager chat's "Waiting on you" bar: there a long card scrolls inside the bar and its
 * button row sticks to the bar's bottom, so OK and Reply stay in view. In the Assistant's stream it
 * must not stick, or every open card would float its buttons over the messages below it.
 */
export const CardStickyActionsContext = createContext(false);

export type CardTone = "need" | "ok" | "fail" | "info" | "digest";

export interface CardLook {
  label: string;
  Icon: ComponentType<{ className?: string }>;
  tone: CardTone;
}

const TONE_CHIP: Record<CardTone, string> = {
  need: "bg-error/10 text-error",
  ok: "bg-success/10 text-success",
  fail: "bg-error/10 text-error",
  info: "bg-panel-2 text-text-secondary",
  digest: "bg-accent-wash text-primary",
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

export function CardButton({ children, onClick, variant = "default", disabled, secondary, title }: {
  children: ReactNode; onClick: () => void; variant?: "primary" | "default" | "danger" | "ghost"; disabled?: boolean;
  /** A tooltip with the long form of a short label ("Open chat" → "Open manager chat"). */
  title?: string;
  /** A lesser action (Open manager chat, Dismiss): quieter, and one of two per row on a phone. */
  secondary?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={cn(
        "inline-flex h-11 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-sm font-medium transition-colors disabled:opacity-50 md:h-8 md:w-auto md:rounded-md md:text-xs",
        secondary && "text-[13px] text-text-secondary md:px-2",
        variant === "primary" && "bg-primary text-primary-foreground shadow-sm can-hover:hover:bg-primary/90",
        variant === "default" && "border border-border bg-surface text-text-primary can-hover:hover:bg-surface-elevated",
        variant === "danger" && "border border-error/40 text-error can-hover:hover:bg-error/10",
        variant === "ghost" && "can-hover:hover:bg-surface-elevated can-hover:hover:text-text-primary",
      )}
    >
      {children}
    </button>
  );
}

/** How tall a closed card's text is before "Show more" (about eight lines), in rem. */
const FOLDED_REM = 11.25;
const FOLDED_TEXT = "max-h-[11.25rem]";

/**
 * A card's long text, as Markdown: the chat's renderer in its card mode (no HTML, nothing loaded
 * on its own, links in a new tab). A card that still waits shows all of it (the user answers from
 * it); one that no longer waits folds anything past about eight lines behind "Show more".
 */
export function CardText({ text, fold, className, projectName }: { text: string; fold: boolean; className?: string; projectName?: string | null }) {
  const box = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [open, setOpen] = useState(false);
  // Folded only once the text is known to be longer than the fold, and measured again whenever
  // the box changes size: a card that mounts in a hidden tab measures 0, and a clamp applied on
  // that reading would hide the rest of the text with no "Show more" to reach it.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !fold) { setOverflows(false); return; }
    const measure = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setOverflows(el.scrollHeight > rem * FOLDED_REM + 2);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watcher = new ResizeObserver(measure);
    watcher.observe(el);
    return () => watcher.disconnect();
  }, [text, fold]);
  const folded = fold && !open && overflows;
  return (
    <div className="relative">
      <div
        ref={box}
        className={cn("card-markdown break-words text-text-secondary", folded && `${FOLDED_TEXT} overflow-hidden`, className)}
        data-card-text=""
        data-folded={folded ? "" : undefined}
      >
        <MarkdownRenderer content={text} card projectName={projectName ?? undefined} />
      </div>
      {folded && <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-surface to-transparent" />}
      {fold && (overflows || open) && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="mt-1 inline-flex min-h-11 items-center gap-1 text-xs font-medium text-primary md:min-h-7"
          data-card-text-toggle=""
        >
          {open ? "Show less" : "Show more"}
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        </button>
      )}
    </div>
  );
}

export function CardShell({ card, look, children, actions, secondary, error, meta }: {
  card: AssistantCard; look: CardLook; children?: ReactNode; error?: string | null;
  /** The card's own answers, shown while it waits. */
  actions?: ReactNode;
  /** Lesser actions (Open manager chat, Dismiss), shown while it waits. */
  secondary?: ReactNode;
  /** Shown in the head after the label when the card has no project of its own ("3 projects"). */
  meta?: string;
}) {
  const status = cardStatusLine(card);
  const waiting = card.status === "open" && look.tone === "need";
  const sticky = useContext(CardStickyActionsContext);
  const article = (
    <article
      // A long press opens the card's menu on a phone, so it must not start a text selection there.
      // `overflow-clip`, not `hidden`: a clipping box that is not a scroll container lets the
      // button row stick to the bar that scrolls the card.
      className={cn(
        "@container/card w-full overflow-clip rounded-xl border bg-surface shadow-sm select-text max-md:select-none",
        waiting ? "border-error/35" : "border-border",
      )}
      data-assistant-card={card.kind}
      data-card-status={card.status}
    >
      <header className="flex min-w-0 items-center gap-1.5 px-3.5 pt-3 text-xs">
        <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-semibold", TONE_CHIP[look.tone])} data-card-kind-label="">
          <look.Icon className="size-3.5 shrink-0" />
          {look.label}
        </span>
        {card.projectName && (
          <span className="min-w-0 truncate rounded-full border border-border bg-panel-2 px-2 py-0.5 font-medium text-text-primary">{card.projectName}</span>
        )}
        {!card.projectName && meta && <span className="min-w-0 truncate text-text-secondary">{meta}</span>}
        <time className="ml-auto shrink-0 pl-1 text-[11px] tabular-nums text-text-subtle">{cardTime(card.createdAt)}</time>
      </header>
      {card.provenance && (
        <p className="px-3.5 pt-1.5 text-[11px] italic text-text-subtle" data-card-provenance="">{card.provenance}</p>
      )}
      {children && <div className="space-y-2.5 px-3.5 pb-3 pt-2 text-sm leading-relaxed text-text-primary">{children}</div>}
      {/* The manager's answer to the user's reply on this card, sent here and to where they replied. */}
      {card.followUp?.newCards?.length
        ? <FollowUpNewCards card={card} newCards={card.followUp.newCards} at={card.followUp.at} />
        : card.followUp && (
          <div className="mx-3.5 mb-3 rounded-md border border-border bg-panel-2 px-2.5 py-2 text-sm" data-card-followup="">
            <p className="pb-1 text-[11px] font-medium text-text-subtle">
              {"The manager's answer to your reply"} · {cardTime(card.followUp.at)}
            </p>
            <CardText text={card.followUp.text} fold projectName={card.projectName} />
            {card.followUp.truncated && (
              <p className="pt-1 text-xs text-text-subtle">The rest is in the manager chat.</p>
            )}
          </div>
        )}
      {/* Why a card that was answered waits again (the answer never reached the manager chat). */}
      {card.status === "open" && card.answer?.note && (
        <p className="mx-3.5 mb-3 rounded-md bg-error/10 px-2.5 py-1.5 text-xs text-error" data-card-notice="">{card.answer.note}</p>
      )}
      {status
        ? <p className="border-t border-border px-3.5 py-2 text-xs text-text-subtle" data-card-status-line="">{status}</p>
        : (actions || secondary) && (
          // Laid out by the card's own width, not the screen's: a desktop Assistant window is
          // narrow too. Narrow, the answers take one row and the lesser actions another (above
          // them on a phone, where the answers belong under the thumb); wide, all share one row.
          <div
            className={cn("border-t border-border bg-surface px-3.5 py-2.5", sticky && "sticky bottom-0 z-[1]")}
            data-card-actions=""
            data-sticky={sticky ? "" : undefined}
          >
            {/* Above the buttons, so a failed answer is said where the user is looking. */}
            {error && <p className="pb-2 text-xs text-error" role="alert">{error}</p>}
            <div className="flex flex-col gap-2 @[27rem]/card:flex-row @[27rem]/card:items-center">
              {/* The first answer (OK, Allow, Send) sits on the right on a phone, under the thumb. */}
              {actions && <div className="order-2 flex flex-row-reverse gap-2 *:flex-1 md:order-1 md:flex-row md:*:flex-none">{actions}</div>}
              {secondary && <div className="order-1 grid auto-cols-fr grid-flow-col gap-2 md:order-2 md:flex md:gap-1 @[27rem]/card:ml-auto">{secondary}</div>}
            </div>
          </div>
        )}
      {error && (status || !(actions || secondary)) && <p className="px-3.5 pb-2.5 text-xs text-error" role="alert">{error}</p>}
    </article>
  );
  return <CardMenu card={card}>{article}</CardMenu>;
}
