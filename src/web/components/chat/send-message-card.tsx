/**
 * Card surfaces for the SendMessage tool (agent teams / cross-session peers).
 *
 * Rendered by `tool-cards.tsx`; the payload shaping lives in `send-message-parse.ts`.
 * The design mirrors the team activity panel — same badge vocabulary, an explicit
 * recipient, and prose rendered as prose — so a peer message reads as a message
 * instead of a JSON dump.
 */
import { useState } from "react";
import { ArrowRight, Code, Clock, CheckCircle2, XCircle } from "lucide-react";
import { MiniMarkdown } from "./mini-markdown";
import { TYPE_BADGES } from "./team-message-badges";
import { normalizeSendMessage, parseSendMessageResult } from "./send-message-parse";

/** Badge for a message kind. Ordinary prose gets no badge — the icon already says "message". */
function KindBadge({ kind }: { kind: string }) {
  if (kind === "message") return null;
  const badge = TYPE_BADGES[kind];
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] ${badge?.className ?? "bg-panel-2 text-text-3"}`}>
      {badge?.label ?? kind}
    </span>
  );
}

/**
 * One-line header: who it went to plus the author's own label for the row. Falls back
 * to the first line of the body, which is exactly what the recipient previews.
 */
export function SendMessageSummary({ name, input }: { name: string; input: Record<string, unknown> }) {
  const msg = normalizeSendMessage(input);
  const raw = msg.summary || msg.firstLine || (msg.protocol ? msg.kind : "");
  // The header is a single truncating line; cap the text so a long first line cannot
  // push the status icons out of view on a narrow screen.
  const label = raw.length > 72 ? `${raw.slice(0, 72)}…` : raw;
  // No leading icon here: the card's chip already carries the Send glyph.
  return (
    <>
      {name}{" "}
      <span className="text-text-subtle">
        <ArrowRight className="size-3 inline" /> {msg.to || "unknown"}
        {label ? ` · ${label}` : ""}
      </span>
      {msg.notifyWhenIdle && <Clock className="size-3 inline ml-1 text-text-3" />}
    </>
  );
}

/** Expanded body: recipient row, then the message itself. */
export function SendMessageDetails({ input }: { input: Record<string, unknown> }) {
  const msg = normalizeSendMessage(input);
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-text-subtle">To</span>
        <span className="font-medium text-text-primary">{msg.to || "unknown"}</span>
        <KindBadge kind={msg.kind} />
        {msg.notifyWhenIdle && (
          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] bg-panel-2 text-text-3">
            <Clock className="size-3" /> notify when idle
          </span>
        )}
      </div>

      {/* The summary is not repeated here — the collapsed header already shows it. */}
      {!!msg.text && <MiniMarkdown content={msg.text} maxHeight="max-h-40" />}

      {msg.protocol && (
        <div className="space-y-0.5 text-text-secondary">
          {msg.protocol.approve != null && (
            <p>
              {msg.protocol.approve ? "Approved" : "Rejected"}
              {msg.protocol.request_id ? (
                <span className="text-text-subtle font-mono"> · {msg.protocol.request_id}</span>
              ) : null}
            </p>
          )}
          {!!msg.protocol.reason && <p className="text-text-subtle">{msg.protocol.reason}</p>}
          {!!msg.protocol.feedback && <p className="text-text-subtle">{msg.protocol.feedback}</p>}
        </div>
      )}

      {msg.extras.length > 0 && (
        <div className="space-y-0.5">
          {msg.extras.map((e) => (
            <p key={e.key} className="text-text-subtle">
              <span className="font-mono">{e.key}</span>: {e.value}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Delivery status. The runtime answers with JSON nested inside JSON, so it collapses
 * to a single status line with the raw payload kept one click away.
 */
export function SendMessageOutcomeView({ output }: { output: string }) {
  const [showRaw, setShowRaw] = useState(false);
  const outcome = parseSendMessageResult(output);
  if (!outcome) return null;

  return (
    <div className="border-t border-border pt-1.5 space-y-1">
      <div className="flex items-center gap-1.5 flex-wrap">
        {outcome.ok ? (
          <CheckCircle2 className="size-3 text-success shrink-0" />
        ) : (
          <XCircle className="size-3 text-error shrink-0" />
        )}
        <span className={outcome.ok ? "text-success" : "text-error"}>
          {outcome.ok ? "Delivered" : "Not delivered"}
        </span>
        {!!outcome.detail && <span className="text-text-subtle">· {outcome.detail}</span>}
        {!!outcome.ref && <span className="text-text-3 font-mono text-[10px]">[{outcome.ref}]</span>}
      </div>
      <button
        type="button"
        onClick={() => setShowRaw(!showRaw)}
        className="flex items-center gap-1 text-[10px] text-text-subtle hover:text-text-secondary transition-colors"
      >
        <Code className="size-3" />
        {showRaw ? "Hide" : "Show"} raw
      </button>
      {showRaw && (
        <pre className="overflow-x-auto text-text-subtle font-mono max-h-40 whitespace-pre-wrap break-all text-[10px]">
          {output}
        </pre>
      )}
    </div>
  );
}
