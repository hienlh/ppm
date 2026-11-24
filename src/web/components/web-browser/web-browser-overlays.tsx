/**
 * What covers the picture when there is no page to show, and what pages ask for.
 *
 * A page's alert/confirm/prompt is drawn inside the browser frame, headed with the page's origin
 * and styled unlike PPM's own dialogs — otherwise `prompt("PPM session expired, enter your
 * password")` would look exactly like PPM asking.
 */
import { useState } from "react";
import { AlertTriangle, Bot, Globe, Loader2, Monitor, Power } from "@/lib/icons";
import type { WebBrowserViewState } from "./use-web-browser-connection";

const primary = "min-h-11 md:min-h-8 px-4 rounded-md bg-primary text-white text-sm hover:opacity-90";
const secondary = "min-h-11 md:min-h-8 px-4 rounded-md border border-border text-sm text-text hover:bg-panel-2";

function Screen({ icon, title, body, children }: { icon: React.ReactNode; title: string; body?: string; children?: React.ReactNode }) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 p-6 text-center bg-background">
      <div className="text-text-3">{icon}</div>
      <div className="text-sm font-medium text-text">{title}</div>
      {body && <div className="max-w-md text-xs leading-relaxed text-text-2">{body}</div>}
      {children && <div className="flex flex-wrap justify-center gap-2 mt-1">{children}</div>}
    </div>
  );
}

const ERROR_TITLES: Record<string, string> = {
  "not-decided": "The web browser is not turned on",
  disabled: "The web browser is turned off",
  "no-browser": "No Chrome or Edge on the host",
  "proxy-bypassed": "Stopped for safety",
  "public-access": "Not available over a public link",
  "auth-required": "Needs PPM sign-in to be enabled",
};

export function WebBrowserStateScreen(p: {
  s: WebBrowserViewState;
  onReconnect(): void;
  onStart(): void;
  onTakeover(): void;
  onOpenSettings(): void;
}) {
  const { s } = p;
  if (s.error && s.browser !== "running") {
    const settingsFix = ["not-decided", "disabled", "public-access"].includes(s.error.code);
    return (
      <Screen icon={<AlertTriangle className="size-8" />} title={ERROR_TITLES[s.error.code] ?? "The browser could not start"} body={s.error.message}>
        {settingsFix && <button type="button" className={primary} onClick={p.onOpenSettings}>Open Settings</button>}
        <button type="button" className={secondary} onClick={p.onStart}>Try again</button>
      </Screen>
    );
  }
  if (s.conn === "error" || s.conn === "closed") {
    return (
      <Screen icon={<Globe className="size-8" />} title="Disconnected from the browser" body={s.connError ?? undefined}>
        <button type="button" className={primary} onClick={p.onReconnect}>Reconnect</button>
      </Screen>
    );
  }
  if (s.conn === "connecting" || s.browser === "starting" || s.browser === null) {
    return <Screen icon={<Loader2 className="size-8 animate-spin" />} title="Starting the browser on the host…" />;
  }
  if (s.browser === "stopped" || s.browser === "crashed") {
    return (
      <Screen icon={<Power className="size-8" />} title={s.browser === "crashed" ? "The browser closed unexpectedly" : "The browser was stopped"}
        body={s.browserMessage ?? "It stops by itself after a while unused, to give its memory back."}>
        <button type="button" className={primary} onClick={p.onStart}>Start again</button>
      </Screen>
    );
  }
  if (!s.isController) {
    return (
      <Screen icon={<Monitor className="size-8" />} title="In use on another device" body="Only one device controls the browser at a time.">
        <button type="button" className={primary} onClick={p.onTakeover}>Use here</button>
      </Screen>
    );
  }
  return null;
}

export function WebBrowserPageDialog(p: { dialog: NonNullable<WebBrowserViewState["dialog"]>; onAnswer(accept: boolean, text?: string): void }) {
  const [text, setText] = useState(p.dialog.defaultText);
  const { kind, origin, message } = p.dialog;
  return (
    <div className="absolute inset-0 z-20 flex items-start justify-center bg-black/30 pt-10 px-4">
      <div role="alertdialog" aria-label={`${origin || "This page"} says`}
        className="w-full max-w-sm rounded-md border-2 border-dashed border-text-3 bg-white p-4 text-[#1f1f1f] shadow-lg font-sans">
        <div className="mb-1 text-xs font-semibold text-[#5f6368]">{origin || "This page"} says:</div>
        <div className="whitespace-pre-wrap break-words text-sm">{kind === "beforeunload" ? "Leave this page? Changes you made may not be saved." : message}</div>
        {kind === "prompt" && (
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)}
            className="mt-3 w-full rounded border border-[#dadce0] px-2 py-1.5 text-sm outline-none focus:border-[#1a73e8]" />
        )}
        <div className="mt-4 flex justify-end gap-2">
          {kind !== "alert" && <button type="button" className="min-h-11 md:min-h-8 px-3 rounded text-sm text-[#1a73e8] hover:bg-[#f1f3f4]" onClick={() => p.onAnswer(false)}>Cancel</button>}
          <button type="button" className="min-h-11 md:min-h-8 px-4 rounded bg-[#1a73e8] text-sm text-white" onClick={() => p.onAnswer(true, kind === "prompt" ? text : undefined)}>
            {kind === "beforeunload" ? "Leave" : "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function WebBrowserAiBanner(p: { ai: NonNullable<WebBrowserViewState["ai"]>; onTakeBack(): void; onGiveBack(): void }) {
  if (!p.ai.active && !p.ai.heldByUser) return null;
  return (
    <div className="flex items-center gap-2 shrink-0 px-3 min-h-9 text-xs bg-accent-2/15 border-b border-border text-text">
      <Bot className="size-4 text-accent-2" />
      <span className="flex-1 min-w-0 truncate">
        {p.ai.heldByUser ? "You took the browser back from the AI." : `AI is using the browser${p.ai.sessionTitle ? ` (${p.ai.sessionTitle})` : ""}.`}
      </span>
      {p.ai.heldByUser
        ? <button type="button" className={secondary} onClick={p.onGiveBack}>Let the AI continue</button>
        : <button type="button" className={primary} onClick={p.onTakeBack}>Take back</button>}
    </div>
  );
}
