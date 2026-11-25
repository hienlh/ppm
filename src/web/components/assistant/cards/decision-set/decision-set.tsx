/**
 * The managers' decisions that wait on the user, as one form: the chat's AskUserQuestion card in
 * amber (red for an urgent card's tab). One tab per card; a tile per choice, or one OK; "Other" for
 * the user's own words and pictures. "Send this one" answers the card shown; "Send all answered"
 * first shows every answer about to leave, then sends them one by one. Cards with no answer keep
 * waiting.
 *
 * Keys, as in the chat's question form: ← → between cards, ↑ ↓ and 1–9 over the answers, O for
 * "Other". Enter moves to the next card and never sends — a draft OK goes out of PPM, and a stray
 * Enter must not be what sends it; Ctrl+Enter (⌘+Enter) opens the review of "Send all".
 *
 * Drawn whole wherever it sits: the Assistant puts it after its last message, a manager chat in
 * its "Waiting on you" bar.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { BellRing, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Info, Send } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { revealInScrollList } from "@/lib/reveal-in-scroll-list";
import { dismissAssistantCard } from "@/lib/assistant-cards-api";
import { useWaitingJumpStore } from "@/stores/assistant-waiting-jump-store";
import { forgetCard, pickAnswer, useDecisionSetStore } from "@/stores/decision-set-store";
import { QuestionTabStrip, questionFrameClass, questionTone } from "@/components/chat/question-form-parts";
import { currentPick, decisionTiles, projectCounts, type DecisionAnswer } from "@/lib/decision-set/decision-set-model";
import type { AssistantCard } from "../../../../../shared/assistant-cards";
import { openCardManagerChat } from "../use-card-action";
import { applyAssistantCard } from "@/stores/assistant-cards-store";
import { applyOpenCardResult } from "@/stores/assistant-open-cards-store";
import { cardRefusal } from "@/lib/assistant-cards-api";
import { DecisionSetCard, toneOf } from "./decision-set-card";
import { DecisionSetReview } from "./decision-set-review";
import { SET_BUTTON, SET_ICON_BUTTON, toneButtons } from "./decision-set-buttons";
import { useDecisionSet, type SetFlash } from "./use-decision-set";

const ALL = () => true;

function tabMark(card: AssistantCard, i: number, answered: boolean) {
  if (card.kind === "urgent") return "!";
  return answered ? "●" : i + 1;
}

/** One line about the last send from here, the card itself having left the set. */
function FlashLine({ flash }: { flash: SetFlash }) {
  const sent = flash.tone === "sent";
  return (
    <p
      className={cn("flex min-w-0 items-start gap-1.5 text-xs [&_svg]:mt-px [&_svg]:size-3.5 [&_svg]:shrink-0", sent ? "text-success" : "text-text-secondary")}
      role="status"
      data-decision-flash={flash.tone}
    >
      {sent ? <Check /> : <Info />}<span className="min-w-0 break-words">{flash.text}</span>
    </p>
  );
}

