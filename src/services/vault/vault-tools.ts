import { textResult, type Json } from "../mcp-http-endpoint.ts";
import { getDb, resolveMigratedSession } from "../db.service.ts";
import { createLogger } from "../logger.ts";
import {
  isVaultItemKind, isVaultTier, VAULT_KIND_LABELS, VAULT_LIST_TOOL, VAULT_PROPOSE_TOOL, VAULT_READ_TOOL,
  type VaultItemMeta, type VaultTier,
} from "../../shared/vault.ts";
import { vaultGrants, type VaultGrants } from "./vault-grants.ts";
import { vaultService, type VaultItemValue, type VaultService } from "./vault.service.ts";
import { vaultUnlockBroker, type VaultReadOutcome, type VaultRequestContext, type VaultUnlockBroker } from "./vault-unlock-broker.ts";
import { turnSecretScrubber } from "./turn-secret-scrubber.ts";
import { transcriptRedactor } from "./transcript-redactor.ts";

/**
 * The AI's three vault tools. `vault_list` names every item (never a value), `vault_read` reads
 * items of one tier per call — the public tier at once, the secure tier through a card or an open
 * window for this chat, one sealed item through a card that shows it to the user unless they give
 * it to the AI — and `vault_propose` asks the user to save something.
 *
 * Values handed to the AI are remembered for the rest of the turn (`turn-secret-scrubber.ts`) so
 * that what PPM writes elsewhere — the session trace, the notebook, Telegram, another chat — can
 * keep them out.
 */

const log = createLogger("vault");

const MAX_PURPOSE = 300;
const MAX_ITEMS_PER_READ = 20;

export const VAULT_TOOL_DEFINITIONS: readonly Json[] = [
  {
    name: VAULT_LIST_TOOL,
    description:
      "List the items in the user's PPM vault: id, tier, name and kind, never a value. Tiers: `public` (read freely), "
      + "`secure` (the user unlocks it on a card in PPM) and `sealed` (one item per card; shown to the user unless they give it to you). "
      + "An item may list `files` (photos or PDFs): only the user can open those, in PPM; you cannot read them.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: VAULT_READ_TOOL,
    description:
      "Read items from the user's PPM vault. One tier per call. Public items come back at once. Secure items show the user a card "
      + "where they tick which items to give you and type the vault password; sealed items take exactly one item per call and by "
      + "default are only shown to the user, not to you. Ask only for what the task needs, say why in `purpose`, and never repeat a "
      + "value back unless the user needs to see it, never write one into the notebook, a file or another chat.",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_ITEMS_PER_READ, description: "Item ids (or exact names) from vault_list, all of one tier." },
        purpose: { type: "string", maxLength: MAX_PURPOSE, description: "Why you need them, shown to the user on the card." },
      },
      required: ["items", "purpose"],
      additionalProperties: false,
    },
  },
  {
    name: VAULT_PROPOSE_TOOL,
    description:
      "Propose saving an item to the user's PPM vault. The user picks the tier, can change the name and value, and confirms with that "
      + "tier's password. Only pass `value` if the user already gave it to you in this chat: it is shown masked, with a note that it is "
      + "in the chat's history. Never put a secret in the name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", maxLength: 120 },
        kind: { type: "string", enum: ["ni_number", "address", "passport", "other"] },
        tier: { type: "string", enum: ["public", "secure", "sealed"], description: "Your suggestion; the user decides." },
        value: { type: "string", maxLength: 8000 },
      },
      required: ["name", "kind"],
      additionalProperties: false,
    },
  },
];

const ADVICE = "These came from the user's vault. Use them only for the purpose you gave; do not repeat them back unless the user needs to see them; "
  + "never write them to the notebook, a file, a report or another chat.";

/**
 * A value as the AI reads it. One line stays on the item's line. Several lines go in a fenced block,
 * byte for byte, so a key or a certificate written out from it is exactly what was stored (an
 * indent would have to be taken off again), and no line of it can pass for another item. The
 * fence is longer than any run of backticks inside the value.
 */
