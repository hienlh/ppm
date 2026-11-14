/**
 * Completes a CLI login that was started here and signed in on another device.
 *
 * The CLI is listening on a loopback port of the machine PPM runs on, but the
 * browser that signed in was redirected to *its own* loopback address, so the
 * result never arrived. Typing into the terminal will not help either — the CLI
 * is holding it open, waiting. The server shares a host with the CLI, so it
 * makes the call on the browser's behalf.
 *
 * The phone's links sheet and the desktop terminal's login bar both use this.
 * Whatever is pasted is cleaned up first (a phone's copy has no `http://`, a
 * note's has quotes or a trailing full stop) by the same function the server
 * runs, so what the field accepts is what the server accepts.
 */
import { useState } from "react";
import { Loader2, LogIn } from "@/lib/icons";
import { api } from "@/lib/api-client";
import { normalizeLoopbackCallback } from "@/lib/oauth-loopback-url";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface TerminalFinishLoginProps {
  onDone: () => void;
  /** Desktop size: a pointer needs no 44px target, and the bar sits over the terminal. */
  compact?: boolean;
  autoFocus?: boolean;
  /** The user started using the field (focused or typed into it). */
  onEngage?: () => void;
}

/** What the field shows under the input for the current text: nothing, the URL to be sent, or why not. */
export function describeCallbackInput(text: string):
  | { kind: "empty" }
  | { kind: "ready"; url: string; rewritten: boolean }
  | { kind: "invalid"; reason: string } {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "empty" };
  const checked = normalizeLoopbackCallback(trimmed);
  if (!checked.ok) return { kind: "invalid", reason: checked.reason };
  // A trailing "/" the parser adds to a bare host is not worth pointing out.
  const rewritten = checked.url !== trimmed && checked.url !== `${trimmed}/`;
  return { kind: "ready", url: checked.url, rewritten };
}

/**
 * What to tell the user after the server called the listener. The CLI's own
 * page answers 200 when it took the code; anything 400 and up means it refused
 * it (a stale `state`, a code already used) and the login is not finished.
 */
export function describeDeliveryResult(result: { status: number; body: string }):
  | { ok: true }
  | { ok: false; message: string } {
  if (result.status < 400) return { ok: true };
  const detail = result.body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
  return {
    ok: false,
    message: `The waiting command answered ${result.status}${detail ? `: ${detail}` : ""}. Start the login again if it has given up.`,
  };
}

export function TerminalFinishLogin({ onDone, compact = false, autoFocus = false, onEngage }: TerminalFinishLoginProps) {
  const [url, setUrl] = useState("");
  const [sending, setSending] = useState(false);

  const state = describeCallbackInput(url);
  const ready = !sending && state.kind === "ready";

  const send = async () => {
    if (state.kind !== "ready") return;
    setSending(true);
    try {
      const result = await api.post<{ status: number; body: string }>("/api/loopback/callback", { url: state.url });
      const verdict = describeDeliveryResult(result);
      if (!verdict.ok) {
        toast.error(verdict.message, { duration: 6000 });
        return;
      }
      toast.success("Sent to the waiting command", { duration: 2000 });
      setUrl("");
      onDone();
    } catch (e) {
      toast.error((e as Error).message, { duration: 4000 });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={cn("shrink-0", compact ? "px-3 py-2" : "border-t border-border px-3 py-3")}>
      <p className="pb-2 text-[11px] leading-snug text-text-secondary">
        Finished signing in and landed on a page that would not load? Paste that address here —
        the machine running PPM will deliver it to the command still waiting.
      </p>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void send();
        }}
      >
        <input
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            onEngage?.();
          }}
          onFocus={onEngage}
          autoFocus={autoFocus}
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="127.0.0.1:54132/oauth/callback?code=…"
          aria-label="Callback address"
          className={cn(
            "min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 font-mono text-xs text-foreground placeholder:text-text-subtle",
            compact ? "h-8" : "h-11",
          )}
        />
        <button
          type="submit"
          disabled={!ready}
          aria-label="Finish login"
          title="Finish login"
          className={cn(
            "flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-primary text-primary-foreground disabled:opacity-40 active:opacity-80 transition-opacity",
            compact ? "h-8 px-3 text-xs" : "size-11",
          )}
        >
          {sending ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
          {compact && <span>Finish login</span>}
        </button>
      </form>
      {state.kind === "invalid" && (
        <p className="pt-1.5 text-[11px] text-error">{state.reason}</p>
      )}
      {state.kind === "ready" && state.rewritten && (
        <p className="pt-1.5 text-[11px] text-text-secondary">
          Will send <span className="break-all font-mono text-foreground">{state.url}</span>
        </p>
      )}
    </div>
  );
}
