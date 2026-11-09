import type { DesignCommentGuestView } from "../../../shared/design-comment-thread-types.ts";
import { createLogger } from "../../logger.ts";
import { notificationService, type BroadcastOptions, type NotificationPayload } from "../../notification.service.ts";
import { truncateText } from "../../notification-format.ts";
import { projectNameForPath } from "../../project-name-for-path.ts";
import { isValidDesignSlug } from "../design-slug.ts";
import { loadManifest } from "../design-store.service.ts";
import type { ResolvedShareLink } from "./design-share-resolve.ts";

const log = createLogger("design-share");

/**
 * Tells the owner that reviewers wrote on a shared design: one notification per link that
 * folds every comment and reply written before it went out ("3 new comments on Landing
 * from Alice, Bob"). Two limits apply on top of the notification delay. Waiting
 * notifications share a coalesce key per link, so the newest replaces the older ones. And
 * a link is told at most once per {@link FLOOR_MS}, even with the delay at "right away",
 * so a busy review cannot turn into a stream of pushes: writes inside the floor are folded
 * into one summary sent when it ends.
 *
 * Reviewer names and bodies are untrusted. They are reduced to one line of plain text and
 * capped here; each channel then escapes what it shows (Telegram HTML) or sends it as
 * plain text (push, ntfy without markdown).
 */

export const FLOOR_MS = 60_000;
const NAMES_SHOWN = 3;
const EXCERPT_MAX = 200;
const TITLE_MAX = 80;
const NAME_MAX = 40;
/** Per-write names kept per link; the count goes on past it, the "and N more" stops growing. */
const NAMES_KEPT = 500;

export interface GuestWrite { name: string; body: string }

interface LinkState {
  linkId: string;
  projectPath: string;
  slug: string;
  title: string;
  /** Writes not yet told, and the reviewer name of each (oldest first, capped). */
  count: number;
  names: string[];
  excerpt: string;
  lastSentAt: number;
  floorTimer: ReturnType<typeof setTimeout> | null;
}

export interface DesignShareNotifierDeps {
  broadcast: (type: "design_review", payload: NotificationPayload, opts: BroadcastOptions) => Promise<unknown>;
  floorMs: number;
  now: () => number;
  titleOf: (designDir: string, slug: string) => Promise<string>;
}

// Control characters, line breaks and bidi controls become spaces: one line, read as written.
const UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]+/gu;

export function plainLine(text: string, max: number): string {
  return truncateText(text.replace(UNSAFE, " ").replace(/\s+/g, " "), max);
}

/** "Alice", "Alice and Bob", "Alice, Bob and Carol", "Alice, Bob, Carol and 2 more". */
export function formatReviewerNames(names: readonly string[]): string {
  const unique = [...new Set(names)];
  if (unique.length <= 1) return unique[0] ?? "a reviewer";
  if (unique.length <= NAMES_SHOWN) return `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`;
  return `${unique.slice(0, NAMES_SHOWN).join(", ")} and ${unique.length - NAMES_SHOWN} more`;
}

async function manifestTitle(designDir: string, slug: string): Promise<string> {
  return (await loadManifest(designDir, slug)).manifest.title;
}

export class DesignShareNotifier {
  private readonly links = new Map<string, LinkState>();
  private readonly deps: DesignShareNotifierDeps;

  constructor(deps: Partial<DesignShareNotifierDeps> = {}) {
    this.deps = {
      broadcast: (type, payload, opts) => notificationService.broadcast(type, payload, opts),
      floorMs: FLOOR_MS,
      now: () => Date.now(),
      titleOf: manifestTitle,
      ...deps,
    };
  }

  /** Count one reviewer write. Never throws and never waits on a channel. */
  async noteGuestWrite(resolved: Pick<ResolvedShareLink, "link" | "designDir">, write: GuestWrite): Promise<void> {
    const { link } = resolved;
    let title = link.slug;
    try {
      title = (await this.deps.titleOf(resolved.designDir, link.slug)) || link.slug;
    } catch { /* the slug still names the design */ }

    // Everything from here on is synchronous, so two writes arriving together cannot both
    // pass the floor.
    const now = this.deps.now();
    this.prune(now);
    let state = this.links.get(link.id);
    if (!state) {
      state = {
        linkId: link.id, projectPath: link.projectPath, slug: link.slug, title: "",
        count: 0, names: [], excerpt: "", lastSentAt: -Infinity, floorTimer: null,
      };
      this.links.set(link.id, state);
    }
    state.title = plainLine(title, TITLE_MAX);
    state.count++;
    if (state.names.length < NAMES_KEPT) state.names.push(plainLine(write.name, NAME_MAX) || "a reviewer");
    state.excerpt = plainLine(write.body, EXCERPT_MAX);

    if (state.floorTimer) return;
    const wait = state.lastSentAt + this.deps.floorMs - now;
    if (wait > 0) {
      const waiting = state;
      waiting.floorTimer = setTimeout(() => {
        waiting.floorTimer = null;
        this.flush(waiting);
      }, wait);
      return;
    }
    this.flush(state);
  }

  /** Links with something waiting, for tests. */
  pendingCount(): number {
    let n = 0;
    for (const state of this.links.values()) if (state.count > 0) n++;
    return n;
  }

  private flush(state: LinkState): void {
    if (state.count === 0) return;
    const told = { count: state.count, names: state.names.length };
    const forget = () => {
      state.count = Math.max(0, state.count - told.count);
      state.names.splice(0, told.names);
    };
    this.deps.broadcast("design_review", this.payloadOf(state), {
      coalesceKey: `design-share:${state.linkId}`,
      onSend: () => {
        state.lastSentAt = this.deps.now();
        forget();
      },
    })
      .then((outcome) => {
        // Switched off: nothing will ever tell these writes, so they are not carried over.
        if (outcome === "off" || outcome === "seen") forget();
      })
      .catch((e) => log.warn(`Reviewer notification for link ${state.linkId} failed: ${(e as Error).message}`));
  }

  private payloadOf(state: LinkState): NotificationPayload {
    const project = projectNameForPath(state.projectPath) ?? "";
    const n = state.count;
    return {
      title: "New design feedback",
      body: `${n} new comment${n === 1 ? "" : "s"} on ${state.title} from ${formatReviewerNames(state.names)}`,
      detail: state.excerpt || undefined,
      detailStyle: "quote",
      project,
      sessionId: "",
      ...(project && isValidDesignSlug(state.slug) && {
        path: `/project/${encodeURIComponent(project)}/design/${state.slug}`,
      }),
    };
  }

  /** Drop links with nothing waiting whose floor is over, so the map holds only live reviews. */
  private prune(now: number): void {
    for (const [id, state] of this.links) {
      if (state.count === 0 && !state.floorTimer && now - state.lastSentAt >= this.deps.floorMs) this.links.delete(id);
    }
  }
}

export const designShareNotifier = new DesignShareNotifier();

/**
 * After a reviewer's comment or reply was stored: count it for the owner's notification.
 * Fire and forget — the reviewer's answer never waits on it.
 */
export function notifyGuestWrite(
  resolved: ResolvedShareLink, thread: DesignCommentGuestView, kind: "comment" | "reply",
): void {
  const entry = kind === "comment" ? thread : thread.replies.findLast((r) => r.mine);
  if (!entry || entry.author.kind !== "guest") return;
  void designShareNotifier.noteGuestWrite(resolved, { name: entry.author.name, body: entry.body })
    .catch((e) => log.warn(`Reviewer notification for link ${resolved.link.id} failed: ${(e as Error).message}`));
}