export function DecisionSet({ scope = ALL, label = "decisions" }: {
  /** Which waiting decisions this surface holds (a manager chat: its own project's). */
  scope?: (card: AssistantCard) => boolean;
  label?: string;
}) {
  const set = useDecisionSet(scope);
  const picks = useDecisionSetStore((s) => s.picks);
  const notices = useDecisionSetStore((s) => s.notices);
  const confirms = useDecisionSetStore((s) => s.confirms);
  const sending = useDecisionSetStore((s) => s.sending);
  const [folded, setFolded] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [focusedRow, setFocusedRow] = useState(0);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);

  const { tabs, index, active, waiting, plan, flash } = set;
  const card = active;
  const pick = card ? currentPick(card, picks) : null;
  const busy = !!card && !!sending[card.id];
  const anySending = Object.keys(sending).length > 0;

  // A jump (the Waiting chip, a stub in the stream) unfolds the set and leaves the review.
  const request = useWaitingJumpStore((s) => s.request);
  const lit = useWaitingJumpStore((s) => s.lit);
  useEffect(() => {
    if (request && tabs.some((c) => c.id === request.cardId)) { setFolded(false); setReviewing(false); }
    // Only a new request unfolds it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);
  useEffect(() => { setFocusedRow(0); setDismissError(null); }, [card?.id]);
  // Nothing left to send: the review has nothing to show.
  useEffect(() => { if (reviewing && plan.length === 0 && !anySending) setReviewing(false); }, [reviewing, plan.length, anySending]);
  // The review is laid out in place of the card, often taller: bring its Send button into view.
  useEffect(() => {
    if (!reviewing || !root.current) return;
    const el = root.current;
    const frame = requestAnimationFrame(() => revealInScrollList(el, "land"));
    return () => cancelAnimationFrame(frame);
  }, [reviewing]);

  const answer = useCallback((target: AssistantCard, next: DecisionAnswer | null) => pickAnswer(target, next), []);

  const sendThis = useCallback(() => {
    if (card && pick) void set.sendOne(card, pick.answer);
  }, [card, pick, set]);

  const dismiss = useCallback(async () => {
    if (!card) return;
    setDismissError(null);
    try {
      const res = await dismissAssistantCard(card.id);
      // Dismissed is answered: the card leaves the set, and the next one waiting opens.
      forgetCard(card.id);
      applyAssistantCard(res.card);
      applyOpenCardResult(res.card);
    } catch (e) {
      setDismissError(cardRefusal(e).error);
    }
  }, [card]);

  const rows = card ? decisionTiles(card).length + 1 : 0;
  const pickRow = useCallback((row: number) => {
    if (!card) return;
    const tiles = decisionTiles(card);
    if (row < tiles.length) answer(card, tiles[row]!.answer);
    else replyRef.current?.focus();
  }, [card, answer]);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLElement>) => {
    // By tag, not `instanceof`: in a picture-in-picture window the element belongs to another
    // document, whose classes are not this window's.
    const tag = (e.target as HTMLElement).tagName;
    const typing = tag === "TEXTAREA" || tag === "INPUT";
    // A focused button keeps its own Enter and Space (Send this one, Prev…).
    if (tag === "BUTTON" && (e.key === "Enter" || e.key === " ") && !(e.ctrlKey || e.metaKey)) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (plan.length) setReviewing(true);
      return;
    }
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      // Moves on; never sends.
      e.preventDefault();
      set.go(1);
      return;
    }
    if (typing) {
      if (e.key === "Escape") (e.target as HTMLElement).blur();
      return;
    }
    // While its answer is out, a card's pick stays as sent.
    if (busy && (e.key === " " || (e.key >= "0" && e.key <= "9") || e.key === "o" || e.key === "O")) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); set.go(-1); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); set.go(1); return; }
    if (!rows) return;
    if (e.key === "ArrowUp") { e.preventDefault(); setFocusedRow((r) => Math.max(0, r - 1)); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setFocusedRow((r) => Math.min(rows - 1, r + 1)); return; }
    if (e.key === " ") { e.preventDefault(); pickRow(focusedRow); return; }
    if (e.key >= "1" && e.key <= "9") {
      const row = Number(e.key) - 1;
      if (row < rows - 1) { e.preventDefault(); setFocusedRow(row); pickRow(row); }
      return;
    }
    if (e.key === "o" || e.key === "O" || e.key === "0") { e.preventDefault(); setFocusedRow(rows - 1); replyRef.current?.focus(); }
  }, [plan.length, set, rows, focusedRow, pickRow, busy]);

  const tabStrip = useMemo(() => tabs.map((tab, i) => {
    const answered = !!currentPick(tab, picks);
    return {
      key: tab.id,
      answered,
      tone: toneOf(tab),
      mark: tabMark(tab, i, answered),
      title: `${tab.projectName ? `${tab.projectName} · ` : ""}${tab.title}`,
      label: (
        <span className="flex min-w-0 items-center gap-1 @max-[26rem]/set:hidden">
          {tab.projectName && <span className="shrink-0 opacity-70">{tab.projectName}</span>}
          <span className="max-w-[12rem] truncate">{tab.title}</span>
        </span>
      ),
    };
  }), [tabs, picks]);

  // Every tab is a card that still waits (or one on its way from here), so the heading, the
  // strip and the "N/M" count the same cards the Waiting chip does.
  if (tabs.length === 0) return null;
  const ids = tabs.map((c) => c.id);
  const litHere = !!lit && ids.includes(lit);
  const count = tabs.length;
  const heading = `${count} ${count === 1 ? label.replace(/s$/, "") : label} waiting`;
  // The frame takes the colour of the card open in it: red for an urgent card, amber otherwise.
  // Folded, and in the review, nothing is open: red while an urgent card still has no answer.
  const urgentUnanswered = waiting.some((c) => c.kind === "urgent" && !plan.some((p) => p.card.id === c.id));
  const tone = folded || reviewing || !card ? (urgentUnanswered ? "urgent" : "decision") : toneOf(card);
  const frameMotion = "transition-[border-color,background-color,box-shadow] duration-300 motion-reduce:transition-none";
  const iconInk = tone === "urgent" ? "[&_svg]:text-error-ink" : "[&_svg]:text-warning-ink";
  const litRing = tone === "urgent" ? "ring-2 ring-error" : "ring-2 ring-warning";
  const buttons = toneButtons(tone);

  if (folded) {
    const picked = plan.length;
    return (
      <div
        className={cn("@container/set flex min-w-0 items-center gap-2 rounded-lg border-2 py-1 pl-3 pr-1", questionTone(tone).frame, frameMotion, litHere && litRing)}
        data-set-tone={tone}
        data-waiting-set={ids.join(" ")}
        data-decision-set="folded"
      >
        <span className={cn("flex shrink-0 items-center gap-1.5 text-[13px] font-semibold text-text-primary [&_svg]:size-3.5", iconInk)}><BellRing />{heading}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
          {projectCounts(waiting)}{picked ? ` · ${picked} picked, not sent` : ""}
        </span>
        <button type="button" className={SET_BUTTON.plain} onClick={() => setFolded(false)} data-decision-unfold=""><ChevronUp />Open</button>
      </div>
    );
  }

  return (
    <div
      ref={root}
      onKeyDown={onKeyDown}
      tabIndex={-1}
      role="group"
      aria-label={`Decisions waiting on you: ${count}`}
      className={cn("@container/set min-w-0", questionFrameClass(tone), frameMotion, litHere && litRing)}
      data-set-tone={tone}
      data-waiting-set={ids.join(" ")}
      data-decision-set="open"
      data-highlighted={litHere ? "" : undefined}
    >
      <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-text-primary">
        <span className={cn("flex shrink-0 items-center gap-1.5 [&_svg]:size-3.5", iconInk)}><BellRing />{heading}</span>
        <span className="min-w-0 flex-1 truncate text-right text-[10px] font-normal text-text-secondary @max-[34rem]/set:hidden">
          ←→ cards · 1–9 choose · O other · Ctrl+Enter send all
        </span>
        <span className="flex-1 @[34rem]/set:hidden" />
        <span className="shrink-0 text-[11px] font-normal tabular-nums text-text-secondary @[26rem]/set:hidden">{index + 1}/{tabs.length}</span>
        <button type="button" className={SET_ICON_BUTTON} onClick={() => setFolded(true)} aria-label="Fold the decisions" title="Fold" data-decision-fold="">
          <ChevronDown />
        </button>
      </div>

      {reviewing ? (
        <DecisionSetReview
          cards={waiting}
          plan={plan}
          now={Date.now()}
          busy={anySending}
          onBack={() => setReviewing(false)}
          onSend={() => void set.sendAll()}
          tone={tone}
        />
      ) : (
        <>
          {tabs.length > 1 && (
            <QuestionTabStrip tone="decision" tabs={tabStrip} active={index} onSelect={(i) => set.setActiveId(tabs[i]!.id)} className="scrollbar-none" />
          )}
          {flash && <FlashLine flash={flash} />}
          {card && (
            <DecisionSetCard
              card={card}
              answer={pick?.answer}
              onAnswer={(next) => answer(card, next)}
              focusedRow={focusedRow}
              setFocusedRow={setFocusedRow}
              replyRef={replyRef}
              onReplyKeyDown={() => { /* handled by the set */ }}
              onOpenChat={() => openCardManagerChat(card)}
              onDismiss={() => void dismiss()}
              busy={busy}
              notice={dismissError ?? notices[card.id]}
              // "Send anyway" sends the pick; with none left there is nothing to confirm.
              confirm={pick ? confirms[card.id] : undefined}
              onConfirm={() => pick && void set.sendOne(card, pick.answer, true)}
              onSendNow={(next) => void set.sendOne(card, next)}
            />
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-t border-border-soft pt-2.5" data-decision-actions="">
            <button type="button" className={cn(SET_BUTTON.plain, "@max-[26rem]/set:hidden")} onClick={() => set.go(-1)} disabled={index === 0}>
              <ChevronLeft />Prev
            </button>
            <button type="button" className={cn(SET_BUTTON.plain, "@max-[26rem]/set:hidden")} onClick={() => set.go(1)} disabled={index >= tabs.length - 1}>
              Next<ChevronRight />
            </button>
            <span className="flex-1 @max-[26rem]/set:hidden" />
            <button
              type="button"
              className={cn(buttons.outline, "@max-[26rem]/set:flex-1")}
              onClick={sendThis}
              disabled={!pick || busy}
              data-decision-send-one=""
            >
              <Send />{busy ? "Sending…" : <><span className="@max-[26rem]/set:hidden">Send this one</span><span className="@[26rem]/set:hidden">Send this</span></>}
            </button>
            <button
              type="button"
              className={cn(buttons.primary, "@max-[26rem]/set:flex-1")}
              onClick={() => setReviewing(true)}
              disabled={plan.length === 0 || anySending}
              data-decision-send-all=""
            >
              <span className="@max-[26rem]/set:hidden">Send all answered ({plan.length}/{count})</span>
              <span className="@[26rem]/set:hidden">Send all · {plan.length}</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
