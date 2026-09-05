import { useEffect, useState } from "react";
import { Bug, ClipboardCheck, Copy, ImageOff, Loader2, TriangleAlert } from "lucide-react";
import { api, projectUrl } from "@/lib/api-client";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { copyToClipboard } from "@/lib/clipboard";
import type { TurnUsage } from "../../../shared/turn-usage";
import {
  assessTurnCost,
  fmtTokens,
  prefixTokens,
  uncachedPrefixTokens,
} from "../../../shared/turn-usage";

interface TurnRecord {
  id: number;
  recordedAt: string;
  usage: TurnUsage;
}

interface DebugInfo {
  ppmSessionId: string;
  sdkSessionId: string;
  jsonlPath: string | null;
  projectPath: string;
  jsonlSizeBytes: number | null;
  jsonlLines: number | null;
}

interface ImageAudit {
  total: number;
  oversized: number;
  bytes: number;
  oversizedBytes: number;
  largestSide: number;
  attachments: number;
  oversizedAttachments: number;
  limit: number;
}

const fmtMB = (bytes: number) => `${(bytes / 1048576).toFixed(2)} MB`;

function fmtSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Live render weight of the currently open transcript.
 *
 * This dialog opens from the active session's toolbar, so the tallest scroller holding
 * message nodes is that session's transcript.
 */
function gatherRenderStats(): string[] {
  let scroller: HTMLElement | null = null;
  for (const el of document.querySelectorAll<HTMLElement>(".overflow-y-auto")) {
    if (el.clientHeight < 100 || !el.querySelector("[data-msg-index]")) continue;
    if (!scroller || el.scrollHeight > scroller.scrollHeight) scroller = el;
  }
  const lines: string[] = [];
  if (scroller) {
    lines.push(`Rendered messages: ${scroller.querySelectorAll("[data-msg-index]").length}`);
    lines.push(`Transcript DOM nodes: ${scroller.querySelectorAll("*").length}`);
    lines.push(`Transcript height: ${Math.round(scroller.scrollHeight)}px`);
  }
  // Chrome-only; page-wide (not just the transcript) but the best in-app proxy.
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  if (mem) lines.push(`JS heap (page): ${(mem.usedJSHeapSize / 1048576).toFixed(1)} MB`);
  return lines;
}

/**
 * Removal of the image payloads a transcript replays on every turn.
 *
 * The transcript is re-sent in full each time the session resumes, so every image it
 * carries is paid for again. Images past the API's per-image dimension cap are rejected
 * outright once a request holds several of them, so those cost bandwidth and raise an
 * error while adding nothing — which is why they get their own button.
 *
 * Nothing here runs on its own: a transcript is the record of a session, and trimming it
 * is the user's call.
 */
