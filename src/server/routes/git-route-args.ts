import { assertRef } from "../../services/git-branch-diff/branch-diff-parse.ts";

/**
 * The checks the git write routes make on the values they hand git as positional arguments.
 *
 * A shell is never involved, so the hazard is not a metacharacter but a value git reads as
 * something other than what the field means: `--no-ff` given as a merge source is an option,
 * `--exec=…` given as a hash is an option, `--force` given as a remote force-pushes, and a push
 * branch of `:main` deletes the remote branch while `+main` force-pushes it. Each check answers
 * the refusal as a message naming the field, or null; the routes answer it as a 400, for every
 * caller — the browser, the Assistant's tools and the CLI alike.
 */

/** `value` as a branch or tag name git will not read as an option, a range or a refspec. */
export function refProblem(value: unknown, field: string): string | null {
  if (typeof value !== "string") return `Invalid git ref for ${field}: expected a name`;
  try {
    assertRef(value, field);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

const HASH = /^[0-9a-f]{7,64}$/i;

/** A commit named by its hash, full or abbreviated: nothing else reaches cherry-pick, revert or tag. */
export function hashProblem(value: unknown, field: string): string | null {
  if (typeof value === "string" && HASH.test(value)) return null;
  return `Invalid ${field}: "${String(value)}" (a commit hash is 7 to 64 hexadecimal digits)`;
}

const HEADS = "refs/heads/";

/**
 * A push's `branch`: a branch name, or the fully qualified `refs/heads/<a>:refs/heads/<b>`
 * refspec the Assistant's push sends so the repository's push configuration cannot redirect it.
 * Both sides of a refspec must be named: an empty source (`:main`) deletes the remote branch.
 */
export function pushBranchProblem(value: unknown): string | null {
  if (typeof value !== "string") return "Invalid branch: expected a name";
  const sides = value.split(":");
  if (sides.length === 1) return refProblem(value, "branch");
  const qualified = sides.length === 2 && sides.every((s) => s.startsWith(HEADS) && s.length > HEADS.length);
  if (!qualified) return `Invalid branch: "${value}" (a branch name, or refs/heads/<branch>:refs/heads/<branch>)`;
  for (const side of sides) {
    const problem = refProblem(side, "branch");
    if (problem) return problem;
  }
  return null;
}

/** A push's `remote`: one this repository has configured, never a URL, a path or an option. */
export function remoteProblem(value: unknown, remotes: readonly string[]): string | null {
  if (typeof value === "string" && remotes.includes(value)) return null;
  const known = remotes.length ? remotes.join(", ") : "none";
  return `Invalid remote: "${String(value)}" (this repository's remotes: ${known})`;
}