export function valueBlock(text: string): string {
  if (!/[\r\n]/.test(text)) return text;
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  const lines = text.split(/\r\n?|\n/).length;
  return `(${lines} lines, exactly as between the fences)\n${fence}\n${text}\n${fence}`;
}

function valuesText(tier: VaultTier, items: VaultItemValue[]): string {
  const lines = items.map((i) => `- ${i.name} (${VAULT_KIND_LABELS[i.kind]}): ${valueBlock(i.value)}${i.note ? `\n  note: ${valueBlock(i.note)}` : ""}`);
  return `${tier === "public" ? "Public vault items:" : `Vault items (${tier} tier). ${ADVICE}`}\n${lines.join("\n")}`;
}

export interface VaultToolCaller {
  sessionId: string;
  title: string | null;
  assistant: boolean;
}

export function createVaultTools(deps: {
  service?: VaultService;
  grants?: VaultGrants;
  broker?: VaultUnlockBroker;
  /** Who started the chat's running turn (`ws`, `telegram`, `watch`…). */
  turnOrigin: (sessionId: string) => Promise<string | undefined> | string | undefined;
  /** Remembers values given to the AI for this turn. */
  hold?: (sessionId: string, items: readonly { name: string; value: string }[]) => void;
}) {
  const service = deps.service ?? vaultService;
  const grants = deps.grants ?? vaultGrants;
  const broker = deps.broker ?? vaultUnlockBroker;
  // Held for the scrubber, and noted for the history files to be rewritten once the turn ends.
  const hold = deps.hold ?? ((sessionId, items) => {
    turnSecretScrubber.hold(sessionId, items);
    transcriptRedactor.note(sessionId, items);
  });

  /** Ids or exact names (case-insensitive) to items; an error text for an unknown one. */
  function resolveItems(refs: unknown): { ok: true; items: VaultItemMeta[] } | { ok: false; error: string } {
    if (!Array.isArray(refs) || refs.length === 0) return { ok: false, error: "`items` must list at least one item id from vault_list." };
    if (refs.length > MAX_ITEMS_PER_READ) return { ok: false, error: `At most ${MAX_ITEMS_PER_READ} items per call.` };
    const all = service.listItems();
    const out: VaultItemMeta[] = [];
    for (const ref of refs) {
      if (typeof ref !== "string") return { ok: false, error: "Every item must be an id or a name." };
      const byId = all.find((i) => i.id === ref);
      const byName = byId ? [] : all.filter((i) => i.name.toLowerCase() === ref.trim().toLowerCase());
      if (byName.length > 1) return { ok: false, error: `More than one item is named "${ref}"; use its id from vault_list.` };
      const item = byId ?? byName[0];
      if (!item) return { ok: false, error: `No vault item "${ref}". Call vault_list to see what exists.` };
      if (!out.some((o) => o.id === item.id)) out.push(item);
    }
    return { ok: true, items: out };
  }

  function outcomeText(outcome: VaultReadOutcome, sessionId: string): Json {
    if (!outcome.ok) return textResult(outcome.message, true);
    if ("shownToUser" in outcome) {
      return textResult(`The user unlocked "${outcome.shownToUser.name}" and it was shown to them only, not to you. Ask them to type what you need, if anything.`);
    }
    hold(sessionId, outcome.items);
    return textResult(valuesText(outcome.tier, outcome.items));
  }

  async function read(caller: VaultToolCaller, args: Json, signal: AbortSignal): Promise<Json> {
    const purpose = typeof args.purpose === "string" ? args.purpose.trim().slice(0, MAX_PURPOSE) : "";
    if (!purpose) return textResult("Say why you need these items in `purpose`; the user sees it.", true);
    const resolved = resolveItems(args.items);
    if (!resolved.ok) return textResult(resolved.error, true);
    const tiers = new Set(resolved.items.map((i) => i.tier));
    if (tiers.size > 1) return textResult("Read one tier per call: split public, secure and sealed items into separate calls.", true);
    const tier = resolved.items[0]!.tier;
    const ids = resolved.items.map((i) => i.id);
    log.info(`read tier=${tier} items=${ids.length} session=${caller.sessionId}`);
    if (tier === "public") return textResult(valuesText("public", service.readPublic(ids)));

    const ctx: VaultRequestContext = { origin: await deps.turnOrigin(caller.sessionId), sessionTitle: caller.title, assistant: caller.assistant };
    if (tier === "secure") {
      // An open window answers without a card only in a turn a person started in PPM; any other
      // turn (another AI's message, a script, Telegram) goes through the card and its rules.
      const key = ctx.origin === "ws" ? grants.keyFor("secure", caller.sessionId, ids) : null;
      if (key) {
        try {
          const items = service.readLocked("secure", ids, key);
          hold(caller.sessionId, items);
          return textResult(valuesText("secure", items));
        } finally {
          key.fill(0);
        }
      }
      return outcomeText(await broker.requestSecure(caller.sessionId, ids, purpose, ctx, signal), caller.sessionId);
    }
    if (ids.length !== 1) return textResult("A sealed item is read one at a time: call vault_read with exactly one sealed item.", true);
    return outcomeText(await broker.requestSealed(caller.sessionId, ids[0]!, purpose, ctx, signal), caller.sessionId);
  }

  async function propose(caller: VaultToolCaller, args: Json, signal: AbortSignal): Promise<Json> {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) return textResult("`name` is required.", true);
    if (!isVaultItemKind(args.kind)) return textResult("`kind` must be ni_number, address, passport or other.", true);
    const tier = args.tier === undefined ? "secure" : args.tier;
    if (!isVaultTier(tier)) return textResult("`tier` must be public, secure or sealed.", true);
    const value = typeof args.value === "string" && args.value.length > 0 ? args.value : null;
    const ctx: VaultRequestContext = { origin: await deps.turnOrigin(caller.sessionId), sessionTitle: caller.title, assistant: caller.assistant };
    const outcome = await broker.requestPropose(caller.sessionId, { name: name.slice(0, 120), kind: args.kind, tier, value }, ctx, signal);
    if (!outcome.ok) return textResult(outcome.message, true);
    return textResult(`The user saved "${outcome.saved.name}" to the ${outcome.saved.tier} tier of the vault (id ${outcome.saved.id}).`);
  }

  return {
    async call(caller: VaultToolCaller, name: string, rawArgs: unknown, signal: AbortSignal): Promise<Json> {
      const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? (rawArgs as Json) : {};
      try {
        if (name === VAULT_LIST_TOOL) {
          const s = service.status();
          // Files show as label, type and size only: no AI opens one, and their original names stay encrypted.
          const items = service.listItems().map((i) => ({
            id: i.id, tier: i.tier, name: i.name, kind: i.kind, updatedAt: new Date(i.updatedAt).toISOString(),
            ...(i.attachments?.length ? { files: i.attachments.map((f) => ({ label: f.label, type: f.type, size: f.size })) } : {}),
          }));
          return textResult(JSON.stringify({ tiers: { public: true, secure: s.tiers.secure.enabled, sealed: s.tiers.sealed.enabled }, items }, null, 2));
        }
        if (name === VAULT_READ_TOOL) return await read(caller, args, signal);
        if (name === VAULT_PROPOSE_TOOL) return await propose(caller, args, signal);
        return textResult(`Unknown tool: ${name}`, true);
      } catch (e) {
        log.warn(`${name} failed: ${(e as Error)?.name ?? "error"}`);
        return textResult(`The vault could not do that: ${e instanceof Error && e.message.length < 200 ? e.message : "an error occurred"}`, true);
      }
    },
  };
}

/** Whether an extension bound the chat (it then never gets the vault, policy or not). */
export function boundToExtension(sessionId: string): boolean {
  try {
    return !!getDb().query("SELECT 1 FROM extension_session_bindings WHERE session_id = ? OR session_id = ?")
      .get(sessionId, resolveMigratedSession(sessionId));
  } catch {
    return true;
  }
}

export const vaultTools = createVaultTools({
  turnOrigin: async (sessionId) => (await import("../../server/ws/chat.ts")).getSessionTurnOwnerForVault(sessionId),
});
