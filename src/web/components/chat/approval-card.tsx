import { useState } from "react";
import { AlertCircle, ShieldAlert } from "@/lib/icons";
import { hasHiddenCharacters, revealHiddenCharacters } from "@/lib/reveal-hidden-characters";
import type { ApprovalSummary } from "../../../shared/assistant-approval";
import { useAssistantDisplayName } from "@/stores/assistant-name-store";
import type { CardRememberOffer } from "../../../shared/remembered-approvals";
import { RememberApprovalControl } from "./remember-approval-control";
import { TEXT_BUTTON } from "@/lib/control-size";
import { cn } from "@/lib/utils";

/**
 * An answer button on an approval card (Allow, Deny, and the session tools' answers), at the app's
 * button standard (docs/design-guidelines.md rule 3): 28px tall, 26px on a phone, 11.5px text,
 * fully rounded. No taller size for touch.
 */
export const APPROVAL_BUTTON =
  `inline-flex shrink-0 items-center justify-center whitespace-nowrap font-medium transition-colors disabled:opacity-50 ${TEXT_BUTTON}`;

/**
 * The card a chat shows while a tool waits on the user's approval. A provider's card shows the
 * tool's input (a shell call as its command and the directory it runs in, anything else as
 * JSON); a PPM Assistant endpoint card shows what the server says will happen — its
 * summary line, the facts it checked (connection, chat, the mode a message runs in) and the full
 * SQL or message — never the agent's description of it. Everything wraps: a long statement or
 * command must be readable to its last word without scrolling sideways, where a `DROP` could hide.
 * For the same reason a character that draws nothing or reverses its neighbours is shown as a
 * marker, with a line saying so: the card must not be able to show one statement and run another.
 */

export interface ApprovalCardRequest {
  requestId: string;
  tool: string;
  input: unknown;
  summary?: ApprovalSummary;
  /** What "Allow & remember" would remember; absent when the card offers nothing to remember. */
  remember?: CardRememberOffer;
  /** Claude tool cards: what "for this chat" would allow from now on. */
  rule?: { label: string };
}

/** What a tool card sends besides yes or no: a permission for this chat, or what to do instead. */
export interface ApprovalCardChoice {
  scope?: "chat";
  message?: string;
}

const WRAPPED_BLOCK = "text-xs font-mono whitespace-pre-wrap break-words bg-background rounded p-2 border border-border max-h-80 overflow-y-auto select-text";

/** Said whenever what is about to run holds a character `RevealedText` had to mark. */
export const HIDDEN_CHARACTERS_WARNING = "Contains invisible or text-direction characters, shown as ⟨U+…⟩. They are part of what runs.";

/**
 * Text to approve, drawn so that what is displayed is what runs: a character that would draw
 * nothing or reorder its neighbours is shown as a `⟨U+XXXX⟩` marker instead of taking effect.
 */
function RevealedText({ text }: { text: string }) {
  return (
    <>
      {revealHiddenCharacters(text).map((part, i) => "text" in part
        ? part.text
        : <span key={i} className="rounded bg-warning/20 px-0.5 font-mono text-warning" data-hidden-character>{part.marker}</span>)}
    </>
  );
}

function WarningLine({ children }: { children: string }) {
  return (
    <div className="flex items-start gap-2 rounded border border-warning/50 bg-warning/15 px-2 py-1.5 text-xs font-medium text-warning">
      <AlertCircle className="size-4 shrink-0" />
      <span className="break-words">{children}</span>
    </div>
  );
}

/** A server-built summary: the headline, its facts, the body in full and its warnings. Shared with the session tools' schedule card. */
export function SummaryBody({ summary }: { summary: ApprovalSummary }) {
  const hidden = [summary.body?.text ?? "", ...summary.facts.map((f) => f.value)].some(hasHiddenCharacters);
  return (
    <>
      <p className="text-sm text-text-primary">{summary.headline}</p>
      {summary.facts.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          {summary.facts.map((f, i) => (
            // A label can repeat (one "Sends to chat" per chat), so the position keys it.
            <div key={`${i}-${f.label}`} className="contents">
              <dt className="text-text-secondary">{f.label}</dt>
              <dd className={f.tone === "warning" ? "font-medium text-warning break-words" : "text-text-primary break-words"}><RevealedText text={f.value} /></dd>
            </div>
          ))}
        </dl>
      )}
      {summary.body && (
        <div className="space-y-1">
          <div className="text-xs text-text-secondary">
            {summary.body.label}
            {summary.statementCount != null && ` · ${summary.statementCount} statement${summary.statementCount === 1 ? "" : "s"}`}
          </div>
          <pre className={`${WRAPPED_BLOCK} ${summary.body.format === "text" ? "font-sans text-text-primary" : "text-text-primary"}`}>
            <RevealedText text={summary.body.text} />
          </pre>
        </div>
      )}
      {hidden && <WarningLine>{HIDDEN_CHARACTERS_WARNING}</WarningLine>}
      {summary.warning && <WarningLine>{summary.warning}</WarningLine>}
    </>
  );
}

