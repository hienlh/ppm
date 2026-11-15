/**
 * Reads chat events that belong to the vault, so the transcript can draw them without ever
 * showing a locked value: the AI's `vault_*` tool calls (Claude `mcp__ppm-sessions__vault_read`,
 * Codex `ppm_sessions:vault_read`) and the `ppm:vault` cards. Pure, so it is tested without the
 * stores.
 *
 * A secure or sealed read answers with the values themselves ("Vault items (secure tier)…"), and
 * that text is also what history hands back after a reload. The card draws a count instead —
 * the values are already in the AI's context and the session's transcript, but never on screen.
 */
import {
  isVaultItemKind, isVaultTier, VAULT_CARD_APPROVAL, VAULT_LIST_TOOL, VAULT_PROPOSE_TOOL, VAULT_READ_TOOL,
  type VaultCardInput, type VaultCardItem, type VaultCardRequester, type VaultItemKind, type VaultTier,
} from "../../shared/vault";
import { tabToolResultText } from "./tab-tool-call";

export type VaultTool = typeof VAULT_LIST_TOOL | typeof VAULT_READ_TOOL | typeof VAULT_PROPOSE_TOOL;

/** Any server's `vault_*` tool: `mcp__<server>__vault_read` (Claude) or `<server>:vault_read` (Codex). */
const TOOL_NAME = new RegExp(`(?:__|:)(${VAULT_LIST_TOOL}|${VAULT_READ_TOOL}|${VAULT_PROPOSE_TOOL})$`);

/** The start of a read that carries secure or sealed values (`valuesText` on the server). */
export const LOCKED_VALUES_PREFIX = "Vault items (";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

export function vaultToolOf(toolName: string): VaultTool | null {
  return (TOOL_NAME.exec(toolName)?.[1] as VaultTool | undefined) ?? null;
}

export type VaultToolCall =
  | { tool: typeof VAULT_LIST_TOOL }
  | { tool: typeof VAULT_READ_TOOL; items: string[]; purpose: string }
  /** Never the proposed value: only whether the AI sent one. */
  | { tool: typeof VAULT_PROPOSE_TOOL; name: string; kind: VaultItemKind | null; tier: VaultTier | null; hasValue: boolean };

/** The vault call an event is, or null. Codex wraps the arguments as `{ server, tool, arguments }`. */
export function vaultToolCall(toolName: string, input: unknown): VaultToolCall | null {
  const tool = vaultToolOf(toolName);
  if (!tool) return null;
  const raw = isObj(input) ? input : {};
  const args = isObj(raw.arguments) ? raw.arguments : raw;
  if (tool === VAULT_LIST_TOOL) return { tool };
  if (tool === VAULT_READ_TOOL) {
    const items = Array.isArray(args.items) ? args.items.filter((i): i is string => typeof i === "string") : [];
    return { tool, items, purpose: typeof args.purpose === "string" ? args.purpose : "" };
  }
  return {
    tool,
    name: str(args.name) ?? "",
    kind: isVaultItemKind(args.kind) ? args.kind : null,
    tier: isVaultTier(args.tier) ? args.tier : null,
    hasValue: typeof args.value === "string" && args.value.length > 0,
  };
}

/**
 * A read result that must not be drawn: how many items it carried. Null for anything else (a
 * public read, an error, "shown to the user only"), which the card may show as it is.
 *
 * Looked for anywhere in the raw output as well as at the start of its text, so a wrapping this
 * file does not know about still hides the values rather than printing them.
 */
export function lockedReadSummary(output: string): { count: number } | null {
  const text = tabToolResultText(output);
  if (text.startsWith(LOCKED_VALUES_PREFIX)) return { count: text.split("\n").filter((l) => l.startsWith("- ")).length };
  if (!output.includes(LOCKED_VALUES_PREFIX)) return null;
  return { count: (output.match(/(?:\n|\\n)- /g) ?? []).length };
}

// ---------------------------------------------------------------------------
// The `ppm:vault` cards
// ---------------------------------------------------------------------------

const cardItem = (v: unknown): VaultCardItem | null =>
  isObj(v) && typeof v.id === "string" && typeof v.name === "string" && isVaultItemKind(v.kind) ? { id: v.id, name: v.name, kind: v.kind } : null;

const requester = (v: unknown): VaultCardRequester => {
  const r = isObj(v) ? v : {};
  return { sessionTitle: str(r.sessionTitle) ?? null, assistant: r.assistant === true, fromTelegram: r.fromTelegram === true };
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** A vault card's input, checked field by field; null for any other approval or a malformed one. */
export function vaultCardInput(tool: unknown, input: unknown): VaultCardInput | null {
  if (tool !== VAULT_CARD_APPROVAL || !isObj(input)) return null;
  const who = requester(input.requester);
  if (input.kind === "read-secure") {
    const items = Array.isArray(input.items) ? input.items.map(cardItem).filter((i): i is VaultCardItem => !!i) : [];
    const requested = Array.isArray(input.requested) ? input.requested.filter((id): id is string => typeof id === "string") : [];
    return { kind: "read-secure", requester: who, purpose: typeof input.purpose === "string" ? input.purpose : "", items, requested,
      attemptsLeft: num(input.attemptsLeft), lockedUntil: num(input.lockedUntil) };
  }
  if (input.kind === "read-sealed") {
    const item = cardItem(input.item);
    if (!item) return null;
    return { kind: "read-sealed", requester: who, purpose: typeof input.purpose === "string" ? input.purpose : "", item,
      allowGiveToAi: input.allowGiveToAi === true, attemptsLeft: num(input.attemptsLeft), lockedUntil: num(input.lockedUntil) };
  }
  if (input.kind === "propose") {
    const enabled = isObj(input.enabled) ? input.enabled : {};
    return {
      kind: "propose", requester: who, name: typeof input.name === "string" ? input.name : "",
      itemKind: isVaultItemKind(input.itemKind) ? input.itemKind : "other",
      suggestedTier: isVaultTier(input.suggestedTier) ? input.suggestedTier : "secure",
      hasPrefill: input.hasPrefill === true,
      enabled: { secure: enabled.secure === true, sealed: enabled.sealed === true },
    };
  }
  return null;
}

/** Who is asking, as the card says it. */
export function requesterLabel(r: VaultCardRequester): string {
  if (r.assistant) return "PPM Assistant";
  return r.sessionTitle ?? "This chat";
}
