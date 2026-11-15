/**
 * The Assistant's half of a jump to a waiting card (`assistant-waiting-jump-store.ts`): find the
 * card in this Assistant's own stream, scroll the stream so its top sits just under the stream's
 * top, and outline it. Also turns a press on a red count (`focusWaitingCards`) into a jump: the
 * card named, else that project's first; a project filter that would hide it moves to its project.
 *
 * The card may not be in the page yet (a filter just changed, the list is still loading), so the
 * search retries for a short while before giving up. Once landed, the card is held in place for a
 * moment: a card older than the loaded history sits by the list's top, where landing makes the
 * list load an older page above it, which would push it out of view. Any input of the user's own
 * (wheel, touch, a key) ends the hold at once.
 */
import { useEffect, useRef, type RefObject } from "react";
import { setAssistantCardFilter, useAssistantCardsStore } from "@/stores/assistant-cards-store";
import { orderWaitingCards, useOpenCards, useOpenCardsStore } from "@/stores/assistant-open-cards-store";
import { jumpToWaitingCard, lightWaitingCard, useWaitingJumpStore } from "@/stores/assistant-waiting-jump-store";
import type { AssistantCard } from "../../../shared/assistant-cards";

/** The gap left above a card a jump lands on, in px. */
const LAND_GAP = 12;
/** How long a jump keeps looking for a card that is not in the page yet. */
const FIND_FOR_MS = 3000;
const FIND_EVERY_MS = 50;
/** How long a landed card is kept in place while content loads above it. */
const HOLD_MS = 2500;
/** The user moving the list themselves: a held card lets go at once. */
const USER_INPUT = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/**
 * The card a press lands on: the card named, else the project's first waiting card, else the
 * first of all.
 */
export function focusTarget(ordered: readonly AssistantCard[], projectName: string | null, cardId?: string): AssistantCard | null {
  return (cardId ? ordered.find((c) => c.id === cardId) : undefined)
    ?? (projectName ? ordered.find((c) => c.projectName === projectName) : undefined)
    ?? ordered[0] ?? null;
}

/** The nearest ancestor that scrolls vertically: the chat's message list. */
function scrollParent(el: HTMLElement, stop: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node && node !== stop; node = node.parentElement) {
    const y = getComputedStyle(node).overflowY;
    if (y === "auto" || y === "scroll") return node;
  }
  return null;
}

/**
 * Scrolls only the list that holds the card. `scrollIntoView` would also move every ancestor that
 * can be scrolled from script, `overflow: hidden` ones included (a floating window's frame, the
 * app's panels), and leave the layout shifted.
 */
export function scrollCardIntoView(card: HTMLElement, root: HTMLElement, smooth: boolean): HTMLElement | null {
  const list = scrollParent(card, root);
  if (!list) return null;
  const top = list.scrollTop + card.getBoundingClientRect().top - list.getBoundingClientRect().top - LAND_GAP;
  list.scrollTo({ top: Math.max(0, top), behavior: smooth ? "smooth" : "auto" });
  return list;
}

/** The waiting card `id` in `root`, looked up afresh (a re-placed card is a new element). */
function findCard(root: HTMLElement, id: string): HTMLElement | undefined {
  return [...root.querySelectorAll<HTMLElement>("[data-waiting-card]")].find((n) => n.dataset.waitingCard === id);
}

/**
 * Keeps the card in place while the list grows above it (an older page loading), until `HOLD_MS`
 * has passed or the user moves the list themselves. Answers the stop function.
 */
function holdInPlace(root: HTMLElement, list: HTMLElement, id: string): () => void {
  let height = list.scrollHeight;
  const ticker = setInterval(() => {
    if (list.scrollHeight === height) return;
    height = list.scrollHeight;
    const card = findCard(root, id);
    if (card) scrollCardIntoView(card, root, false);
  }, 100);
  const stop = () => {
    clearInterval(ticker);
    clearTimeout(timer);
    for (const type of USER_INPUT) list.removeEventListener(type, stop);
  };
  const timer = setTimeout(stop, HOLD_MS);
  for (const type of USER_INPUT) list.addEventListener(type, stop, { passive: true });
  return stop;
}


function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useWaitingCardJump(root: RefObject<HTMLElement | null>): void {
  const request = useWaitingJumpStore((s) => s.request);
  const all = useOpenCards();
  const focus = useOpenCardsStore((s) => s.focus);
  // A jump asked for before this Assistant mounted was for another one, or for an earlier visit.
  const seen = useRef(useWaitingJumpStore.getState().request?.nonce ?? 0);

  // A press on a red count, or on "Show" beside a follow-up's new card.
  useEffect(() => {
    if (!focus || !all) return;
    const target = focusTarget(orderWaitingCards(all), focus.projectName, focus.cardId);
    // Taken once: a later visit to the Assistant must not land on it again.
    useOpenCardsStore.setState({ focus: null });
    if (!target) return;
    const { filter } = useAssistantCardsStore.getState();
    if (filter && target.projectName !== filter) setAssistantCardFilter(target.projectName);
    jumpToWaitingCard(target.id);
  }, [focus, all]);

  useEffect(() => {
    const el = root.current;
    if (!request || !el || request.nonce <= seen.current) return;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopHold: (() => void) | null = null;
    const find = () => {
      timer = null;
      const card = findCard(el, request.cardId);
      if (card) {
        seen.current = request.nonce;
        const list = scrollCardIntoView(card, el, !prefersReducedMotion());
        if (list) stopHold = holdInPlace(el, list, request.cardId);
        lightWaitingCard(request.cardId);
        return;
      }
      if (Date.now() - started < FIND_FOR_MS) timer = setTimeout(find, FIND_EVERY_MS);
      else seen.current = request.nonce;
    };
    find();
    return () => { if (timer) clearTimeout(timer); stopHold?.(); };
  }, [request, root]);
}
