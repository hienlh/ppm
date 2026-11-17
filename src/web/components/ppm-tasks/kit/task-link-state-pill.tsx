/**
 * One link of a task with its live state beside it: a Jira key and its status, a PR with
 * open/merged and CI, a chat running or idle, a plain URL by its host. A state PPM could not read
 * says so ("state unknown · gh not available") rather than showing nothing.
 *
 * A link with a web address (`href`) is a real `<a target=_blank>`, so the browser opens it in a
 * tab of its own and no popup blocker stands in the way, and it carries the open-externally icon
 * after its state. A chat opens inside PPM through `onOpen`. With neither, the pill is plain text.
 */
import { ExternalLink, GitPullRequest, Link, MessageCircle, Ticket } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { linkStateView, type LinkTone } from "@/lib/ppm-tasks/ppm-tasks-kit-logic";
import type { LinkState, TaskLink } from "../../../../shared/ppm-tasks";

const ICON = { jira: Ticket, pr: GitPullRequest, session: MessageCircle, url: Link } as const;
const TONE: Record<LinkTone, string> = {
  info: "var(--info)",
  ok: "var(--success)",
  bad: "var(--error)",
  warn: "color-mix(in srgb, var(--warning) 72%, var(--text))",
  idle: "var(--text-3)",
  merge: "var(--accent-2)",
};

export interface TaskLinkStatePillProps {
  link: TaskLink;
  state?: LinkState | null;
  /** The link's web address (`http:`/`https:` only, see `taskLinkWebHref`): the pill becomes a link to it. */
  href?: string | null;
  /** Opens the link inside PPM (a chat); used when there is no `href`. */
  onOpen?(link: TaskLink): void;
  className?: string;
}

export function TaskLinkStatePill({ link, state, href, onOpen, className }: TaskLinkStatePillProps) {
  const view = linkStateView(link, state);
  const Icon = ICON[link.kind];
  const body = (
    <>
      <Icon aria-hidden className="size-3 shrink-0 text-text-3" />
      <span className="truncate font-mono text-[11px] text-text">{view.key}</span>
      {view.state ? (
        <span className="inline-flex min-w-0 items-center gap-1 truncate" style={{ color: TONE[view.tone] }} data-link-tone={view.tone}>
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
          {view.state}
        </span>
      ) : null}
      {href && <ExternalLink aria-hidden data-link-external className="size-3 shrink-0 text-text-3" />}
    </>
  );
  const cls = cn(
    "inline-flex h-[22px] max-w-full min-w-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border-soft bg-panel pl-1.5 pr-2 text-[11.5px] text-text-2",
    className,
  );
  const clickable = cn(cls, "relative hover:border-border max-md:h-8 max-md:after:absolute max-md:after:inset-x-0 max-md:after:-inset-y-[7px] max-md:after:content-['']");
  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" data-link-kind={link.kind} title={`Open ${href}`} className={clickable}>
        {body}
      </a>
    );
  }
  if (!onOpen) return <span className={cls} data-link-kind={link.kind}>{body}</span>;
  return (
    <button type="button" data-link-kind={link.kind} onClick={() => onOpen(link)} title={link.ref} className={clickable}>
      {body}
    </button>
  );
}
