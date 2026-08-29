/**
 * Completes a CLI login that was started here and signed in on another device.
 *
 * The CLI is listening on a loopback port of the machine PPM runs on, but the
 * browser that signed in was redirected to *its own* loopback address, so the
 * result never arrived. Typing into the terminal will not help either — the CLI
 * is holding it open, waiting. The server shares a host with the CLI, so it
 * makes the call on the browser's behalf.
 */
import { useState } from "react";
import { Loader2, LogIn } from "lucide-react";
import { api } from "@/lib/api-client";
import { isDeliverableCallback } from "@/lib/oauth-loopback-url";
import { toast } from "sonner";

interface TerminalFinishLoginProps {
  onDone: () => void;
}

export function TerminalFinishLogin({ onDone }: TerminalFinishLoginProps) {
  const [url, setUrl] = useState("");
  const [sending, setSending] = useState(false);

  const trimmed = url.trim();
  const ready = !sending && isDeliverableCallback(trimmed);

  const send = async () => {
    setSending(true);
    try {
      await api.post("/api/loopback/callback", { url: trimmed });
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
    <div className="shrink-0 border-t border-border px-3 py-3">
      <p className="pb-2 text-[11px] leading-snug text-text-secondary">
        Finished signing in and landed on a page that would not load? Paste that address here —
        the machine will deliver it to the command still waiting.
      </p>
      <div className="flex items-center gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="http://127.0.0.1:54132/oauth/callback?code=…"
          aria-label="Callback address"
          className="h-11 min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 font-mono text-xs text-foreground placeholder:text-text-subtle"
        />
        <button
          onClick={() => void send()}
          disabled={!ready}
          aria-label="Finish login"
          className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground disabled:opacity-40 active:opacity-80 transition-opacity"
        >
          {sending ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
        </button>
      </div>
      {trimmed !== "" && !isDeliverableCallback(trimmed) && (
        <p className="pt-1.5 text-[11px] text-error">
          Needs to be the http://127.0.0.1:… address the sign-in redirected to.
        </p>
      )}
    </div>
  );
}
