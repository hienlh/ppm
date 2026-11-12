/**
 * The version of a file the editor's gutter compares the buffer with: the file
 * as it stands in git's index, which is what VS Code's change bars compare with
 * too. Edits not yet staged get a bar; staging or committing them clears it.
 *
 * `GET /git/index-base?path=&known=<oid>` answers with one of these. `known` is
 * the blob id the browser already holds, and when the index still names that
 * blob the answer is `same`, with no content: the editor asks every few seconds
 * while it is on screen, so a `git add` typed in a terminal shows up, and that
 * must cost one `git ls-files` rather than the file's bytes each time.
 */
export type IndexBase =
  | { state: "ok"; oid: string; content: string }
  | { state: "same"; oid: string }
  | {
      state: "none";
      /**
       * Why there is nothing to compare with. `untracked`: not in the index
       * (new, ignored, or no such file). `conflict`: mid-merge, the index holds
       * stages 1-3 and no single version. `not-a-file`: a symlink or a
       * submodule, whose index entry is not the text the editor shows.
       * `binary` and `too-large` carry the blob id so the next ask can be `same`.
       */
      reason: "untracked" | "conflict" | "not-a-file" | "binary" | "too-large";
      oid?: string;
    };

/** A base larger than this is not compared: the diff runs in the browser on every edit. */
export const INDEX_BASE_MAX_BYTES = 5 * 1024 * 1024;