function TranscriptImages({ sessionId, projectName }: { sessionId: string; projectName: string }) {
  const [audit, setAudit] = useState<ImageAudit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"oversized" | "all" | null>(null);
  const [freed, setFreed] = useState<{ removed: number; bytes: number } | null>(null);

  useEffect(() => {
    let live = true;
    api.get<ImageAudit>(
      `${projectUrl(projectName)}/chat/sessions/${sessionId}/images?project=${encodeURIComponent(projectName)}`,
    ).then((a) => { if (live) setAudit(a); })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [sessionId, projectName]);

  const strip = (mode: "oversized" | "all", includeAttachments = false) => {
    setBusy(mode);
    setError(null);
    api.post<{ removed: number; bytesFreed: number; remaining: ImageAudit }>(
      `${projectUrl(projectName)}/chat/sessions/${sessionId}/images/strip?project=${encodeURIComponent(projectName)}`,
      { mode, includeAttachments },
    ).then((r) => {
      setAudit(r.remaining);
      setFreed({ removed: r.removed, bytes: r.bytesFreed });
    }).catch((e: Error) => setError(e.message)).finally(() => setBusy(null));
  };

  if (error && !audit) return <p className="text-[11px] text-error">{error}</p>;
  if (!audit) return <p className="text-[11px] text-text-subtle">Scanning transcript for images...</p>;

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-foreground">Transcript images</h3>

      {audit.total === 0 ? (
        <p className="text-[11px] text-text-subtle">
          No images in this transcript{freed ? " — it is clean." : "."}
        </p>
      ) : (
        <p className="text-[11px] text-text-secondary">
          {audit.total} image{audit.total === 1 ? "" : "s"} · {fmtSize(audit.bytes)} of base64, replayed on
          every turn
          {audit.attachments > 0 && ` · ${audit.attachments} attached by you`}.
        </p>
      )}

      {audit.oversized > 0 && (
        <div className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-[11px] text-text-secondary">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" />
          <span>
            {audit.oversized} image{audit.oversized === 1 ? " reaches" : "s reach"} the {audit.limit}px
            limit (largest {audit.largestSide}px). Once a request carries several images the API rejects
            those outright, which fails the whole turn — removing them loses no context.
          </span>
        </div>
      )}

      {audit.oversizedAttachments > 0 && (
        <div className="flex flex-col gap-2 rounded-md border border-error/40 bg-error/10 p-2 text-[11px] text-text-secondary">
          <div className="flex gap-2">
            <TriangleAlert className="mt-px size-3.5 shrink-0 text-error" />
            <span>
              {audit.oversizedAttachments} of those {audit.oversizedAttachments === 1 ? "is an image you" : "are images you"}
              {" "}attached yourself, so the buttons below leave {audit.oversizedAttachments === 1 ? "it" : "them"} in place.
              While {audit.oversizedAttachments === 1 ? "it stays" : "they stay"}, every turn in this session keeps failing.
              The transcript holds the only copy — removing {audit.oversizedAttachments === 1 ? "it" : "them"} cannot be undone.
            </span>
          </div>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy !== null}
            onClick={() => strip("oversized", true)}
          >
            {busy === "oversized" ? <Loader2 className="size-3.5 animate-spin" /> : <ImageOff className="size-3.5" />}
            Remove oversized, attachments included
          </Button>
        </div>
      )}

      {freed && (
        <p className="text-[11px] text-success">
          Removed {freed.removed} image{freed.removed === 1 ? "" : "s"}, freed {fmtSize(freed.bytes)}.
        </p>
      )}
      {error && <p className="text-[11px] text-error">{error}</p>}

      <div className="flex flex-col gap-1.5 sm:flex-row">
        <Button
          size="sm"
          variant="outline"
          className="flex-1"
          disabled={busy !== null || audit.oversized === 0}
          onClick={() => strip("oversized")}
        >
          {busy === "oversized" ? <Loader2 className="size-3.5 animate-spin" /> : <ImageOff className="size-3.5" />}
          Remove oversized{audit.oversized > 0 ? ` (${audit.oversized} · ${fmtSize(audit.oversizedBytes)})` : ""}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          className="flex-1"
          disabled={busy !== null || audit.total === 0}
          onClick={() => strip("all")}
        >
          {busy === "all" ? <Loader2 className="size-3.5 animate-spin" /> : <ImageOff className="size-3.5" />}
          Remove all{audit.total > 0 ? ` (${audit.total} · ${fmtSize(audit.bytes)})` : ""}
        </Button>
      </div>
      <p className="text-[11px] text-text-subtle">
        These two buttons cover tool images only, and leave anything you attached alone. A removed tool
        image is replaced by its placeholder text; the chat still shows the file, re-read from disk.
      </p>
    </div>
  );
}

/**
 * Per-turn token history for the open session.
 *
 * Cost per turn is dominated by the replayed transcript, so a session that suddenly got
 * expensive is diagnosed by comparing its turns against each other: the cheap ones read
 * their prefix from cache, the expensive ones paid for it again.
 */
