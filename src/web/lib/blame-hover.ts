/**
 * The markdown behind the editor's blame hover — GitLens' hover, rebuilt.
 *
 * Monaco's hover renders a markdown string and nothing else, so everything the
 * hover shows has to survive being written as markdown: the avatar is a data-URI
 * image, the buttons are `command:` links, and the diff is a fenced block.
 *
 * Three things about that are load-bearing and were each verified against a real
 * Monaco 0.55.1 rather than assumed:
 *
 * - `command:` links are stripped unless the string is trusted, and a trusted
 *   string with `isTrusted: true` allows *every* registered command. This one
 *   carries a commit message, and anyone who can land a commit can put
 *   `[click](command:whatever)` in one — so the trust is narrowed to the four
 *   commands here via `enabledCommands`, and the message is escaped on top.
 * - `supportHtml` stays off. The avatar is `![](data:image/svg+xml,…)`, which
 *   renders inline at its own intrinsic size, so no `<img width>` is needed and
 *   no HTML from a commit message can render at all.
 * - a ```diff block is only coloured because `monaco-diff-language.ts`
 *   registers the language Monaco lacks.
 */
import type * as MonacoType from "monaco-editor";
import {
  formatAbsoluteTime,
  formatRelativeTime,
  isUncommittedHash,
  type BlameCommitInfo,
  type BlameLineDetail,
} from "../../shared/blame";

/** The commands the hover's links may run. Nothing else, whatever a message says. */
export const BLAME_HOVER_COMMANDS = [
  "ppm.blame.copySha",
  "ppm.blame.fileHistory",
  "ppm.blame.blameFile",
  "ppm.blame.showInGraph",
] as const;

/** How much of a sha to show. Git's own default abbreviation. */
const SHORT_SHA = 7;

/**
 * Escape the markdown a commit message or an author name would otherwise be
 * read as. The character set is VS Code's own `escapeMarkdownSyntaxTokens`.
 *
 * `[` and `]` are the ones that matter most: without them a message reading
 * `[click](command:…)` becomes a button in the hover.
 *
 * `<` and `>` are added to VS Code's set because the renderer does not leave an
 * unknown tag alone — it strips the tag and keeps the text inside, so a message
 * mentioning `<script>alert(1)</script>` displayed as `alert(1)`. Not a script
 * that runs, but a commit message rewritten in the one view whose job is to
 * show it verbatim. A backslash escape rather than an entity: `&lt;` would come
 * back out literally, since `&` is not escaped here.
 *
 * Newlines are left alone; the message's own line breaks are wanted.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-!<>]/g, (c) => `\\${c}`);
}

/** Initials for the avatar: first letters of the first and last word. */
export function authorInitials(author: string): string {
  const words = author.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]![0]!;
  const last = words.length > 1 ? words[words.length - 1]![0]! : "";
  return (first + last).toUpperCase();
}

/**
 * A stable colour per author, from VS Code's chart palette.
 *
 * Deliberately not a gravatar. Fetching one would send a hash of the
 * committer's email to a third party on every hover, which a self-hosted tool
 * must not do silently — the same reason the git graph's author chips are
 * initials.
 */
const AVATAR_COLOURS = ["4E79A7", "F28E2B", "E15759", "76B7B2", "59A14F", "AF7AA1", "9C755F", "B07AA1"];

export function authorColour(author: string): string {
  let hash = 0;
  for (let i = 0; i < author.length; i++) hash = (hash * 31 + author.charCodeAt(i)) | 0;
  return AVATAR_COLOURS[Math.abs(hash) % AVATAR_COLOURS.length]!;
}

/**
 * The avatar as an inline SVG data URI, sized 16×16 so it needs no HTML
 * attributes to sit on the same line as the name.
 *
 * `charset=utf-8` matters: initials can be non-ASCII, and without it the
 * browser decodes the percent-escapes as latin-1 and draws mojibake.
 */
