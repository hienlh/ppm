/**
 * DBGate's Database Log In, for a connection that keeps no password: asks for it — and for the
 * user too when the connection keeps neither — and tries it from the PPM host before closing.
 *
 * One is mounted in the app. It shows the first request in `useDbLoginStore`, as a dialog on a
 * desktop and a bottom sheet on a phone, and it is what the API client asks when a saved
 * connection answers `428 DB_LOGIN_REQUIRED`: the tree, a table or a query that finds the
 * connection logged out asks here, and its request goes again once the server holds a login.
 */
import { useEffect, useRef, useState } from "react";
import { AlertCircle, Eye, EyeOff, Loader2, Lock } from "@/lib/icons";
import { api, ApiError, setDbLoginHandler } from "@/lib/api-client";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import type { DbLoginRequiredBody, DbTestResult } from "../../../../shared/db-connection-config";
import { announceConnectionsChanged } from "../db-sidebar-reveal";
import { Field, TextInput } from "../connection-form/form-controls";
import { requestDbLogin, settleDbLogin, useDbLoginStore, type DbLogin, type PendingDbLogin } from "./db-login-store";

type LoginField = "user" | "password";

type LoginState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "failed"; message: string; details: string };

/**
 * The API client's question when a saved connection answered 428: ask for its login, which the
 * server tests and holds. True once it holds one, so the refused request can go again.
 */
export async function loginForSavedConnection(body: unknown): Promise<boolean> {
  const prompt = (body as Partial<DbLoginRequiredBody> | null)?.login;
  if (!prompt || typeof prompt.connectionId !== "number") return false;
  const id = prompt.connectionId;
  const outcome = await requestDbLogin({
    prompt,
    submit: (login, signal) => api.post<DbTestResult>(`/api/db/connections/${id}/login`, login, { signal, dbLogin: false }),
  });
  // The tree offers Disconnect for a connection with a held login; its list says so now.
  if (outcome) announceConnectionsChanged({ connectionId: id });
  return outcome !== null;
}

export function DbLoginDialogHost() {
  const pending = useDbLoginStore((s) => s.queue[0] ?? null);
  useEffect(() => {
    setDbLoginHandler(loginForSavedConnection);
    return () => setDbLoginHandler(null);
  }, []);
  return pending ? <DbLoginDialog key={pending.id} pending={pending} /> : null;
}