const COMMAND_FACT_LABELS: Record<string, string> = { cwd: "Directory", reason: "Reason", description: "Description" };

/**
 * A shell call's input as the command and the plain facts beside it, or null when the input is
 * not that shape. As JSON a multi-line script collapses onto one line of `\n`s and a Windows path
 * doubles every backslash, so the command a user is approving is not the text they read.
 */
function commandInput(input: unknown): { command: string; facts: Array<{ label: string; value: string }> } | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const { command, ...rest } = input as Record<string, unknown>;
  if (typeof command !== "string") return null;
  const facts: Array<{ label: string; value: string }> = [];
  for (const [key, value] of Object.entries(rest)) {
    if (value == null || value === "") continue;
    // Anything nested would be hidden by this view; such an input is shown whole instead.
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return null;
    facts.push({ label: COMMAND_FACT_LABELS[key] ?? key, value: String(value) });
  }
  return { command, facts };
}

function RawInputBody({ tool, input }: { tool: string; input: unknown }) {
  const shell = commandInput(input);
  // A string is already the text to show; stringifying it again would quote and escape it.
  const text = shell ? shell.command : typeof input === "string" ? input : JSON.stringify(input, null, 2) ?? "";
  const hidden = [text, ...(shell?.facts.map((f) => f.value) ?? [])].some(hasHiddenCharacters);
  return (
    <>
      <div className="text-xs text-text-primary">
        <span className="font-medium">{tool}</span>
      </div>
      <pre className={`${WRAPPED_BLOCK} ${shell ? "text-text-primary" : "text-text-secondary"}`}>
        <RevealedText text={text} />
      </pre>
      {shell && shell.facts.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          {shell.facts.map((f) => (
            <div key={f.label} className="contents">
              <dt className="text-text-secondary">{f.label}</dt>
              <dd className="text-text-primary break-words"><RevealedText text={f.value} /></dd>
            </div>
          ))}
        </dl>
      )}
      {hidden && <WarningLine>{HIDDEN_CHARACTERS_WARNING}</WarningLine>}
    </>
  );
}

export function ApprovalCard({
  approval,
  onRespond,
}: {
  approval: ApprovalCardRequest;
  onRespond: (requestId: string, approved: boolean, choice?: ApprovalCardChoice, remember?: boolean) => void;
}) {
  const summary = approval.summary;
  const assistantName = useAssistantDisplayName(!!summary);
  const rule = summary ? undefined : approval.rule;
  /** Deny was pressed on a card that can carry instructions: the box to type them is open. */
  const [denying, setDenying] = useState(false);
  const [instead, setInstead] = useState("");
  const deny = () => onRespond(approval.requestId, false, instead.trim() ? { message: instead.trim() } : undefined);
  return (
    <div className="rounded-lg border-2 border-warning/40 bg-warning/10 p-3 space-y-2" data-approval-request={approval.requestId}>
      <div className="flex items-center gap-2 text-warning text-sm font-medium">
        <ShieldAlert className="size-4" />
        <span>{summary ? `${assistantName} asks for approval` : "Tool Approval Required"}</span>
      </div>
      {summary ? <SummaryBody summary={summary} /> : <RawInputBody tool={approval.tool} input={approval.input} />}
      {denying ? (
        <div className="space-y-2" data-approval-deny="">
          <textarea
            autoFocus
            value={instead}
            onChange={(e) => setInstead(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); deny(); }
              if (e.key === "Escape") { e.preventDefault(); setDenying(false); }
            }}
            rows={2}
            placeholder="Tell Claude what to do instead (optional)"
            aria-label="Tell Claude what to do instead"
            className="w-full resize-y rounded border border-border bg-background p-2 text-xs text-text-primary placeholder:text-text-secondary focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <div className="flex flex-wrap gap-2">
            <button onClick={deny} className={cn(APPROVAL_BUTTON, "bg-error text-white hover:bg-error/80")}>
              {instead.trim() ? "Deny and send" : "Deny"}
            </button>
            <button onClick={() => setDenying(false)} className={cn(APPROVAL_BUTTON, "border border-border text-text-secondary hover:text-text-primary")}>
              Back
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => onRespond(approval.requestId, true)}
            className={cn(APPROVAL_BUTTON, "bg-success text-white hover:bg-success/80")}
          >
            Allow
          </button>
          {rule && (
            <button
              onClick={() => onRespond(approval.requestId, true, { scope: "chat" })}
              title={`Allow ${rule.label} without asking again in this chat`}
              data-approval-scope="chat"
              className={cn(APPROVAL_BUTTON, "border border-success/60 text-success hover:bg-success/10")}
            >
              Allow {rule.label} for this chat
            </button>
          )}
          <button
            onClick={() => (rule ? setDenying(true) : onRespond(approval.requestId, false))}
            className={cn(APPROVAL_BUTTON, "bg-error text-white hover:bg-error/80")}
          >
            {rule ? "Deny…" : "Deny"}
          </button>
        </div>
      )}
      {approval.remember && !denying && (
        <RememberApprovalControl offer={approval.remember} onRemember={() => onRespond(approval.requestId, true, undefined, true)} />
      )}
    </div>
  );
}
