/**
 * Parsing for `git reflog`, the record of everywhere HEAD has been.
 *
 * The reflog is what makes a bad rebase, a lost branch or a hard reset
 * recoverable: the commits are still there, and this is the only listing that
 * names them. So the parse has to be lossless about the *selector*
 * (`HEAD@{7}`) — that is what a recovery command is given.
 */

/** Fields, in the order `REFLOG_FORMAT` requests them. */
export const REFLOG_FIELD_SEP = "\x1f";
export const REFLOG_RECORD_SEP = "\x1e";
export const REFLOG_FORMAT =
  `--format=%H${REFLOG_FIELD_SEP}%gD${REFLOG_FIELD_SEP}%gs${REFLOG_FIELD_SEP}%an${REFLOG_FIELD_SEP}%ae${REFLOG_FIELD_SEP}%at${REFLOG_FIELD_SEP}%s${REFLOG_RECORD_SEP}`;

export interface ReflogEntry {
  hash: string;
  /** The selector git accepts back, e.g. `HEAD@{3}`. */
  selector: string;
  /** What moved HEAD: "commit: …", "rebase (finish)", "reset: moving to …". */
  action: string;
  /** The leading verb of `action`, for grouping and colour. */
  kind: string;
  author: string;
  authorEmail: string;
  /** Unix seconds. */
  authorDate: number;
  /** The commit's own subject, which the action text often does not repeat. */
  subject: string;
}

/**
 * The verb git puts before the colon. `rebase (finish): returning to …` has no
 * colon-delimited single word, so the parenthesised form is handled too.
 */
export function reflogKind(action: string): string {
  const head = action.split(":")[0] ?? "";
  const word = head.trim().split(/[\s(]/)[0] ?? "";
  return word.toLowerCase();
}

export function parseReflog(stdout: string): ReflogEntry[] {
  const entries: ReflogEntry[] = [];

  for (const record of stdout.split(REFLOG_RECORD_SEP)) {
    const trimmed = record.replace(/^\n+/, "");
    if (!trimmed.trim()) continue;

    const fields = trimmed.split(REFLOG_FIELD_SEP);
    const hash = fields[0] ?? "";
    // A record that lost its framing is dropped rather than half-read: a wrong
    // selector here would point a recovery command at the wrong commit.
    if (!/^[0-9a-f]{7,40}$/i.test(hash)) continue;

    const action = fields[2] ?? "";
    entries.push({
      hash,
      selector: fields[1] ?? "",
      action,
      kind: reflogKind(action),
      author: fields[3] ?? "",
      authorEmail: fields[4] ?? "",
      authorDate: Number(fields[5]) || 0,
      subject: fields[6] ?? "",
    });
  }

  return entries;
}

/**
 * The selectors git will accept back. Anything else is refused rather than
 * passed to git, since these arrive from the webview.
 *
 * `HEAD@{12}` and `refs/heads/main@{3}` are the shapes `git reflog` emits for
 * `%gD`; a bare sha is accepted too, because the panel's actions target the
 * commit either way.
 */
export function assertValidSelector(value: unknown): string {
  const selector = String(value ?? "");
  if (/^[0-9a-f]{7,40}$/i.test(selector)) return selector;
  if (/^[A-Za-z0-9._\/-]{1,255}@\{\d{1,9}\}$/.test(selector) && !selector.includes("..")) {
    return selector;
  }
  throw new Error(`Invalid reflog selector: "${selector}"`);
}
