/**
 * The composer's turn chips: one per pasted turn link, resolved to the turn's title, number and
 * prompt before the message may go.
 *
 * Held per conversation like the reply is (`owner`): switching to another session shows that
 * session's draft chips, and only resolved chips are ever saved into a draft or sent. A chip
 * still resolving, or one whose turn is gone, holds the send back with a reason.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api-client";
import { turnKey, turnMetaPath, type ParsedTurnLink, type TurnLinkTarget } from "@/lib/turn-link";
import { MAX_TURN_REFS, validateTurnRef, type TurnReference } from "../../shared/chat-turn-ref";
import { SESSION_ID_RE } from "../../shared/session-turn-ids";

export type ComposerTurnChip =
  /** `nonce` names this one paste's request, so its answer lands on this chip and no other. */
  | { key: string; status: "loading"; target: TurnLinkTarget; nonce: number }
  | { key: string; status: "ready"; target: TurnLinkTarget; ref: TurnReference }
  | { key: string; status: "error"; target: TurnLinkTarget; reason: string };

/** What `GET …/turns/:turnId` answers. */
interface TurnMeta {
  sessionId?: unknown;
  n?: unknown;
  startedAt?: unknown;
  prompt?: unknown;
  sessionTitle?: unknown;
}

const GONE_CODES = new Set(["not_found", "rolled_back", "session_missing"]);
export const GONE_REASON = "No longer available";
const FAILED_REASON = "Could not load this turn";

const readyChip = (ref: TurnReference): ComposerTurnChip => ({ key: turnKey(ref), status: "ready", target: ref, ref });
const clip = (text: string, max: number) => Array.from(text).slice(0, max).join("");
let nextNonce = 0;

/** The reference a chip sends, built from the link and the server's answer about it. */
export function turnRefFromMeta(link: TurnLinkTarget, meta: TurnMeta): TurnReference | null {
  const prompt = typeof meta.prompt === "string" ? meta.prompt.split("\n", 1)[0]!.trim() : "";
  const title = typeof meta.sessionTitle === "string" && meta.sessionTitle.trim() ? meta.sessionTitle.trim() : prompt || "Untitled chat";
  // The id that owns the transcript: a Codex session renamed since the link was copied.
  const sessionId = typeof meta.sessionId === "string" && SESSION_ID_RE.test(meta.sessionId) ? meta.sessionId : link.sessionId;
  return validateTurnRef({
    version: 1, projectName: link.projectName, providerId: link.providerId, sessionId, turnId: link.turnId,
    n: meta.n, title: clip(title, 200), prompt: clip(prompt, 300), at: meta.startedAt,
  });
}

/** Why the send button waits, or null when every chip is ready. */
export function turnChipsBlockReason(chips: readonly ComposerTurnChip[]): string | null {
  if (chips.some((c) => c.status === "loading")) return "Loading the referenced turns…";
  if (chips.some((c) => c.status === "error")) return "Remove the turns that can no longer be referenced";
  return null;
}

/** The chip a link resolves to: ready, or an error that can only be removed. */
async function resolveChip(link: ParsedTurnLink): Promise<ComposerTurnChip> {
  const key = turnKey(link);
  try {
    const ref = turnRefFromMeta(link, await api.get<TurnMeta>(turnMetaPath(link)));
    return ref ? { key, status: "ready", target: link, ref } : { key, status: "error", target: link, reason: FAILED_REASON };
  } catch (e) {
    const code = e instanceof ApiError ? e.code : undefined;
    return { key, status: "error", target: link, reason: code && GONE_CODES.has(code) ? GONE_REASON : FAILED_REASON };
  }
}

export function useComposerTurnRefs({ owner, draftRefs, initialRefs }: {
  /** The conversation the composer is writing in; chips belong to it. */
  owner: string;
  /** The chips the saved draft of this conversation holds. */
  draftRefs?: TurnReference[] | null;
  /** Chips a forked tab opens with, from the message it was forked at. */
  initialRefs?: TurnReference[] | null;
}) {
  const [selection, setSelection] = useState<{ owner: string; chips: ComposerTurnChip[] } | null>(
    () => (initialRefs?.length ? { owner, chips: initialRefs.map(readyChip) } : null),
  );
  // Bumped by every change the user made, so the composer saves its draft with the new chips.
  const [changeSignal, setChangeSignal] = useState(0);
  const chips = useMemo(
    () => (selection?.owner === owner ? selection.chips : (draftRefs ?? []).map(readyChip)),
    [selection, owner, draftRefs],
  );
  const refs = useMemo(() => chips.flatMap((c) => (c.status === "ready" ? [c.ref] : [])), [chips]);
  const chipsRef = useRef(chips);
  chipsRef.current = chips;
  const refsRef = useRef(refs);
  refsRef.current = refs;

  /** A change the user made to this conversation's chips. */
  const edit = useCallback((next: (prev: ComposerTurnChip[]) => ComposerTurnChip[]) => {
    setSelection((prev) => ({ owner, chips: next(prev?.owner === owner ? prev.chips : chipsRef.current) }));
    setChangeSignal((n) => n + 1);
  }, [owner]);

  /** Add a chip per new link, at most {@link MAX_TURN_REFS} in all; each is resolved at once. */
  const addLinks = useCallback((links: readonly ParsedTurnLink[]) => {
    const present = new Set(chipsRef.current.flatMap((c) => (c.status === "ready" ? [c.key, turnKey(c.ref)] : [c.key])));
    const fresh = links.filter((l) => !present.has(turnKey(l)));
    const room = Math.max(0, MAX_TURN_REFS - chipsRef.current.length);
    if (fresh.length > room) toast.error(`A message can reference at most ${MAX_TURN_REFS} turns`);
    const added = fresh.slice(0, room).map((link) => ({ link, nonce: ++nextNonce }));
    if (!added.length) return;
    edit((prev) => [...prev, ...added.map(({ link, nonce }): ComposerTurnChip => ({ key: turnKey(link), status: "loading", target: link, nonce }))]);
    for (const { link, nonce } of added) {
      void resolveChip(link).then((chip) => {
        // Lands only where its own loading chip still is: not after a removal, a send, or in
        // another conversation the user has moved to since.
        setSelection((prev) => (prev?.chips.some((c) => c.status === "loading" && c.nonce === nonce)
          ? { ...prev, chips: prev.chips.map((c) => (c.status === "loading" && c.nonce === nonce ? chip : c)) }
          : prev));
        setChangeSignal((n) => n + 1);
      });
    }
  }, [edit]);

  const remove = useCallback((key: string) => edit((prev) => prev.filter((c) => c.key !== key)), [edit]);

  /**
   * Put chips back from a stored message (edit, restore, a rejected send); null clears them.
   * `forOwner` re-homes them, for a conversation whose session id has just changed.
   */
  const replace = useCallback((next: readonly TurnReference[] | null | undefined, forOwner = owner) => {
    const list = (next ?? []).map(readyChip);
    chipsRef.current = list;
    refsRef.current = next ? [...next] : [];
    setSelection({ owner: forOwner, chips: list });
  }, [owner]);

  /** Carry the chips as they stand — loading ones too — to the id the conversation moved to. */
  const moveTo = useCallback((nextOwner: string) => {
    const current = chipsRef.current;
    setSelection({ owner: nextOwner, chips: current });
  }, []);

  return { chips, refs, refsRef, changeSignal, blockedReason: turnChipsBlockReason(chips), addLinks, remove, replace, moveTo };
}