function TurnUsageHistory({ sessionId, projectName }: { sessionId: string; projectName: string }) {
  const [turns, setTurns] = useState<TurnRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.get<{ turns: TurnRecord[] }>(
      `${projectUrl(projectName)}/chat/sessions/${sessionId}/usage?project=${encodeURIComponent(projectName)}`,
    ).then((r) => { if (live) setTurns(r.turns); })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [sessionId, projectName]);

  if (error) return <p className="text-[11px] text-error">{error}</p>;
  if (!turns) return <p className="text-[11px] text-text-subtle">Loading token history...</p>;

  if (turns.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold text-foreground">Token &amp; cache</h3>
        <p className="text-[11px] text-text-subtle">
          No turns recorded yet. Send a message and the token split for each turn shows up here.
        </p>
      </div>
    );
  }

  const cold = turns.filter((t) => t.usage.coldStart).length;
  const totalCost = turns.reduce((s, t) => s + t.usage.costUsd, 0);
  const wasted = turns.reduce((s, t) => s + uncachedPrefixTokens(t.usage), 0);
  // More than one account over these turns explains cold prefixes on its own: the cache
  // does not follow a session across accounts.
  const accountsUsed = new Set(turns.map((t) => t.usage.accountId).filter(Boolean)).size;

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-foreground">Token &amp; cache</h3>
      <p className="text-[11px] text-text-secondary">
        Last {turns.length} turn{turns.length === 1 ? "" : "s"} · {cold} restarted the session ·{" "}
        {fmtTokens(wasted)} of transcript re-sent uncached · ${totalCost.toFixed(2)}
        {accountsUsed > 1 && ` · spread over ${accountsUsed} accounts`}
      </p>

      <div className="max-h-[30vh] overflow-y-auto rounded-md border border-border">
        <table className="w-full font-mono text-[10.5px]">
          <thead className="sticky top-0 bg-surface text-text-subtle">
            <tr>
              <th className="px-2 py-1 text-left font-normal">When</th>
              <th className="px-2 py-1 text-left font-normal">Account</th>
              <th className="px-2 py-1 text-right font-normal">Prefix</th>
              <th className="px-2 py-1 text-right font-normal">Cached</th>
              <th className="px-2 py-1 text-right font-normal">Cost</th>
              <th className="px-2 py-1 text-left font-normal">Start</th>
            </tr>
          </thead>
          <tbody>
            {turns.map((t) => {
              const hit = Math.round(t.usage.cacheHitRate * 100);
              const level = assessTurnCost(t.usage).level;
              return (
                <tr key={t.id} className="border-t border-border">
                  <td className="px-2 py-1 text-text-subtle">
                    {t.recordedAt.slice(11, 16) || t.recordedAt.slice(0, 10)}
                  </td>
                  <td
                    className="max-w-24 truncate px-2 py-1 text-text-subtle"
                    title={t.usage.accountLabel ?? t.usage.accountId ?? ""}
                  >
                    {t.usage.accountLabel ?? t.usage.accountId?.slice(0, 8) ?? "—"}
                  </td>
                  <td className="px-2 py-1 text-right text-text-secondary">
                    {fmtTokens(prefixTokens(t.usage))}
                  </td>
                  <td
                    className={`px-2 py-1 text-right ${
                      level === "bad" ? "text-warning" : level === "warn" ? "text-text-primary" : "text-success"
                    }`}
                  >
                    {hit}%
                  </td>
                  <td className="px-2 py-1 text-right text-text-secondary">
                    ${t.usage.costUsd.toFixed(3)}
                  </td>
                  <td className="px-2 py-1 text-text-subtle">
                    {t.usage.coldStart ? (t.usage.coldReason ?? "cold") : "warm"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-text-subtle">
        A high "Cached" share is the cheap case. A turn marked <code>idle_timeout</code> paid for the
        whole transcript again because the session sat idle with no tab open long enough for PPM to
        release its subprocess. The cache is scoped per account, so a turn on a different account
        starts cold no matter how the session was resumed.
      </p>
    </div>
  );
}

/**
 * Session debug facts and transcript maintenance.
 *
 * Controlled by the caller so the trigger can live anywhere — including inside a
 * dropdown menu, which unmounts its own items on select and would take an
 * internally-owned dialog down with them.
 */
export function SessionDebugDialog({
  sessionId,
  projectName,
  open,
  onOpenChange,
}: {
  sessionId: string;
  projectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [info, setInfo] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const isMobile = useIsMobile();

  useEffect(() => {
    if (!open) return;
    setCopied(false);
    setInfo(null);
    api.get<DebugInfo>(
      `${projectUrl(projectName)}/chat/sessions/${sessionId}/debug?project=${encodeURIComponent(projectName)}`,
    ).then((data) => {
      const weight = data.jsonlSizeBytes != null
        ? ` (${fmtMB(data.jsonlSizeBytes)}${data.jsonlLines != null ? `, ${data.jsonlLines} records` : ""})`
        : "";
      setInfo([
        `PPM Session: ${data.ppmSessionId}`,
        `SDK Session: ${data.sdkSessionId}`,
        data.jsonlPath ? `JSONL: ${data.jsonlPath}${weight}` : `JSONL: not found`,
        data.projectPath ? `Project: ${data.projectPath}` : null,
        ...gatherRenderStats(),
      ].filter(Boolean).join("\n"));
    }).catch(() => setInfo("Failed to load debug info"));
  }, [open, sessionId, projectName]);

  const copy = () => {
    if (!info) return;
    copyToClipboard(info).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const body = (
    <div className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Bug className="size-4 text-primary" />
        Session debug info
      </h2>
      <pre className="max-h-[35vh] overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-border bg-surface p-2.5 font-mono text-[11px] leading-relaxed text-text-secondary select-text">
        {info ?? "Loading..."}
      </pre>
      <Button size="sm" onClick={copy} disabled={!info} className="w-full">
        {copied ? <><ClipboardCheck className="size-3.5" /> Copied!</> : <><Copy className="size-3.5" /> Copy</>}
      </Button>
      <div className="border-t border-border pt-3">
        {open && <TurnUsageHistory sessionId={sessionId} projectName={projectName} />}
      </div>
      <div className="border-t border-border pt-3">
        {open && <TranscriptImages sessionId={sessionId} projectName={projectName} />}
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <BottomSheet open={open} onClose={() => onOpenChange(false)} className="popover-solid">
        <div className="max-h-[85vh] overflow-y-auto px-4 pb-4 pt-1">{body}</div>
      </BottomSheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogTitle className="sr-only">Session debug info</DialogTitle>
        {body}
      </DialogContent>
    </Dialog>
  );
}