export function avatarDataUri(author: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">` +
    `<circle cx="8" cy="8" r="8" fill="#${authorColour(author)}"/>` +
    `<text x="8" y="11.5" font-family="sans-serif" font-size="7" font-weight="700" ` +
    `fill="#ffffff" text-anchor="middle">${escapeXml(authorInitials(author))}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** `command:id?["arg","arg"]`, percent-encoded as the opener expects. */
function commandUri(command: (typeof BLAME_HOVER_COMMANDS)[number], args: unknown[]): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

export interface BlameHoverOptions {
  commit: BlameCommitInfo;
  /** Null while the `git show` is still in flight, or when it found nothing. */
  detail: BlameLineDetail | null;
  /** Project-relative path of the open file, for the action links. */
  filePath: string;
  /** Absolute path of the project, which is what the git-graph commands take. */
  projectPath?: string;
  /** Parameter rather than the clock, so the wording is testable. */
  now?: number;
}

/**
 * The hover for a committed line.
 *
 * Returns null for an uncommitted line: there is no commit to describe, and the
 * annotation already says "You, uncommitted changes".
 */
export function buildBlameHoverMarkdown(options: BlameHoverOptions): MonacoType.IMarkdownString | null {
  const { commit, detail, filePath, projectPath, now = Date.now() } = options;
  if (isUncommittedHash(commit.hash)) return null;

  const author = commit.author || "Unknown";
  const shortSha = commit.hash.slice(0, SHORT_SHA);
  const lines: string[] = [];

  // Row 1: avatar, author, and both readings of the date — "9 months ago" is
  // what you want to know, the exact date is what you need to go looking.
  const when = commit.authorTime > 0
    ? `${formatRelativeTime(commit.authorTime * 1000, now)} (${formatAbsoluteTime(commit.authorTime * 1000)})`
    : "";
  lines.push(`![](${avatarDataUri(author)}) **${escapeMarkdown(author)}**${when ? ` &nbsp;$(history) ${escapeMarkdown(when)}` : ""}`);

  // Row 2: the whole message, not just the summary the annotation shows.
  const message = detail?.message || commit.summary;
  if (message) {
    lines.push("");
    // A blank line inside the message would end the markdown paragraph and
    // leave the body unindented; two trailing spaces make each line its own.
    lines.push(escapeMarkdown(message).split("\n").join("  \n"));
  }

  // A rule between sections, as GitLens has. It must be preceded by a blank
  // line: `text` then `---` on the next line is a setext heading in markdown,
  // which would turn the last line of the commit message into a title.
  const RULE = ["", "---", ""];

  // Row 3: the sha, and the things PPM can actually do with it.
  const actions = [
    `[$(git-commit) ${shortSha}](${commandUri("ppm.blame.copySha", [commit.hash])} "Copy commit hash")`,
  ];
  // The Git Graph views are addressed by absolute project path. Without one the
  // links would dispatch an empty first argument, which the extension reads as
  // "resolve the project yourself" — so it might open a *different* project's
  // history. Better to not offer the button.
  if (projectPath) {
    actions.push(
      `[$(history) File History](${commandUri("ppm.blame.fileHistory", [projectPath, filePath])} "Open the file's history")`,
      `[$(users) Blame](${commandUri("ppm.blame.blameFile", [projectPath, filePath])} "Open the blame view")`,
      `[$(git-branch) Graph](${commandUri("ppm.blame.showInGraph", [projectPath])} "Open the commit graph")`,
    );
  }
  lines.push(...RULE);
  lines.push(actions.join(" &nbsp; "));

  // Row 4: what this commit did to this line.
  const diff = [...(detail?.removed ?? []).map((l) => `-${l}`), ...(detail?.added ?? []).map((l) => `+${l}`)];
  if (diff.length > 0) {
    lines.push(...RULE);
    lines.push("```diff");
    lines.push(...diff);
    lines.push("```");
    lines.push("");
    // GitLens' wording, and the distinction is worth keeping: a line that only
    // ever appeared in this commit reads differently from one it rewrote.
    const verb = (detail?.removed.length ?? 0) === 0 ? "added in" : "in";
    lines.push(`Changes ${verb} \`${shortSha}\``);
  }

  return {
    value: lines.join("\n"),
    // Narrowed on purpose. `true` here would let a commit message's own
    // `command:` link run anything registered, and a commit message is not
    // ours. See the module comment.
    isTrusted: { enabledCommands: [...BLAME_HOVER_COMMANDS] },
    supportThemeIcons: true,
  };
}
