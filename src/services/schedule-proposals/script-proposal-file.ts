/**
 * Reading a `.ppm-schedule.json` an AI names as its proposal. The file is read once, before the
 * card is built, and its SHA-256 is kept: after the user answers it is hashed again, and a file
 * that changed in between creates nothing — the card showed the old contents.
 *
 * Only a file of that suffix, inside one of the caller's folders (a chat's own project, any
 * registered project for the Assistant), and small enough to show whole. Nothing of the file's
 * text reaches an error message: a file picked by mistake can hold a token.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { SCHEDULE_TEMPLATE_SUFFIX } from "../../shared/schedule-template.ts";
import { isInsideDir, realPathOrSelfSync } from "../fs-ops/fs-real-path.ts";

/** Larger than any valid template (a script is at most 1 MB), small enough to read at once. */
export const MAX_PROPOSAL_FILE_BYTES = 2 * 1024 * 1024;

export interface ProposalFile {
  /** The path as the card shows it: absolute, resolved. */
  path: string;
  text: string;
  sha256: string;
}

export type ProposalFileRead = { ok: true; file: ProposalFile } | { ok: false; error: string };

export const sha256Of = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");

/** `raw` read as a proposal file, if it is one inside `roots`. */
export function readProposalFile(raw: unknown, roots: readonly string[], where = "this chat's project folder"): ProposalFileRead {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: "`file` must be the path of a .ppm-schedule.json file." };
  if (!isAbsolute(raw)) return { ok: false, error: "`file` must be an absolute path." };
  const path = resolve(raw);
  if (!path.toLowerCase().endsWith(SCHEDULE_TEMPLATE_SUFFIX)) {
    return { ok: false, error: `\`file\` must name a schedule template, a file ending in ${SCHEDULE_TEMPLATE_SUFFIX}.` };
  }
  // The real path decides: a link inside the project pointing elsewhere is elsewhere.
  const real = realPathOrSelfSync(path);
  if (!roots.some((root) => isInsideDir(real, realPathOrSelfSync(resolve(root))))) {
    return { ok: false, error: `\`file\` must be inside ${where}.` };
  }
  let size: number;
  try {
    const stat = statSync(real);
    if (!stat.isFile()) return { ok: false, error: "`file` is not a file." };
    size = stat.size;
  } catch {
    return { ok: false, error: "`file` does not exist or cannot be read." };
  }
  if (size > MAX_PROPOSAL_FILE_BYTES) return { ok: false, error: "`file` is larger than 2 MB, too large to be a schedule template." };
  const bytes = readFileSync(real);
  return { ok: true, file: { path, text: bytes.toString("utf8"), sha256: sha256Of(bytes) } };
}

/** Whether the file still holds exactly the bytes the card was built from. */
export function proposalFileUnchanged(file: Pick<ProposalFile, "path" | "sha256">): boolean {
  try {
    return sha256Of(readFileSync(realPathOrSelfSync(file.path))) === file.sha256;
  } catch {
    return false;
  }
}
