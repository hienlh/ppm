/**
 * Parser for `git blame --porcelain`.
 *
 * The porcelain format emits a commit's full header only the *first* time that
 * commit is seen; every later line from it carries just the sha, an optional
 * `previous`/`filename`, and the content. So headers accumulate into a map and
 * lines reference it by sha. `--line-porcelain` would repeat every header and
 * roughly triple the output for no extra information.
 */
import { isUncommittedHash, type BlameCommitInfo, type BlameLine, type BlameResult } from "../../shared/blame.ts";

function stripAngles(value: string): string {
  return value.replace(/^</, "").replace(/>$/, "");
}

export function parseBlamePorcelain(stdout: string): BlameResult {
  const commits: Record<string, BlameCommitInfo> = {};
  const lines: BlameLine[] = [];

  // Split on \n only: a content line may legitimately end with \r (a CRLF
  // file), and that \r belongs to the file, not to the porcelain framing.
  let current: BlameCommitInfo | null = null;
  let finalLine = 0;
  let origLine = 0;

  for (const raw of stdout.split("\n")) {
    if (raw === "") continue;

    // A content line is the only kind that starts with a tab, and it closes the
    // record — the next header line begins a new one.
    if (raw.startsWith("\t")) {
      if (current) lines.push({ hash: current.hash, finalLine, origLine });
      current = null;
      continue;
    }

    const header = /^([0-9a-f]{40})\s+(\d+)\s+(\d+)(?:\s+(\d+))?$/.exec(raw);
    if (header) {
      const hash = header[1]!;
      origLine = Number(header[2]);
      finalLine = Number(header[3]);
      let info = commits[hash];
      if (!info) {
        info = {
          hash,
          author: isUncommittedHash(hash) ? "You" : "",
          authorMail: "",
          authorTime: 0,
          summary: isUncommittedHash(hash) ? "Uncommitted changes" : "",
        };
        commits[hash] = info;
      }
      current = info;
      continue;
    }

    if (!current) continue;

    const sep = raw.indexOf(" ");
    const key = sep === -1 ? raw : raw.slice(0, sep);
    const value = sep === -1 ? "" : raw.slice(sep + 1);

    switch (key) {
      case "author":
        if (value) current.author = value;
        break;
      case "author-mail":
        current.authorMail = stripAngles(value);
        break;
      case "author-time":
        current.authorTime = Number(value) || 0;
        break;
      case "summary":
        if (value) current.summary = value;
        break;
      case "filename":
        current.filename = value;
        break;
      case "previous":
        // "previous <sha> <path>" — only the sha is useful here.
        current.previous = value.split(" ")[0];
        break;
      default:
        break;
    }
  }

  return { lines, commits };
}
