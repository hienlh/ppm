import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setAuthToken } from "@/lib/api-client";
import {
  AlertCircle,
  Eye,
  EyeOff,
  Monitor,
  Smartphone,
  Bug,
  Github,
  Coffee,
} from "lucide-react";
import { useSettingsStore } from "@/stores/settings-store";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { openBugReportPopup } from "@/lib/report-bug";
import { SupportDialog } from "@/components/auth/support-dialog";
import { BugReportPopup } from "@/components/shared/bug-report-popup";
import { cn } from "@/lib/utils";

interface LoginScreenProps {
  onSuccess: () => void;
}

const REPO_URL = "https://github.com/hienlh/ppm";

// Decorative, one-off background layers (blue glow + faint dot grid). Not part
// of the theme token set, so kept inline rather than introducing new tokens.
const GLOW_STYLE: React.CSSProperties = {
  background:
    "radial-gradient(80% 60% at 50% -10%, color-mix(in srgb, var(--accent) 12%, transparent) 0%, transparent 60%)",
};
const DOTS_STYLE: React.CSSProperties = {
  backgroundImage:
    "radial-gradient(circle at 1px 1px, rgba(255,255,255,.035) 1px, transparent 0)",
  backgroundSize: "26px 26px",
};

export function LoginScreen({ onSuccess }: LoginScreenProps) {
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const deviceName = useSettingsStore((s) => s.deviceName);
  const version = useSettingsStore((s) => s.version);
  const tunnelActive = useSettingsStore((s) => s.tunnelActive);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const isMobile = useIsMobile();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim()) {
      setError("Enter your password to continue");
      return;
    }

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
        throw new Error(json.error ?? "Invalid password");
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

  const DeviceIcon = isMobile ? Smartphone : Monitor;

  return (
    <div className="app-backdrop relative min-h-dvh overflow-hidden flex items-center justify-center p-6">
      {/* Background overlays */}
      <div className="pointer-events-none absolute inset-0" style={GLOW_STYLE} />
      <div className="pointer-events-none absolute inset-0" style={DOTS_STYLE} />

      <div className="relative flex w-full max-w-[392px] flex-col items-center gap-[22px] text-center">
        {/* Brand mark */}
        <div className="flex flex-col items-center gap-4">
          <div className="flex size-16 items-center justify-center rounded-2xl border border-border bg-background shadow-float">
            <div className="flex size-[52px] items-center justify-center rounded-xl bg-surface-elevated">
              <span className="text-[15px] font-bold tracking-wide text-primary">PPM</span>
            </div>
          </div>
          <div>
            <h1 className="mb-1.5 text-2xl font-semibold tracking-tight text-foreground">
              Unlock your workspace
            </h1>
            <p className="text-sm text-text-secondary">
              Enter your access password to unlock
            </p>
          </div>

          {/* Context chips */}
          <div className="flex flex-wrap items-center justify-center gap-2">
            {deviceName && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-elevated px-2.5 py-0.5 font-mono text-[11px] text-text-secondary">
                <DeviceIcon className="size-3 text-text-subtle" />
                {deviceName}
              </span>
            )}
            {isMobile ? (
              (tunnelActive || version) && (
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px]",
                    tunnelActive
                      ? "border-success/30 bg-success/10 text-success"
                      : "border-border bg-surface-elevated text-text-secondary",
                  )}
                >
                  {tunnelActive && <span className="size-1.5 animate-pulse rounded-full bg-success" />}
                  {tunnelActive ? "tunnel · " : ""}
                  {version ? `v${version}` : ""}
                </span>
              )
            ) : (
              <>
                {version && (
                  <span className="inline-flex items-center rounded-full border border-border bg-surface-elevated px-2.5 py-0.5 font-mono text-[11px] text-text-secondary">
                    v{version}
                  </span>
                )}
                {tunnelActive && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 py-0.5 font-mono text-[11px] text-success">
                    <span className="size-1.5 animate-pulse rounded-full bg-success" />
                    tunnel active
                  </span>
                )}
              </>
            )}
          </div>
        </div>

        <form onSubmit={handleSubmit} className="flex w-full flex-col gap-3">
          <div className="relative w-full">
            <Input
              type={showToken ? "text" : "password"}
              placeholder="Password"
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                if (error) setError(null);
              }}
              className="h-[50px] rounded-xl bg-surface-elevated pr-12 text-[15px] max-md:text-base"
              autoFocus
            />
            <button
              type="button"
              onClick={() => setShowToken((v) => !v)}
              aria-label={showToken ? "Hide password" : "Show password"}
              className="absolute right-2 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-lg text-text-subtle can-hover:hover:bg-surface-elevated can-hover:hover:text-foreground"
            >
              {showToken ? <EyeOff className="size-[18px]" /> : <Eye className="size-[18px]" />}
            </button>
          </div>

          {error && (
            <div className="flex items-center gap-2 text-[13px] text-error">
              <AlertCircle className="size-[15px] shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <Button type="submit" disabled={loading} className="h-[50px] w-full text-[15px]">
            {loading ? "Checking…" : "Unlock"}
          </Button>
        </form>

        <div className="hidden h-px w-full bg-border md:block" />

        {/* Footer links */}
        <div className="flex items-center justify-center gap-5">
          <button
            type="button"
            onClick={() => openBugReportPopup(version)}
            className="inline-flex items-center gap-1.5 text-xs text-text-subtle can-hover:hover:text-foreground"
          >
            <Bug className="size-[18px] md:size-3.5" />
            <span className="max-md:sr-only">Report Bug</span>
          </button>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-text-subtle can-hover:hover:text-foreground"
          >
            <Github className="size-[18px] md:size-3.5" />
            <span className="max-md:sr-only">Repo</span>
          </a>
          <button
            type="button"
            onClick={() => setSupportOpen(true)}
            className="inline-flex items-center gap-1.5 text-xs text-text-subtle can-hover:hover:text-foreground"
          >
            <Coffee className="size-[18px] md:size-3.5" />
            <span className="max-md:sr-only">Buy me a coffee</span>
          </button>
        </div>
      </div>

      <SupportDialog open={supportOpen} onOpenChange={setSupportOpen} />
      {/* Self-contained popup listens for the open-bug-report window event that
          the footer's Report Bug button dispatches — the app-level instance is
          only mounted post-auth, so the login screen needs its own. */}
      <BugReportPopup />
    </div>
  );
}
