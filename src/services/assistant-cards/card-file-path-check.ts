import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { CARD_FILE_MAX_BYTES, REPORT_FILE_PATH_MAX, formatFileSize } from "../../shared/card-files.ts";
import { isCredentialPath } from "../fs-credential-path-guard.ts";
import { assistantPrivateScope, isAssistantPrivatePath, type AssistantPrivateScope } from "../assistant/assistant-private-paths.ts";
import { expandHome, isInside, isWindowsNonDrivePath, namesAlternateStream } from "../tool-path-scope.ts";

/**
 * Which file a manager may put on a report card (`report_to_assistant { files }`). The file goes to
 * the user's phone through Telegram, i.e. out of the machine, so the rule is narrow and fails
 * closed:
 *
 *  - it lies inside the reporting chat's own project folder, or inside a folder the user listed in
 *    Settings → PPM Assistant → Files on cards; judged both as written and at its real location,
 *    so `..` and a symlink pointing out of those folders are refused alike;
 *  - it is nowhere private, whatever folder holds it: the PPM folder (config database, vault
 *    files, Codex homes), `~/.cloudflared`, the database snapshots
 *    (`fs-credential-path-guard.ts`), and every credential store the PPM Assistant asks before
 *    reading (`~/.ssh`, `~/.aws`, `~/.gnupg`, a home folder's dot-entries when the project is the
 *    home folder…, `assistant-private-paths.ts`);
 *  - it is not a secret by its name: `.env` files, private keys and key stores, credential files,
 *    and anything inside a `.git`, `.ssh`, `.gnupg` or `.aws` folder in any project;
 *  - it is an ordinary file (not a folder, a device or a pipe) of at most
 *    {@link CARD_FILE_MAX_BYTES}.
 *
 * The answer names the real path: that is the file PPM copies, so a link swapped after the check
 * cannot redirect the copy (`card-files-store.ts` checks it is still that file when it opens it).
 */

export interface ReportFileRoots {
  /** The reporting chat's project folder. */
  projectPath: string;
  /** Folders the user allowed besides the project (Settings → PPM Assistant → Files on cards). */
  allowedDirs: readonly string[];
  /** Replaces the private-path scope, for tests. */
  scope?: AssistantPrivateScope;
}

export type ReportFileCheck =
  | { ok: true; realPath: string; name: string; size: number }
  | { ok: false; error: string };

/** Names that hold secrets wherever they are. Compared case-folded. */
const SECRET_NAMES = new Set([
  ".netrc", "_netrc", ".npmrc", ".pypirc", ".git-credentials", ".pgpass", ".my.cnf", ".vault-token", ".envrc",
  "credentials", "credentials.json", "credentials.yml", "credentials.yaml", "client_secret.json", "service-account.json",
  "secrets.json", "secrets.yml", "secrets.yaml", "auth.json", ".credentials.json",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "id_ecdsa_sk", "id_ed25519_sk", "authorized_keys", "known_hosts",
  "ppm.db", "ppm.dev.db",
]);
/** Extensions of key and key-store files. */
const SECRET_EXTENSIONS = [
  ".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".kdbx", ".ppk", ".gpg", ".pgp", ".asc", ".ovpn", ".tfstate",
  ".tfvars", ".age",
];
/** A folder that marks everything under it private, at any depth in any project. */
const SECRET_SEGMENTS = new Set([".git", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".password-store"]);

/** Why the name alone makes the file a secret, or null. */
export function secretFileNameReason(path: string): string | null {
  const segments = path.split(/[\\/]+/).filter(Boolean).map((s) => s.toLowerCase());
  const name = segments.at(-1) ?? "";
  for (const segment of segments.slice(0, -1)) {
    if (SECRET_SEGMENTS.has(segment)) return `it is inside a ${segment} folder`;
  }
  if (name === ".env" || name.startsWith(".env.") || name.endsWith(".env")) return "it is an environment file (.env), which holds secrets";
  if (SECRET_NAMES.has(name)) return "its name is that of a credential or key file";
  if (/^id_[a-z0-9_]+(?:\.pub)?$/.test(name)) return "it is an SSH key";
  if (SECRET_EXTENSIONS.some((ext) => name.endsWith(ext))) return "it is a key or key-store file";
  return null;
}

/** Both spellings of each root: as configured and at its real location. */
function rootSpellings(roots: readonly string[]): string[] {
  const out = new Set<string>();
  for (const root of roots) {
    if (!root || isWindowsNonDrivePath(root)) continue;
    const abs = resolve(expandHome(root));
    out.add(abs);
    try { out.add(realpathSync(abs)); } catch { /* a missing folder holds nothing */ }
  }
  return [...out];
}

const insideAny = (path: string, roots: readonly string[]) => roots.some((root) => isInside(path, root));

/**
 * Whether `raw` (absolute, `~/…`, or relative to the project folder) names a file a manager may
 * attach. Touches the disk only after the text itself passed.
 */
export function checkReportFilePath(raw: unknown, roots: ReportFileRoots): ReportFileCheck {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: "Each of `files` is a path to a file." };
  const text = raw.trim();
  if (text.length > REPORT_FILE_PATH_MAX) return { ok: false, error: `A path is at most ${REPORT_FILE_PATH_MAX} characters.` };
  const shown = text.length > 80 ? `…${text.slice(-79)}` : text;
  const refuse = (why: string): ReportFileCheck => ({ ok: false, error: `"${shown}" cannot be attached: ${why}.` });
  if (/[\0\r\n]/.test(text)) return refuse("the path has a control character in it");
  const expanded = expandHome(text);
  // `resolve` is text only; the disk is not touched until the path passed.
  const written = isAbsolute(expanded) ? resolve(expanded) : resolve(roots.projectPath, expanded);
  // A UNC or device path is never opened: resolving it reaches out over the network.
  if (isWindowsNonDrivePath(written)) return refuse("it is a network or device path");
  if (process.platform === "win32" && namesAlternateStream(written)) return refuse("it names an NTFS stream");

  const allowed = rootSpellings([roots.projectPath, ...roots.allowedDirs]);
  if (!insideAny(written, allowed)) return refuse("it is outside this project's folder and the folders allowed in Settings → PPM Assistant → Files on cards");
  const named = secretFileNameReason(written);
  if (named) return refuse(named);

  let real: string;
  try {
    real = realpathSync(written);
  } catch {
    return refuse("there is no such file");
  }
  // The real location is judged again: `..` is gone from it, and a link pointing out shows here.
  if (!insideAny(real, allowed)) return refuse("it is a link to a file outside the allowed folders");
  const realNamed = secretFileNameReason(real);
  if (realNamed) return refuse(realNamed);
  const scope = roots.scope ?? assistantPrivateScope({ projectRoots: [roots.projectPath, ...roots.allowedDirs] });
  for (const p of new Set([written, real])) {
    if (isCredentialPath(p) || isAssistantPrivatePath(p, scope)) return refuse("it is in a private folder (PPM's own folder or a credential store)");
  }

  let size: number;
  try {
    const link = lstatSync(real);
    const st = statSync(real);
    if (link.isSymbolicLink() || !st.isFile()) return refuse("it is not an ordinary file");
    size = st.size;
  } catch {
    return refuse("it could not be read");
  }
  if (size === 0) return refuse("it is empty");
  if (size > CARD_FILE_MAX_BYTES) return refuse(`it is ${formatFileSize(size)}, over the ${formatFileSize(CARD_FILE_MAX_BYTES)} a card holds`);
  return { ok: true, realPath: real, name: basename(real.endsWith(sep) ? real.slice(0, -1) : real), size };
}
