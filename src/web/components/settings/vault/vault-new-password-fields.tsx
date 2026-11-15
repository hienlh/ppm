/**
 * A new tier password typed twice, with a strength meter and the tier's minimum length — used
 * when a tier is turned on and when its password is changed.
 */
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { passwordStrength } from "@/lib/vault-password-strength";
import { VAULT_MIN_PASSWORD_LENGTH, type VaultLockedTier } from "../../../../shared/vault";

const METER = ["bg-error", "bg-error", "bg-warning", "bg-success", "bg-success"];

/** Why the two fields cannot be saved yet, or null when they can. */
export function newPasswordProblem(tier: VaultLockedTier, password: string, confirm: string): string | null {
  const min = VAULT_MIN_PASSWORD_LENGTH[tier];
  if ([...password].length < min) return `At least ${min} characters.`;
  if (password !== confirm) return "The two passwords differ.";
  return null;
}

export function VaultNewPasswordFields({ tier, password, confirm, onPassword, onConfirm, disabled, label = "New password" }: {
  tier: VaultLockedTier;
  password: string;
  confirm: string;
  onPassword: (v: string) => void;
  onConfirm: (v: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const min = VAULT_MIN_PASSWORD_LENGTH[tier];
  const strength = passwordStrength(password, min);
  const mismatch = confirm.length > 0 && confirm !== password;
  return (
    <div className="space-y-2">
      <Input type="password" autoComplete="new-password" spellCheck={false} aria-label={label} placeholder={label}
        value={password} onChange={(e) => onPassword(e.target.value)} disabled={disabled} className="h-11 md:h-9" />
      <div className="flex items-center gap-2" data-vault-strength={strength.score}>
        <div className="flex flex-1 gap-1" aria-hidden>
          {[1, 2, 3, 4].map((n) => (
            <span key={n} className={cn("h-1.5 flex-1 rounded-full", password && strength.score >= n ? METER[strength.score] : "bg-panel-2")} />
          ))}
        </div>
        <span className="w-20 text-right text-[11px] text-text-subtle">{password ? strength.label : `${min}+ characters`}</span>
      </div>
      <Input type="password" autoComplete="new-password" spellCheck={false} aria-label="Type it again" placeholder="Type it again"
        value={confirm} onChange={(e) => onConfirm(e.target.value)} disabled={disabled} aria-invalid={mismatch} className="h-11 md:h-9" />
      {mismatch && <p className="text-[11px] text-error">The two passwords differ.</p>}
    </div>
  );
}

export function ForgetPasswordWarning() {
  return (
    <p className="rounded-md border border-error/50 bg-error/10 p-2 text-xs font-medium text-error" data-vault-forget-warning="">
      Forget this password and every item in this tier is lost for good; PPM cannot recover it.
    </p>
  );
}
