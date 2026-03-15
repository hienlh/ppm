import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setAuthToken } from "@/lib/api-client";
import { Lock, AlertCircle } from "lucide-react";
import { useSettingsStore } from "@/stores/settings-store";

interface LoginScreenProps {
  onSuccess: () => void;
}

export function LoginScreen({ onSuccess }: LoginScreenProps) {
  const [token, setToken] = useState("");
  const deviceName = useSettingsStore((s) => s.deviceName);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim()) return;

    setLoading(true);
    setError(null);

    try {
      // Store token first, then validate via auth check
      setAuthToken(token.trim());
      const res = await fetch("/api/auth/check", {
        headers: { Authorization: `Bearer ${token.trim()}` },
      });
      const json = await res.json();

      if (!json.ok) {
        throw new Error(json.error ?? "Invalid token");
      }

      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
      // Clear invalid token
      localStorage.removeItem("ppm-auth-token");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm bg-surface rounded-lg border border-border p-6 space-y-6">
        <div className="text-center space-y-2">
          <div className="flex items-center justify-center size-12 mx-auto rounded-full bg-surface-elevated">
            <Lock className="size-6 text-primary" />
          </div>
          <h1 className="text-xl font-semibold text-foreground">PPM</h1>
          {deviceName && (
            <p className="text-xs text-text-subtle bg-surface-elevated inline-block px-2 py-0.5 rounded-full">
              {deviceName}
            </p>
          )}
          <p className="text-sm text-text-secondary">
            Enter your access password to unlock
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Input
              type="password"
              placeholder="Auth token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="h-11 bg-background border-border"
              autoFocus
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 text-error text-sm">
              <AlertCircle className="size-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <Button
            type="submit"
            disabled={loading || !token.trim()}
            className="w-full h-11"
          >
            {loading ? "Checking..." : "Unlock"}
          </Button>
        </form>
      </div>
    </div>
  );
}
