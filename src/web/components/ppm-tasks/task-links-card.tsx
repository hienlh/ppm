/**
 * Links: Jira keys, PRs, PPM chats and plain URLs, each with its live state beside it and when PPM
 * last checked. "+ Add" takes a kind and a reference; the server checks the reference's shape.
 * A Jira key opens on the project's Jira site, a PR on GitHub, a URL as it is (each in a new
 * browser tab), and a chat opens in PPM. A Jira key whose project has no Jira site says so instead.
 */
import { useState } from "react";
import { Plus, X } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { ageShort } from "@/lib/ppm-tasks/task-format";
import { LINK_KINDS, type LinkKind, type LinkState, type TaskLink } from "../../../shared/ppm-tasks";
import type { TaskDto } from "../../../shared/ppm-tasks-api";
import { taskLinkWebHref } from "../../../shared/ppm-task-link-href";
import { TaskLinkStatePill } from "./kit/task-link-state-pill";
import { CardTextButton, TaskCard } from "./task-card";

const KIND_LABEL: Record<LinkKind, string> = { jira: "Jira key", pr: "Pull request", session: "PPM chat", url: "URL" };
const PLACEHOLDER: Record<LinkKind, string> = { jira: "NX-6318", pr: "owner/repo#123", session: "chat session id", url: "https://…" };

export interface TaskLinksCardProps {
  task: TaskDto;
  linkStates: readonly LinkState[];
  /** The project's Jira site (from its Jira config); without it a Jira key cannot open. */
  jiraSite?: string | null;
  onAdd(link: { kind: LinkKind; ref: string; label: string | null }): Promise<boolean>;
  onRemove(link: TaskLink): void;
  onOpenChat(sessionId: string): void;
}

export function TaskLinksCard({ task, linkStates, jiraSite, onAdd, onRemove, onOpenChat }: TaskLinksCardProps) {
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<LinkKind>("jira");
  const [ref, setRef] = useState("");
  const checked = linkStates.reduce<number | null>((n, s) => (s.checkedAt && (!n || s.checkedAt > n) ? s.checkedAt : n), null);
  const submit = async () => {
    if (!ref.trim()) return;
    if (await onAdd({ kind, ref: ref.trim(), label: null })) { setRef(""); setAdding(false); }
  };
  return (
    <TaskCard title="Links" count={task.links.length} data-task-card="links"
      aside={<>
        {checked && <span className="text-xs font-normal text-text-3">live · checked {ageShort(checked)} ago</span>}
        {!adding && <CardTextButton onClick={() => setAdding(true)}><Plus className="size-3" />Add</CardTextButton>}
      </>}>
      {task.links.length === 0 && !adding && <p className="text-[13px] text-text-3">No links. Add a Jira key, a PR or a chat to see its live state here.</p>}
      <ul className="space-y-1.5">
        {task.links.map((l) => {
          const href = taskLinkWebHref(l, { jiraSite });
          return (
            <li key={`${l.kind}:${l.ref}`} className="group flex min-w-0 items-center gap-2">
              <TaskLinkStatePill link={l} state={linkStates.find((s) => s.kind === l.kind && s.ref === l.ref)} href={href}
                onOpen={l.kind === "session" ? (link) => onOpenChat(link.ref) : undefined} className="min-w-0 max-w-full" />
              {l.label && l.kind !== "session" && <span className="min-w-0 truncate text-xs text-text-3">{l.label}</span>}
              {l.kind === "jira" && !href && (
                <span data-link-hint className="shrink-0 text-xs text-text-3" title="Connect this project to Jira (Jira panel) and its keys open on that site">
                  no Jira site
                </span>
              )}
              <span className="flex-1" />
              <button type="button" aria-label={`Remove ${l.ref}`} onClick={() => onRemove(l)}
                className="grid size-7 shrink-0 place-items-center rounded-md text-text-3 opacity-0 hover:bg-surface-hover hover:text-text focus:opacity-100 group-hover:opacity-100 max-md:opacity-100">
                <X className="size-3.5" />
              </button>
            </li>
          );
        })}
      </ul>
      {adding && (
        <form className="mt-2 flex flex-wrap gap-1.5" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <select aria-label="Link kind" value={kind} onChange={(e) => setKind(e.target.value as LinkKind)}
            className="h-8 rounded-md border border-border-soft bg-surface px-1.5 text-xs text-text">
            {LINK_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
          <input autoFocus aria-label="Link reference" value={ref} onChange={(e) => setRef(e.target.value)} placeholder={PLACEHOLDER[kind]}
            className="h-8 min-w-0 flex-1 basis-40 rounded-md border border-border-soft bg-surface px-2 font-mono text-xs text-text outline-none focus:border-ring" />
          <Button size="sm" type="submit" disabled={!ref.trim()}>Add</Button>
          <Button size="sm" type="button" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
        </form>
      )}
    </TaskCard>
  );
}
