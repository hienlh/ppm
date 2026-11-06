/**
 * What the user is asked before sessions reach each other: an AI asking to create a session, two
 * sessions at their limit of automatic messages, or a message to a session that runs with more
 * rights than the sender. Shown in the asking session's approval slot (and over the history window).
 *
 * The answer goes over HTTP; the card leaves when `approval_resolved` reaches every device showing
 * the chat. Every title and text here came from an AI, so all of it renders as text.
 */
import { useState } from "react";
import { ShieldAlert } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { answerCollabApproval, providerLabel } from "@/lib/session-collab-client";
import {
  sessionCollabAnswersFor, type SessionCollabAnswer, type SessionCollabApprovalInput,
} from "../../../shared/session-collab";
import { ProviderBadge } from "./provider-selector";

const MODE_LABELS: Record<string, string> = {
  plan: "Plan",
  default: "Ask",
  acceptEdits: "Accept edits",
  bypassPermissions: "Bypass permissions",
};
const modeLabel = (mode: string) => MODE_LABELS[mode] ?? mode;

/** The first lines of a long text, for a preview that cannot push the buttons off screen. */
export function firstLines(text: string, lines = 6): string {
  const all = text.split("\n");
  return all.length > lines ? `${all.slice(0, lines).join("\n")}\n…` : text;
}

export function answerLabel(input: SessionCollabApprovalInput, answer: SessionCollabAnswer): string {
  if (answer === "deny") return "Deny";
  if (answer === "allow_session") return "Allow for this session";
  return input.kind === "pair_limit" ? `Allow ${input.grant} more` : "Allow once";
}

function heading(input: SessionCollabApprovalInput): string {
  if (input.kind === "create") return "The AI wants to create a session";
  if (input.kind === "pair_limit") return "These sessions reached their message limit";
  return "The AI wants to message a session with more rights";
}

export function CollabApprovalCard({ requestId, input }: { requestId: string; input: SessionCollabApprovalInput }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = async (choice: SessionCollabAnswer) => {
    setBusy(true);
    setError(null);
    try {
      await answerCollabApproval(requestId, choice);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border-2 border-warning/40 bg-warning/10 p-3 space-y-2 select-text" data-collab-approval={input.kind}>
      <div className="flex items-center gap-2 text-warning text-sm font-medium">
        <ShieldAlert className="size-4 shrink-0" />
        <span>{heading(input)}</span>
      </div>
      <CollabApprovalBody input={input} />
      <div className="flex flex-col gap-2 md:flex-row">
        {sessionCollabAnswersFor(input.kind).map((choice) => (
          <button
            key={choice}
            type="button"
            disabled={busy}
            onClick={() => void answer(choice)}
            className={cn(
              "h-11 md:h-8 px-4 rounded text-xs font-medium transition-colors disabled:opacity-50",
              choice === "deny"
                ? "border border-border text-text-primary can-hover:hover:bg-panel-2"
                : choice === "allow_once"
                  ? "bg-warning text-white can-hover:hover:bg-warning/80"
                  : "border border-warning/50 text-warning can-hover:hover:bg-warning/10",
            )}
          >
            {answerLabel(input, choice)}
          </button>
        ))}
      </div>
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}

function CollabApprovalBody({ input }: { input: SessionCollabApprovalInput }) {
  if (input.kind === "create") {
    return (
      <>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
          <ProviderBadge providerId={input.providerId} />
          <span className="min-w-0 truncate font-medium text-text-primary">{input.title}</span>
          <span className="text-text-subtle">
            {providerLabel(input.providerId)}{input.model ? ` · ${input.model}` : ""} · depth {input.depth}
          </span>
        </div>
        {input.taskPreview && <Preview text={input.taskPreview} />}
      </>
    );
  }
  if (input.kind === "pair_limit") {
    return (
      <p className="text-xs text-text-primary">
        This session and <span className="font-medium">{input.targetTitle}</span> have sent each other {input.sent} of {input.limit} automatic
        messages since you last wrote in either. Allowing lets them send {input.grant} more.
      </p>
    );
  }
  return (
    <>
      <p className="text-xs text-text-primary">
        To <span className="font-medium">{input.targetTitle}</span>, which runs in{" "}
        <span className="font-medium">{modeLabel(input.targetMode)}</span> mode; this session runs in{" "}
        <span className="font-medium">{modeLabel(input.senderMode)}</span> mode.
      </p>
      {input.messagePreview && <Preview text={input.messagePreview} />}
    </>
  );
}

function Preview({ text }: { text: string }) {
  return (
    <pre className="text-xs font-mono text-text-secondary overflow-auto max-h-40 whitespace-pre-wrap break-words bg-background rounded p-2 border border-border">
      {firstLines(text)}
    </pre>
  );
}
