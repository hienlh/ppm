/**
 * Parsing for `git submodule status`.
 *
 * Each line is a one-character state, the sha the *superproject* records, the
 * path, and — only when the submodule is checked out — what `git describe` says
 * about that commit:
 *
 *      c0ffee… libs/parser (v1.2.0-3-gc0ffee)
 *     -c0ffee… libs/parser
 *     +badbeef… libs/parser (heads/main)
 *     U0000000… libs/parser
 *
 * The leading character is the whole point of the command, so it is decoded
 * rather than shown raw: `-` means nothing is checked out (the directory is
 * empty), `+` means the checkout has drifted from the recorded sha, and `U`
 * means a merge left conflicts inside it.
 */

export type SubmoduleState = "current" | "uninitialized" | "modified" | "conflicted";

export interface Submodule {
  path: string;
  /** The sha the superproject points at. */
  hash: string;
  state: SubmoduleState;
  /** `git describe` output for the checked-out commit, when there is one. */
  describe?: string;
}

const LINE = /^([ +\-U])([0-9a-f]{7,40}) (.*?)(?: \(([^)]*)\))?$/;

const STATES: Record<string, SubmoduleState> = {
  " ": "current",
  "-": "uninitialized",
  "+": "modified",
  U: "conflicted",
};

export function parseSubmoduleStatus(stdout: string): Submodule[] {
  const submodules: Submodule[] = [];

  for (const raw of stdout.split("\n")) {
    // Only \r from a CRLF checkout is stripped; a path may not contain one.
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;

    const match = LINE.exec(line);
    if (!match) continue;

    const state = STATES[match[1] ?? " "];
    const path = match[3] ?? "";
    if (!state || !path) continue;

    submodules.push({
      path,
      hash: match[2] ?? "",
      state,
      ...(match[4] ? { describe: match[4] } : {}),
    });
  }

  return submodules;
}

/** One line of plain English for the state, for the panel to show. */
export function describeSubmoduleState(state: SubmoduleState): string {
  switch (state) {
    case "uninitialized":
      return "not checked out";
    case "modified":
      return "differs from the recorded commit";
    case "conflicted":
      return "has merge conflicts";
    default:
      return "up to date";
  }
}
