/**
 * The vault's cards in a chat (`approval.tool === "ppm:vault"`): unlock secure items for the AI,
 * unlock one sealed item (shown to the user unless they give it to the AI), or save what the AI
 * proposes. Every answer goes over HTTP; see `vault-card-parts.tsx`.
 */
import { useState } from "react";
import { Lock } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { VAULT_KIND_LABELS, VAULT_WINDOW_MINUTES, type VaultCardAnswer, type VaultCardInput, type VaultWindowMinutes } from "../../../shared/vault";
import {
  useVaultCardAnswer, VaultCardActions, VaultCardButton, VaultCardFailure, VaultCardRequesterLine, VaultCheckRow, VaultPasswordInput,
} from "./vault-card-parts";
import { VaultSealedCard } from "./vault-sealed-card";
import { VaultProposeCard } from "./vault-propose-card";

type ReadSecureInput = Extract<VaultCardInput, { kind: "read-secure" }>;

export function VaultUnlockCard({ requestId, input }: { requestId: string; input: VaultCardInput }) {
  if (input.kind === "read-secure") return <VaultReadSecureCard requestId={requestId} input={input} />;
  if (input.kind === "read-sealed") return <VaultSealedCard requestId={requestId} input={input} />;
  return <VaultProposeCard requestId={requestId} input={input} />;
}

/** The answer a read-secure card sends for what the user picked. */
export function readSecureAnswer(password: string, itemIds: string[], minutes: VaultWindowMinutes | null): VaultCardAnswer {
  return minutes === null
    ? { approved: true, password, itemIds, mode: "once" }
    : { approved: true, password, itemIds, mode: "window", minutes };
}

function VaultReadSecureCard({ requestId, input }: { requestId: string; input: ReadSecureInput }) {
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(input.requested.filter((id) => input.items.some((i) => i.id === id))));
  const [windowMinutes, setWindowMinutes] = useState<VaultWindowMinutes | null>(null);
  const [password, setPassword] = useState("");
  const { busy, failure, lockedOut, send } = useVaultCardAnswer(requestId, input.lockedUntil);
  const canApprove = !busy && !lockedOut && ticked.size > 0 && password.length > 0;

  const toggle = (id: string, on: boolean) => setTicked((cur) => {
    const next = new Set(cur);
    if (on) next.add(id); else next.delete(id);
    return next;
  });
  // In the order the card lists them, so the request reads the same as the screen.
  const approve = () => void send(readSecureAnswer(password, input.items.filter((i) => ticked.has(i.id)).map((i) => i.id), windowMinutes));

  return (
    <div className="rounded-lg border-2 border-warning/40 bg-warning/10 p-3 space-y-3 select-text" data-vault-card="read-secure">
      <div className="flex items-center gap-2 text-warning text-sm font-medium">
        <Lock className="size-4" />
        <span>Unlock vault items for the AI</span>
      </div>
      <VaultCardRequesterLine requester={input.requester} purpose={input.purpose} />
      <fieldset className="space-y-0.5" data-vault-items="">
        <legend className="mb-1 text-[11px] text-text-subtle">Secure items — tick what the AI may read</legend>
        {input.items.map((item) => (
          <VaultCheckRow key={item.id} checked={ticked.has(item.id)} onChange={(on) => toggle(item.id, on)} disabled={busy} dataAttr={item.id}>
            {item.name} <span className="text-text-subtle">· {VAULT_KIND_LABELS[item.kind]}</span>
          </VaultCheckRow>
        ))}
      </fieldset>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="How long">
        <ModeButton active={windowMinutes === null} onClick={() => setWindowMinutes(null)}>Read once</ModeButton>
        {VAULT_WINDOW_MINUTES.map((m) => (
          <ModeButton key={m} active={windowMinutes === m} onClick={() => setWindowMinutes(m)}>Open {m} min for this chat</ModeButton>
        ))}
      </div>
      {windowMinutes !== null && (
        <p className="text-[11px] text-text-subtle">For {windowMinutes} minutes this chat's AI reads the ticked items again without asking.</p>
      )}
      <VaultCardFailure failure={failure} />
      <form
        className="flex flex-col gap-2 md:flex-row md:items-center"
        onSubmit={(e) => {
          e.preventDefault();
          if (canApprove) approve();
        }}
      >
        <VaultPasswordInput label="Secure tier password" value={password} onChange={setPassword} disabled={busy} invalid={!!failure} />
        <VaultCardActions>
          <VaultCardButton kind="primary" type="submit" disabled={!canApprove}>Approve</VaultCardButton>
          <VaultCardButton kind="secondary" disabled={busy} onClick={() => void send({ approved: false })}>Decline</VaultCardButton>
        </VaultCardActions>
      </form>
    </div>
  );
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        "min-h-11 md:min-h-8 rounded-full border px-3 text-xs transition-colors",
        active ? "border-primary bg-primary/15 text-text-primary" : "border-border text-text-secondary can-hover:hover:bg-panel-2",
      )}
    >
      {children}
    </button>
  );
}
