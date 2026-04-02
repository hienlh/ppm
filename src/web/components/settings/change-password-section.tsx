import { useState, useCallback } from "react";
import { KeyRound, Check, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import { setAuthToken } from "@/lib/api-client";

export function ChangePasswordSection() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mismatch = confirm.length > 0 && password !== confirm;
  const canSubmit = password.trim().length >= 4 && password === confirm && !saving;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const { token } = await api.put<{ token: string }>("/api/settings/auth/password", {
        password: password.trim(),
        confirm: confirm.trim(),
      });
      // Update localStorage so current session stays authenticated
      setAuthToken(token);
      setSaved(true);
      setPassword("");
      setConfirm("");
      setTimeout(() => {
        setSaved(false);
        setOpen(false);
      }, 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to change password");
    } finally {
      setSaving(false);
    }
  }, [canSubmit, password, confirm]);

  if (!open) {
    return (
      <section className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground">Security</h3>
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs gap-1.5 cursor-pointer"
          onClick={() => setOpen(true)}
        >
          <KeyRound className="size-3.5" />
          Change Password
        </Button>
      </section>
    );
  }

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium text-muted-foreground">Change Password</h3>
      <div className="space-y-2">
        <div className="relative">
          <Input
            type={showPw ? "text" : "password"}
            placeholder="New password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-8 text-xs pr-8"
            autoFocus
          />
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground cursor-pointer"
            onClick={() => setShowPw(!showPw)}
            tabIndex={-1}
          >
            {showPw ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
        </div>
        <Input
          type={showPw ? "text" : "password"}
          placeholder="Confirm password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
          className="h-8 text-xs"
        />
        {mismatch && (
          <p className="text-[11px] text-destructive">Passwords do not match</p>
        )}
        {error && (
          <p className="text-[11px] text-destructive">{error}</p>
        )}
        <div className="flex gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs flex-1 cursor-pointer"
            onClick={() => {
              setOpen(false);
              setPassword("");
              setConfirm("");
              setError(null);
            }}
          >
            Cancel
          </Button>
          <Button
            variant={saved ? "default" : "outline"}
            size="sm"
            className="h-8 text-xs flex-1 cursor-pointer"
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            {saving ? "..." : saved ? <Check className="size-3.5" /> : "Save"}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Min 4 characters. You'll stay logged in on this device.
        </p>
      </div>
    </section>
  );
}
