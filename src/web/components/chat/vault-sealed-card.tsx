/**
 * The card for one sealed item: drawn apart from every other card (red lock, red border), and by
 * default it shows the value to the user only. Giving it to the AI is a separate, explicit tick
 * below the main button — and is not offered at all for a turn started from Telegram.
 */
import { useState } from "react";
import { Lock } from "@/lib/icons";
import { VAULT_HISTORY_LIMIT, VAULT_KIND_LABELS, type VaultCardAnswer, type VaultCardInput } from "../../../shared/vault";
import {
  useVaultCardAnswer, VaultCardActions, VaultCardButton, VaultCardFailure, VaultCardRequesterLine, VaultCheckRow, VaultPasswordInput,
} from "./vault-card-parts";
import { showVaultValue } from "./vault-shown-value";

type ReadSealedInput = Extract<VaultCardInput, { kind: "read-sealed" }>;

/** The answer a sealed card sends: the value goes to the AI only when allowed and ticked. */
export function readSealedAnswer(password: string, giveToAi: boolean, allowGiveToAi: boolean): VaultCardAnswer {
  return { approved: true, password, giveToAi: allowGiveToAi && giveToAi };
}

export function VaultSealedCard({ requestId, input }: { requestId: string; input: ReadSealedInput }) {
  const [password, setPassword] = useState("");
  const [giveToAi, setGiveToAi] = useState(false);
  const { busy, failure, lockedOut, send } = useVaultCardAnswer(requestId, input.lockedUntil);
  const canApprove = !busy && !lockedOut && password.length > 0;
  const toAi = input.allowGiveToAi && giveToAi;

  const approve = async () => {
    const result = await send(readSealedAnswer(password, giveToAi, input.allowGiveToAi));
    if (result?.shown) showVaultValue(requestId, result.shown);
  };

  return (
    <div className="rounded-lg border-2 border-error bg-error/10 p-3 space-y-3 select-text" data-vault-card="read-sealed">
      <div className="flex items-center gap-2 text-error text-sm font-semibold">
        <Lock className="size-5" />
        <span>Sealed vault item</span>
      </div>
      <p className="text-sm text-text-primary" data-vault-item="">
        <span className="font-medium">{input.item.name}</span>
        <span className="text-text-subtle"> · {VAULT_KIND_LABELS[input.item.kind]}</span>
      </p>
      <VaultCardRequesterLine requester={input.requester} purpose={input.purpose} />
      <VaultCardFailure failure={failure} />
      <form
        className="flex flex-col gap-2 md:flex-row md:items-center"
        onSubmit={(e) => {
          e.preventDefault();
          if (canApprove) void approve();
        }}
      >
        <VaultPasswordInput label="Sealed tier password" value={password} onChange={setPassword} disabled={busy} invalid={!!failure} />
        <VaultCardActions>
          <VaultCardButton kind="primary" danger type="submit" disabled={!canApprove}>{toAi ? "Give to the AI once" : "Show to me"}</VaultCardButton>
          <VaultCardButton kind="secondary" disabled={busy} onClick={() => void send({ approved: false })}>Decline</VaultCardButton>
        </VaultCardActions>
      </form>
      {input.allowGiveToAi ? (
        <div className="border-t border-error/30 pt-2" data-vault-give-to-ai="">
          <VaultCheckRow checked={giveToAi} onChange={setGiveToAi} disabled={busy} dataAttr="give-to-ai">
            Let the AI read this item once (the AI will see the value)
          </VaultCheckRow>
          <p className="mt-1 text-[11px] text-text-subtle" data-vault-history-limit="">{VAULT_HISTORY_LIMIT}</p>
        </div>
      ) : (
        <p className="text-[11px] text-text-subtle">This turn came from Telegram, so the value can only be shown to you.</p>
      )}
    </div>
  );
}