function DbLoginDialog({ pending }: { pending: PendingDbLogin }) {
  const isMobile = useIsMobile();
  const { prompt } = pending;
  const [user, setUser] = useState(prompt.askUser ? "" : prompt.user);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [state, setState] = useState<LoginState>({ kind: "idle" });
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [refocus, setRefocus] = useState<{ field: LoginField; n: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const userRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const busy = state.kind === "busy";

  // A login still being tried when the dialog goes is nobody's to wait for.
  useEffect(() => () => abortRef.current?.abort(), []);
  // After a refusal, back to the box to type again in (it was disabled while trying).
  useEffect(() => {
    if (refocus) (refocus.field === "user" ? userRef : passwordRef).current?.focus();
  }, [refocus]);

  const fail = (message: string, details: string, field: LoginField) => {
    setState({ kind: "failed", message, details });
    setRefocus((r) => ({ field, n: (r?.n ?? 0) + 1 }));
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState({ kind: "idle" });
  };

  const close = () => {
    abortRef.current?.abort();
    settleDbLogin(pending.id, null);
  };

  const connect = async () => {
    if (busy) { stop(); return; }
    const login: DbLogin = prompt.askUser ? { user: user.trim(), password } : { password };
    if (prompt.askUser && !login.user) { fail("Enter the user name.", "", "user"); return; }
    const controller = new AbortController();
    abortRef.current = controller;
    setDetailsOpen(false);
    setState({ kind: "busy" });
    try {
      const result = await pending.submit(login, controller.signal);
      if (controller.signal.aborted) return;
      if (result.ok) { settleDbLogin(pending.id, { login, result }); return; }
      fail(`Connect failed: ${result.error}`, result.details, "password");
    } catch (e) {
      if (controller.signal.aborted) return;
      const field = e instanceof ApiError && (e.body as { field?: unknown } | null)?.field === "user" ? "user" : "password";
      fail(`Connect failed: ${(e as Error).message}`, "", field);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void connect();
    }
  };

  const title = `Database Log In (${prompt.type})`;
  const button = "inline-flex h-11 md:h-8 items-center justify-center gap-1.5 rounded-[10px] md:rounded-md px-3.5 text-[14px] md:text-[12.5px] font-medium";

  const body = (
    <div
      className="grid gap-3"
      data-testid="db-login"
      // The sheet has no Esc of its own; the desktop dialog's is Radix's.
      onKeyDown={isMobile ? (e) => { if (e.key === "Escape") close(); } : undefined}
    >
      <Field label="Connection" htmlFor="dbl-conn">
        <TextInput id="dbl-conn" readOnly tabIndex={-1} value={prompt.name} className="bg-surface-hover text-text-2" />
      </Field>
      <Field label="Username" htmlFor="dbl-user">
        <TextInput
          id="dbl-user"
          ref={userRef}
          mono
          value={user}
          readOnly={!prompt.askUser}
          disabled={busy}
          autoFocus={prompt.askUser}
          onChange={(e) => setUser(e.target.value)}
          onKeyDown={onKeyDown}
          className={cn(!prompt.askUser && "bg-surface-hover text-text-2")}
        />
      </Field>
      <Field label="Password" htmlFor="dbl-pass">
        <div className="relative flex min-w-0">
          <TextInput
            id="dbl-pass"
            ref={passwordRef}
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            value={password}
            disabled={busy}
            autoFocus={!prompt.askUser}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={onKeyDown}
            className="pr-11 md:pr-8"
          />
          <button
            type="button"
            onClick={() => setShowPassword((s) => !s)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            aria-pressed={showPassword}
            className="absolute right-0 top-0 grid h-full w-11 md:w-8 place-items-center text-text-subtle can-hover:hover:text-text-primary"
          >
            {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </Field>

      <div aria-live="polite" className="empty:hidden grid gap-2" data-testid="db-login-state">
        {busy && (
          <p className="flex items-center gap-2 text-[13px] md:text-[12.5px] text-text-2">
            <Loader2 className="size-4 animate-spin text-text-subtle" />Testing connection
          </p>
        )}
        {state.kind === "failed" && (
          <>
            <p className="flex items-start gap-2 text-[13px] md:text-[12.5px] text-error">
              <AlertCircle className="mt-px size-4 shrink-0" />
              <span className="min-w-0 break-words">
                {state.message}
                {state.details && (
                  <button
                    type="button"
                    onClick={() => setDetailsOpen((o) => !o)}
                    className="ml-2 inline-flex min-h-11 md:min-h-0 items-center text-text-2 underline underline-offset-2 can-hover:hover:text-text-primary"
                  >
                    {detailsOpen ? "Hide detail" : "Show detail"}
                  </button>
                )}
              </span>
            </p>
            {detailsOpen && state.details && (
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border-soft bg-panel-2 p-2.5 font-mono text-[12px] md:text-[11.5px] text-text-2">
                {state.details}
              </pre>
            )}
          </>
        )}
      </div>

      <div className="mt-1 flex items-center gap-2">
        <span className="mr-auto hidden md:inline text-[11.5px] text-text-subtle">Enter connect · Esc close</span>
        <button
          type="button"
          onClick={close}
          className={cn(button, "flex-1 md:flex-none border border-border bg-surface text-text-primary can-hover:hover:bg-surface-hover")}
        >
          Close
        </button>
        <button
          type="button"
          onClick={() => void connect()}
          className={cn(button, "flex-[2] md:flex-none bg-primary text-primary-foreground can-hover:hover:bg-primary/90")}
        >
          {busy ? "Stop connecting" : "Connect"}
        </button>
      </div>
    </div>
  );

  const heading = (
    <span className="flex items-center gap-2">
      <Lock className="size-4 shrink-0 text-text-subtle" />
      {title}
    </span>
  );

  if (isMobile) {
    return (
      <BottomSheet open onClose={close} className="popover-solid">
        <div role="dialog" aria-modal="true" aria-labelledby="dbl-title" className="px-4 pb-4 pt-1">
          <h2 id="dbl-title" className="mb-3 text-base font-semibold">{heading}</h2>
          {body}
        </div>
      </BottomSheet>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="sm:max-w-[440px] gap-3">
        <DialogTitle className="text-[15px]">{heading}</DialogTitle>
        <DialogDescription className="sr-only">
          This connection keeps no password. Enter it to connect; PPM holds it until you disconnect.
        </DialogDescription>
        {body}
      </DialogContent>
    </Dialog>
  );
}
