import { randomUUID } from "node:crypto";
import {
  isVaultItemKind, isVaultTier, VAULT_CARD_APPROVAL, VAULT_WINDOW_MINUTES, type VaultCardAnswer, type VaultCardAnswerResult,
  type VaultCardInput, type VaultCardRequester, type VaultItemKind, type VaultItemMeta, type VaultLockedTier, type VaultTier,
} from "../../shared/vault.ts";
import { createLogger } from "../logger.ts";
import { ppmCardEnd, type PpmCardEnd } from "../../shared/ppm-card-end.ts";
import { vaultGrants, type VaultGrants } from "./vault-grants.ts";
import { vaultService, VaultError, type VaultItemValue, type VaultService, type UnlockFailure } from "./vault.service.ts";

/**
 * The vault's cards in a chat: an AI's read of the secure tier (the user ticks items and picks
 * once or a window), a read of one sealed item (shown to the user by default), and a proposal to
 * save an item. The call waits here while the chat shows the card in the session's one approval
 * slot (registered in `chat-ppm-approvals.ts`); the user answers over authenticated HTTP with
 * the tier's password. A wrong password leaves the card waiting and says how many tries are left.
 *
 * Who started the turn matters:
 * - a turn nobody started (a watch, a schedule, an extension) gets no card for a locked tier;
 * - a turn started from Telegram cannot open the secure tier, and a sealed item it asks for is
 *   only shown to the user in PPM — the AI's answer would go back to Telegram.
 *
 * One card per chat; at most 10 secure and 3 sealed cards a chat an hour. Logging names ids,
 * tiers and outcomes only.
 */

const log = createLogger("vault");

export type VaultTurnOrigin = string | undefined;

export interface VaultRequestContext {
  origin: VaultTurnOrigin;
  sessionTitle: string | null;
  assistant: boolean;
}

export type VaultCardEvent = { type: "approval_request"; requestId: string; tool: typeof VAULT_CARD_APPROVAL; input: VaultCardInput };

export interface VaultCardChat {
  announce(sessionId: string, event: VaultCardEvent): boolean;
  /** The card was answered, or given up on; `end` says which. */
  resolved(sessionId: string, requestId: string, approved: boolean, end?: PpmCardEnd): void;
}

export type VaultRefusal = { ok: false; reason: "declined" | "timeout" | "cancelled" | "no-chat" | "busy" | "refused" | "rate-limited"; message: string };

export type VaultReadOutcome =
  | { ok: true; tier: VaultLockedTier; items: VaultItemValue[] }
  | { ok: true; tier: "sealed"; shownToUser: { id: string; name: string } }
  | VaultRefusal;

export type VaultProposeOutcome = { ok: true; saved: VaultItemMeta } | VaultRefusal;

export type VaultAnswerResult =
  | { ok: true; result: VaultCardAnswerResult }
  | { ok: false; status: 400 | 403 | 404 | 409 | 423; error: string; attemptsLeft?: number; retryAfterMs?: number };

/** How long a card waits for the user. The MCP call's own timeouts outlast it. */
export const VAULT_CARD_WAIT_MS = 10 * 60_000;
const HOUR = 3_600_000;
export const VAULT_CARDS_PER_HOUR: Record<VaultLockedTier, number> = { secure: 10, sealed: 3 };

/** Turns no person started: no locked-tier card is shown for them. */
const UNATTENDED = new Set(["watch", "schedule", "extension", "delete"]);

interface Pending {
  sessionId: string;
  event: VaultCardEvent;
  prefill: string | null;
  answering: boolean;
  settle: (outcome: VaultReadOutcome | VaultProposeOutcome) => void;
}

