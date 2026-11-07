import { useCallback, useEffect, useRef, useState } from "react";
import {
  ExternalLink,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
} from "@/lib/icons";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { UsageInfo } from "../../../../types/chat";
import { AccountUsageBar } from "./account-bucket-row";
import { formatResetTime } from "./account-usage-format";
import {
  AccountCardRow,
  AccountCardShell,
  AccountsPaneHeader,
  AccountsPaneMessage,
} from "./accounts-pane-header";

export type AntigravityStrategy = "round-robin" | "fill-first" | "lowest-usage";

export interface AntigravityAccount {
  id: string;
  label: string;
  email?: string | null;
  planType?: string | null;
  home: string;
  status: "active" | "disabled";
  addedAt: string;
}

const STRATEGIES: { value: AntigravityStrategy; label: string; hint: string }[] = [
  { value: "round-robin", label: "Round-robin", hint: "Take the next account each time." },
  { value: "fill-first", label: "Fill-first", hint: "Stay on one account until it runs out." },
  { value: "lowest-usage", label: "Lowest usage", hint: "Pick whichever has the most left." },
];

function toPct(v?: number): number | null {
  return v != null ? Math.round(v * 100) : null;
}

export function AntigravityAccountsSection() {
  const [accounts, setAccounts] = useState<AntigravityAccount[]>([]);
  const [strategy, setStrategy] = useState<AntigravityStrategy>("round-robin");
  const [usages, setUsages] = useState<Record<string, UsageInfo>>({});
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [toggling, setToggling] = useState<Set<string>>(new Set());

  const [dialog, setDialog] = useState<"add" | "rotation" | null>(null);
  const [reloginAccount, setReloginAccount] = useState<AntigravityAccount | null>(null);
  const [label, setLabel] = useState("");
  const [loginFlow, setLoginFlow] = useState<{ id: string; authUrl: string } | null>(null);
  const [loginStarting, setLoginStarting] = useState(false);
  const [authCode, setAuthCode] = useState("");
  const [submittingCode, setSubmittingCode] = useState(false);
  const [dialogErr, setDialogErr] = useState<string | null>(null);

  const loginGenerationRef = useRef(0);
  const startingRef = useRef(false);
  const submittingRef = useRef(false);
  const pendingLoginIdRef = useRef<string | null>(null);
  const stopPollRef = useRef<(() => void) | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await api.get<{ accounts: AntigravityAccount[]; strategy: AntigravityStrategy }>(
        "/api/antigravity-accounts",
      );
      setAccounts(data.accounts);
      setStrategy(data.strategy);
      const u = await api.get<Record<string, UsageInfo>>("/api/antigravity-accounts/usage");
      setUsages(u);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const releaseLogin = useCallback(() => {
    loginGenerationRef.current += 1;
    startingRef.current = false;
    submittingRef.current = false;
    stopPollRef.current?.();
    stopPollRef.current = null;
    const pendingId = pendingLoginIdRef.current;
    pendingLoginIdRef.current = null;
    if (pendingId) {
      void api.del(`/api/antigravity-accounts/login/${pendingId}`).catch(() => {});
    }
  }, []);

  useEffect(() => releaseLogin, [releaseLogin]);

  const resetLoginFlow = useCallback(() => {
    releaseLogin();
    setLoginFlow(null);
    setLoginStarting(false);
    setAuthCode("");
    setSubmittingCode(false);
  }, [releaseLogin]);

  const closeAddDialog = useCallback(() => {
    resetLoginFlow();
    setDialogErr(null);
    setLabel("");
    setReloginAccount(null);
    setDialog(null);
  }, [resetLoginFlow]);

  const pollLogin = useCallback(
    (id: string) => {
      const deadline = Date.now() + 610_000;
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      stopPollRef.current = () => {
        stopped = true;
        clearTimeout(timer);
      };
      const tick = async () => {
        if (stopped) return;
        let status: { state: "pending" | "done" | "error"; error?: string } | null = null;
        try {
          status = await api.get<{ state: "pending" | "done" | "error"; error?: string }>(
            `/api/antigravity-accounts/login/${id}/status`,
          );
        } catch {
          // ignore transient network errors
        }
        if (stopped) return;
        if (status?.state === "done") {
          pendingLoginIdRef.current = null;
          resetLoginFlow();
          setDialogErr(null);
          setLabel("");
          setReloginAccount(null);
          setDialog(null);
          setMsg("Antigravity Google account connected.");
          await load();
          return;
        }
        if (status?.state === "error" || Date.now() > deadline) {
          pendingLoginIdRef.current = null;
          resetLoginFlow();
          setDialogErr(status?.state === "error" ? (status.error ?? "Login failed.") : "Login timed out.");
          return;
        }
        timer = setTimeout(tick, 2_000);
      };
      void tick();
    },
    [load, resetLoginFlow],
  );

  const startLogin = useCallback(
    async (targetRelogin?: AntigravityAccount | null) => {
      if (startingRef.current || pendingLoginIdRef.current || submittingRef.current) return;
      startingRef.current = true;
      const generation = ++loginGenerationRef.current;
      setLoginStarting(true);
      setDialogErr(null);
      try {
        const res = await api.post<{ id: string; authUrl: string }>("/api/antigravity-accounts/login", {
          ...(label.trim() ? { label: label.trim() } : {}),
          ...(targetRelogin ? { accountId: targetRelogin.id } : {}),
        });
        if (generation !== loginGenerationRef.current) {
          void api.del(`/api/antigravity-accounts/login/${res.id}`).catch(() => {});
          return;
        }
        pendingLoginIdRef.current = res.id;
        setLoginFlow(res);
        pollLogin(res.id);
      } catch (e) {
        if (generation === loginGenerationRef.current) {
          setDialogErr((e as Error).message);
        }
      } finally {
        if (generation === loginGenerationRef.current) {
          startingRef.current = false;
          setLoginStarting(false);
        }
      }
    },
    [label, pollLogin],
  );

  const submitCode = useCallback(async () => {
    if (!loginFlow || !authCode.trim() || submittingRef.current) return;
    const generation = loginGenerationRef.current;
    submittingRef.current = true;
    setSubmittingCode(true);
    setDialogErr(null);
    try {
      const status = await api.post<{ state: "pending" | "done" | "error"; error?: string }>(
        `/api/antigravity-accounts/login/${loginFlow.id}/callback`,
        {
          code: authCode.trim(),
        },
      );
      if (generation !== loginGenerationRef.current) return;
      if (status?.state === "error") {
        pendingLoginIdRef.current = null;
        resetLoginFlow();
        setDialogErr(status.error ?? "Login failed.");
        return;
      }
      if (status?.state !== "done") {
        return;
      }
      pendingLoginIdRef.current = null;
      resetLoginFlow();
      setLabel("");
      setReloginAccount(null);
      setDialog(null);
      setMsg("Antigravity Google account connected.");
      await load();
    } catch (e) {
      if (generation === loginGenerationRef.current) {
        pendingLoginIdRef.current = null;
        resetLoginFlow();
        setDialogErr((e as Error).message);
      }
    } finally {
      if (generation === loginGenerationRef.current) {
        submittingRef.current = false;
        setSubmittingCode(false);
      }
    }
  }, [loginFlow, authCode, load, resetLoginFlow]);

  const toggleStatus = useCallback(async (id: string, current: "active" | "disabled") => {
    setToggling((prev) => new Set(prev).add(id));
    setErr(null);
    try {
      const next = current === "disabled" ? "active" : "disabled";
      await api.patch(`/api/antigravity-accounts/${id}`, { status: next });
      setAccounts((prev) => prev.map((a) => (a.id === id ? { ...a, status: next } : a)));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setToggling((prev) => {
        const copy = new Set(prev);
        copy.delete(id);
        return copy;
      });
    }
  }, []);

  const removeAccount = useCallback(async (id: string) => {
    setErr(null);
    try {
      await api.del(`/api/antigravity-accounts/${id}`);
      setAccounts((prev) => prev.filter((a) => a.id !== id));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  const changeStrategy = useCallback(async (next: AntigravityStrategy) => {
    setErr(null);
    try {
      await api.put("/api/antigravity-accounts/strategy", { strategy: next });
      setStrategy(next);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  const openRelogin = useCallback((acct: AntigravityAccount) => {
    setReloginAccount(acct);
    setLabel(acct.label);
    setDialog("add");
  }, []);

  return (
    <div className="space-y-4">
      <AccountsPaneHeader
        description={
          <>
            Each Antigravity account keeps its own Google OAuth login (<code>~/.ppm/antigravity-accounts</code>) alongside your local IDE login (<code>~/.gemini</code>). One is picked per chat by the rotation setting.
          </>
        }
        onRefresh={() => void load()}
        refreshing={loading}
        actions={
          <>
            <Button
              size="sm"
              className="cursor-pointer gap-1.5"
              onClick={() => {
                setReloginAccount(null);
                setLabel("");
                setDialog("add");
              }}
            >
              <Plus className="size-4" /> Add account
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="cursor-pointer gap-1.5"
              onClick={() => setDialog("rotation")}
            >
              <Settings className="size-4" /> Rotation
            </Button>
          </>
        }
      />

      <AccountsPaneMessage
        message={msg ?? err}
        onDismiss={() => {
          setMsg(null);
          setErr(null);
        }}
      />

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Antigravity Accounts</h3>
          <span className="text-[10px] text-muted-foreground capitalize">
            {strategy.replace("-", " ")}
          </span>
        </div>

        {loading && accounts.length === 0 ? (
          <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading accounts...
          </div>
        ) : accounts.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <KeyRound className="size-5 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No Antigravity accounts yet.</p>
            <p className="text-xs text-muted-foreground">
              Click <strong>Add account</strong> to sign in with Google, or start Antigravity Desktop to auto-detect your local account.
            </p>
          </div>
        ) : (
          <AccountCardRow>
            {accounts.map((a) => {
              const u = usages[a.id] ?? {};
              const unread =
                u.session == null &&
                u.weekly == null &&
                (!u.weeklyScoped || u.weeklyScoped.length === 0);
              const isDefault = a.id === "default";

              return (
                <AccountCardShell
                  key={a.id}
                  dense
                  className="min-w-[320px] shrink-0 snap-start"
                  data-testid="account-card"
                  data-account-id={a.id}
                >
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{a.label}</div>
                      {a.email && a.email !== a.label && (
                        <div className="text-[11px] text-text-subtle truncate">{a.email}</div>
                      )}
                    </div>
                    <span className="text-[10px] uppercase tracking-wide text-text-subtle border border-border rounded px-1 shrink-0">
                      {isDefault ? "~/.gemini" : "Google"}
                    </span>
                    {a.planType && (
                      <span className="text-[10px] font-medium text-primary bg-primary/10 border border-primary/20 rounded px-1.5 py-0.5 shrink-0">
                        {a.planType}
                      </span>
                    )}
                    <Switch
                      checked={a.status !== "disabled"}
                      onCheckedChange={() => void toggleStatus(a.id, a.status)}
                      disabled={toggling.has(a.id)}
                      aria-label={a.status === "disabled" ? "Enable account" : "Disable account"}
                      className="cursor-pointer shrink-0"
                    />
                    {!isDefault && (
                      <>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() => openRelogin(a)}
                              aria-label="Sign in again"
                              className="p-1.5 rounded cursor-pointer text-text-subtle hover:text-foreground hover:bg-surface-elevated transition-colors shrink-0"
                            >
                              <RefreshCw className="size-3.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top">Sign in again</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() => void removeAccount(a.id)}
                              aria-label="Remove account"
                              className="p-1.5 rounded cursor-pointer text-text-subtle hover:text-error hover:bg-surface-elevated transition-colors shrink-0"
                            >
                              <Trash2 className="size-4" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top">Remove account</TooltipContent>
                        </Tooltip>
                      </>
                    )}
                  </div>

                  <div className="space-y-2 pt-1">
                    {(unread || u.session != null) && (
                      <AccountUsageBar
                        label="Gemini · 5-Hour Session"
                        pct={toPct(u.fiveHour)}
                        reset={formatResetTime(u.session)}
                        resetsAt={u.session?.resetsAt}
                      />
                    )}
                    {(unread || u.weekly != null) && (
                      <AccountUsageBar
                        label="Gemini · Weekly"
                        pct={toPct(u.sevenDay)}
                        reset={formatResetTime(u.weekly)}
                        resetsAt={u.weekly?.resetsAt}
                      />
                    )}
                    {u.weeklyScoped?.map((bucket) => (
                      <AccountUsageBar
                        key={bucket.label}
                        label={bucket.label}
                        pct={toPct(bucket.utilization)}
                        reset={formatResetTime(bucket)}
                        resetsAt={bucket.resetsAt}
                      />
                    ))}
                  </div>
                </AccountCardShell>
              );
            })}
          </AccountCardRow>
        )}
      </section>

      {/* Add / Re-login Antigravity Account Dialog */}
      <Dialog
        open={dialog === "add"}
        onOpenChange={(open) => {
          if (!open) closeAddDialog();
        }}
      >
        <DialogContent className="sm:max-w-md max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {reloginAccount ? `Sign in again — ${reloginAccount.label}` : "Add Antigravity Account"}
            </DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              {reloginAccount
                ? "Sign in with Google to refresh this account's OAuth credentials."
                : "Sign in with a Google account using Antigravity's OAuth PKCE flow. Each account is stored in its own isolated directory."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {!reloginAccount && (
              <div className="space-y-1.5">
                <Label htmlFor="agy-label" className="text-xs">
                  Label (optional)
                </Label>
                <Input
                  id="agy-label"
                  placeholder="e.g. Personal, Work, Shopee 2"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  disabled={loginStarting || submittingCode}
                  className="text-xs"
                />
              </div>
            )}

            <div className="rounded-md border p-3 space-y-2.5">
              <p className="text-[11px] font-medium">Google OAuth Sign-In</p>
              {!loginFlow ? (
                <Button
                  size="sm"
                  className="w-full cursor-pointer gap-1.5"
                  onClick={() => void startLogin(reloginAccount)}
                  disabled={loginStarting}
                >
                  {loginStarting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" /> Generating Google sign-in link...
                    </>
                  ) : (
                    <>
                      <ExternalLink className="size-4" /> Sign in with Google
                    </>
                  )}
                </Button>
              ) : (
                <div className="space-y-2.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <a
                      href={loginFlow.authUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline"
                    >
                      <ExternalLink className="size-3.5" /> Open Google Sign-In page
                    </a>
                    <button
                      type="button"
                      onClick={() => {
                        resetLoginFlow();
                        setDialogErr(null);
                      }}
                      disabled={submittingCode}
                      className="text-[11px] text-muted-foreground hover:text-foreground underline cursor-pointer"
                    >
                      Start over
                    </button>
                  </div>
                  <p className="text-muted-foreground leading-relaxed">
                    1. Open the link above and sign in with your Google account.
                    <br />
                    2. Copy the authorization code (or the full callback URL) shown after signing in and paste it below:
                  </p>
                  <div className="space-y-1.5">
                    <Label htmlFor="agy-auth-code" className="text-xs">
                      Authorization Code or Callback URL
                    </Label>
                    <Input
                      id="agy-auth-code"
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="4/0A... or https://antigravity.google/oauth-callback?code=..."
                      value={authCode}
                      onChange={(e) => setAuthCode(e.target.value)}
                      disabled={submittingCode}
                      className="text-xs font-mono"
                    />
                  </div>
                  <Button
                    size="sm"
                    className="w-full cursor-pointer gap-1.5"
                    onClick={() => void submitCode()}
                    disabled={!authCode.trim() || submittingCode}
                  >
                    {submittingCode && <Loader2 className="size-3.5 animate-spin" />}
                    Verify & Save Account
                  </Button>
                </div>
              )}
            </div>
          </div>

          {dialogErr && (
            <div role="alert" className="text-[11px] p-2 rounded bg-error/10 text-error">
              {dialogErr}
            </div>
          )}

          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              className="text-xs cursor-pointer"
              onClick={closeAddDialog}
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rotation Strategy Dialog */}
      <Dialog
        open={dialog === "rotation"}
        onOpenChange={(open) => setDialog(open ? "rotation" : null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">Antigravity Rotation</DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              How a new chat chooses among your enabled Antigravity accounts.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            {STRATEGIES.map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => void changeStrategy(s.value)}
                aria-current={strategy === s.value ? "true" : undefined}
                className={cn(
                  "w-full text-left rounded-md border px-3 py-2.5 min-h-11 cursor-pointer transition-colors",
                  strategy === s.value
                    ? "border-primary bg-primary/10"
                    : "border-border hover:bg-accent/50 active:bg-accent",
                )}
              >
                <p className="text-sm font-medium">{s.label}</p>
                <p className="text-xs text-muted-foreground">{s.hint}</p>
              </button>
            ))}
          </div>

          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              className="text-xs cursor-pointer"
              onClick={() => setDialog(null)}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