export function createVaultUnlockBroker(opts: {
  chat: () => VaultCardChat | null;
  canonical?: (sessionId: string) => string;
  service?: VaultService;
  grants?: VaultGrants;
  now?: () => number;
  onShown?: (sessionId: string, requestId: string) => void;
}) {
  const canonical = opts.canonical ?? ((id: string) => id);
  const service = opts.service ?? vaultService;
  const grants = opts.grants ?? vaultGrants;
  const now = opts.now ?? Date.now;
  const pending = new Map<string, Pending>();
  const shownAt = new Map<string, { tier: VaultLockedTier; at: number }[]>();

  function pendingOf(sessionId: string): [string, Pending] | null {
    const id = canonical(sessionId);
    for (const entry of pending) if (canonical(entry[1].sessionId) === id) return entry;
    return null;
  }

  function overLimit(sessionId: string, tier: VaultLockedTier): boolean {
    const id = canonical(sessionId);
    const recent = (shownAt.get(id) ?? []).filter((s) => s.at > now() - HOUR);
    shownAt.set(id, recent);
    return recent.filter((s) => s.tier === tier).length >= VAULT_CARDS_PER_HOUR[tier];
  }

  function requester(ctx: VaultRequestContext): VaultCardRequester {
    return { sessionTitle: ctx.sessionTitle, assistant: ctx.assistant, fromTelegram: ctx.origin === "telegram" };
  }

  /** Shows `input` and waits; the shared plumbing of every card. */
  function ask<T extends VaultReadOutcome | VaultProposeOutcome>(
    asked: string, input: VaultCardInput, prefill: string | null, tier: VaultLockedTier | null, signal?: AbortSignal, waitMs = VAULT_CARD_WAIT_MS,
  ): Promise<T> {
    const sessionId = canonical(asked);
    if (signal?.aborted) return Promise.resolve({ ok: false, reason: "cancelled", message: "The call was cancelled before the user was asked." } as T);
    if (pendingOf(sessionId)) {
      return Promise.resolve({ ok: false, reason: "busy", message: "Another vault card is already waiting in this chat; wait for its answer, then call again." } as T);
    }
    if (tier && overLimit(sessionId, tier)) {
      return Promise.resolve({ ok: false, reason: "rate-limited", message: `This chat has asked to open the ${tier} tier too often in the last hour; try again later.` } as T);
    }
    const requestId = randomUUID();
    const event: VaultCardEvent = { type: "approval_request", requestId, tool: VAULT_CARD_APPROVAL, input };
    return new Promise<T>((done) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => settle({ ok: false, reason: "cancelled", message: "The call was cancelled before the user answered." });
      const settle = (outcome: VaultReadOutcome | VaultProposeOutcome): void => {
        const entry = pending.get(requestId);
        if (!entry) return;
        pending.delete(requestId);
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        try {
          const reason = outcome.ok ? undefined : (outcome as VaultRefusal).reason;
          opts.chat()?.resolved(canonical(entry.sessionId), requestId, outcome.ok, ppmCardEnd(outcome.ok || reason === "declined", reason));
        } catch (e) {
          log.warn(`clearing card ${requestId} failed: ${(e as Error).message}`);
        }
        log.info(`card ${requestId} ${outcome.ok ? "answered" : (outcome as VaultRefusal).reason}`);
        done(outcome as T);
      };
      pending.set(requestId, { sessionId, event, prefill, answering: false, settle });
      signal?.addEventListener("abort", onAbort, { once: true });
      let shown = false;
      try {
        shown = opts.chat()?.announce(sessionId, event) ?? false;
      } catch (e) {
        log.warn(`announcing card failed for session=${sessionId}: ${(e as Error).message}`);
      }
      if (!shown) {
        settle({ ok: false, reason: "no-chat", message: "This chat is not open in PPM, so the user cannot be asked to unlock the vault." });
        return;
      }
      if (tier) {
        const list = shownAt.get(sessionId) ?? [];
        list.push({ tier, at: now() });
        shownAt.set(sessionId, list);
      }
      timer = setTimeout(() => settle({ ok: false, reason: "timeout", message: `The user did not answer within ${Math.round(waitMs / 60_000)} minutes.` }), waitMs);
      try { opts.onShown?.(sessionId, requestId); } catch { /* a notice never decides the card */ }
    });
  }

  function refusedFor(ctx: VaultRequestContext, tier: VaultLockedTier): VaultRefusal | null {
    if (!ctx.origin || UNATTENDED.has(ctx.origin)) {
      return { ok: false, reason: "refused", message: "Nobody started this turn, so the vault's locked tiers cannot be opened in it." };
    }
    if (tier === "secure" && ctx.origin === "telegram") {
      return { ok: false, reason: "refused", message: "This item can only be opened while the user is using PPM, not from Telegram." };
    }
    if (!service.isEnabled(tier)) {
      return { ok: false, reason: "refused", message: `The ${tier} tier of the vault is not turned on.` };
    }
    return null;
  }

  /** Card for reading secure items: every secure item listed, the requested ones ticked. */
  function requestSecure(sessionId: string, requested: readonly string[], purpose: string, ctx: VaultRequestContext, signal?: AbortSignal): Promise<VaultReadOutcome> {
    const refused = refusedFor(ctx, "secure");
    if (refused) return Promise.resolve(refused);
    const status = service.status().tiers.secure;
    const input: VaultCardInput = {
      kind: "read-secure", requester: requester(ctx), purpose,
      items: service.listItems("secure").map((i) => ({ id: i.id, name: i.name, kind: i.kind })),
      requested: [...requested], attemptsLeft: status.attemptsLeft, lockedUntil: status.lockedUntil,
    };
    return ask<VaultReadOutcome>(sessionId, input, null, "secure", signal);
  }

  /** Card for one sealed item: shown to the user unless they choose to give it to the AI. */
  function requestSealed(sessionId: string, itemId: string, purpose: string, ctx: VaultRequestContext, signal?: AbortSignal): Promise<VaultReadOutcome> {
    const refused = refusedFor(ctx, "sealed");
    if (refused) return Promise.resolve(refused);
    const meta = service.getMeta(itemId);
    if (!meta || meta.tier !== "sealed") return Promise.resolve({ ok: false, reason: "refused", message: "No such sealed item." });
    const status = service.status().tiers.sealed;
    const input: VaultCardInput = {
      kind: "read-sealed", requester: requester(ctx), purpose, item: { id: meta.id, name: meta.name, kind: meta.kind },
      allowGiveToAi: ctx.origin !== "telegram", attemptsLeft: status.attemptsLeft, lockedUntil: status.lockedUntil,
    };
    return ask<VaultReadOutcome>(sessionId, input, null, "sealed", signal);
  }

  /** Card proposing an item; the user picks the tier and confirms with that tier's password. */
  function requestPropose(
    sessionId: string, proposal: { name: string; kind: VaultItemKind; tier: VaultTier; value: string | null }, ctx: VaultRequestContext, signal?: AbortSignal,
  ): Promise<VaultProposeOutcome> {
    if (!ctx.origin || UNATTENDED.has(ctx.origin)) {
      return Promise.resolve({ ok: false, reason: "refused", message: "Nobody started this turn, so there is no one to confirm saving to the vault." });
    }
    const input: VaultCardInput = {
      kind: "propose", requester: requester(ctx), name: proposal.name, itemKind: proposal.kind, suggestedTier: proposal.tier,
      hasPrefill: !!proposal.value, enabled: { secure: service.isEnabled("secure"), sealed: service.isEnabled("sealed") },
    };
    return ask<VaultProposeOutcome>(sessionId, input, proposal.value || null, null, signal);
  }

  function failure(r: UnlockFailure): VaultAnswerResult {
    if (r.reason === "locked-out") return { ok: false, status: 423, error: r.message, retryAfterMs: r.retryAfterMs };
    if (r.reason === "wrong-password") return { ok: false, status: 403, error: r.message, attemptsLeft: r.attemptsLeft, ...(r.lockedForMs ? { retryAfterMs: r.lockedForMs } : {}) };
    return { ok: false, status: 409, error: r.message };
  }

  async function answerRead(requestId: string, entry: Pending, input: Extract<VaultCardInput, { kind: "read-secure" | "read-sealed" }>, body: VaultCardAnswer): Promise<VaultAnswerResult> {
    if (input.kind === "read-secure") {
      const known = new Set(input.items.map((i) => i.id));
      const ids = Array.isArray(body.itemIds) ? [...new Set(body.itemIds)] : [];
      if (ids.length === 0 || ids.some((id) => typeof id !== "string" || !known.has(id))) return { ok: false, status: 400, error: "Tick at least one item of this tier." };
      const mode = body.mode ?? "once";
      if (mode !== "once" && mode !== "window") return { ok: false, status: 400, error: "Pick once or a window." };
      if (mode === "window" && !(VAULT_WINDOW_MINUTES as readonly number[]).includes(body.minutes as number)) return { ok: false, status: 400, error: "A window lasts 5, 10 or 15 minutes." };
      const opened = await service.unlock("secure", body.password);
      if (!opened.ok) return failure(opened);
      const dek = opened.dek;
      try {
        if (!pending.has(requestId)) return { ok: false, status: 404, error: "This card is no longer waiting." };
        const items = service.readLocked("secure", ids, dek);
        if (mode === "window") grants.openWindow("secure", entry.sessionId, ids, body.minutes as number, dek);
        entry.settle({ ok: true, tier: "secure", items });
        return { ok: true, result: { approved: true } };
      } finally {
        dek.fill(0);
      }
    }
    if (body.giveToAi === true && !input.allowGiveToAi) return { ok: false, status: 400, error: "From a Telegram turn the value can only be shown to you." };
    const opened = await service.unlock("sealed", body.password);
    if (!opened.ok) return failure(opened);
    const dek = opened.dek;
    try {
      if (!pending.has(requestId)) return { ok: false, status: 404, error: "This card is no longer waiting." };
      const [item] = service.readLocked("sealed", [input.item.id], dek);
      if (body.giveToAi === true) {
        entry.settle({ ok: true, tier: "sealed", items: [item!] });
        return { ok: true, result: { approved: true } };
      }
      entry.settle({ ok: true, tier: "sealed", shownToUser: { id: item!.id, name: item!.name } });
      return { ok: true, result: { approved: true, shown: { name: item!.name, value: item!.value } } };
    } finally {
      dek.fill(0);
    }
  }

  async function answerPropose(requestId: string, entry: Pending, input: Extract<VaultCardInput, { kind: "propose" }>, body: VaultCardAnswer): Promise<VaultAnswerResult> {
    const tier = body.tier ?? input.suggestedTier;
    if (!isVaultTier(tier)) return { ok: false, status: 400, error: "Pick a tier." };
    const kind = body.itemKind ?? input.itemKind;
    if (!isVaultItemKind(kind)) return { ok: false, status: 400, error: "Pick a kind." };
    const value = typeof body.value === "string" && body.value.length > 0 ? body.value : entry.prefill;
    if (!value) return { ok: false, status: 400, error: "Type the value to save." };
    const item = { tier, kind, name: body.name ?? input.name, value };
    if (tier === "public") {
      const saved = service.addItem(item);
      entry.settle({ ok: true, saved });
      return { ok: true, result: { approved: true } };
    }
    const opened = await service.unlock(tier, body.password);
    if (!opened.ok) return failure(opened);
    try {
      if (!pending.has(requestId)) return { ok: false, status: 404, error: "This card is no longer waiting." };
      const saved = service.addItem(item, opened.dek);
      entry.settle({ ok: true, saved });
      return { ok: true, result: { approved: true } };
    } finally {
      opened.dek.fill(0);
    }
  }

  /** The user's answer, from the card in PPM. A wrong password leaves the card waiting. */
  async function answer(requestId: string, body: Partial<VaultCardAnswer> | null): Promise<VaultAnswerResult> {
    const entry = pending.get(requestId);
    if (!entry) return { ok: false, status: 404, error: "This card is no longer waiting: it was answered, cancelled or timed out." };
    if (!body || typeof body.approved !== "boolean") return { ok: false, status: 400, error: "approved must be true or false" };
    if (!body.approved) {
      entry.settle({ ok: false, reason: "declined", message: "The user declined." });
      return { ok: true, result: { approved: false } };
    }
    if (entry.answering) return { ok: false, status: 409, error: "This card is already being answered." };
    entry.answering = true;
    try {
      const input = entry.event.input;
      return input.kind === "propose"
        ? await answerPropose(requestId, entry, input, body as VaultCardAnswer)
        : await answerRead(requestId, entry, input, body as VaultCardAnswer);
    } catch (e) {
      if (e instanceof VaultError) return { ok: false, status: e.status === 423 ? 423 : e.status === 404 ? 404 : e.status === 409 ? 409 : 400, error: e.message };
      log.error(`answering card ${requestId} failed: ${(e as Error)?.name ?? "error"}`);
      return { ok: false, status: 409, error: "The vault could not complete this; nothing was given to the AI." };
    } finally {
      entry.answering = false;
    }
  }

  function cancelSession(sessionId: string, message: string): boolean {
    const found = pendingOf(sessionId);
    if (!found) return false;
    found[1].settle({ ok: false, reason: "cancelled", message });
    return true;
  }

  return {
    requestSecure,
    requestSealed,
    requestPropose,
    answer,
    cancelSession,
    /** The value the AI filled into a proposal, for the card to show masked; null when none. */
    prefill: (requestId: string): string | null => pending.get(requestId)?.prefill ?? null,
    has: (requestId: string) => pending.has(requestId),
    pendingEvent: (sessionId: string): VaultCardEvent | null => pendingOf(sessionId)?.[1].event ?? null,
    pendingCount: () => pending.size,
  };
}

export type VaultUnlockBroker = ReturnType<typeof createVaultUnlockBroker>;

let chat: VaultCardChat | null = null;
let resolveSession: (sessionId: string) => string = (id) => id;
const shownListeners = new Set<(sessionId: string, requestId: string) => void>();

/** `ws/chat.ts` owns the chats; it registers how to show a card and follow a renamed session. */
export function setVaultCardChat(fn: VaultCardChat | null, canonical?: (sessionId: string) => string): void {
  chat = fn;
  resolveSession = canonical ?? ((id) => id);
}

/** A card was shown: the channels that reach the user away from PPM say so (never what or which). */
export function onVaultCardShown(listener: (sessionId: string, requestId: string) => void): () => void {
  shownListeners.add(listener);
  return () => { shownListeners.delete(listener); };
}

export const vaultUnlockBroker = createVaultUnlockBroker({
  chat: () => chat,
  canonical: (id) => resolveSession(id),
  onShown: (sessionId, requestId) => { for (const l of [...shownListeners]) { try { l(sessionId, requestId); } catch { /* notice only */ } } },
});
