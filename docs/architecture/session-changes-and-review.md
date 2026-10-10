# Session changes and review

> Part of [AI Chat & Providers](ai-chat-and-providers.md#session-changes-and-review).

The bar above the composer (`src/web/components/chat/session-changes-bar.tsx`) lists every
file one chat session has changed, across all its turns, and its Review button opens a
`session-review` tab (`src/web/components/session-review/session-review-tab.tsx`) that goes
through those changes block by block, the way Cursor and Zed review an agent's edits: each
block of each file, compared with the state the file was in **before the session first wrote
it**, is kept or reverted on disk where it sits. The pill under each answer
(`turn-change-rollup.tsx`) still covers that turn only, and answers it from the same list
(see "From the chat" below).

**The "before" is PPM's own copy**, because nothing else holds it. Claude Code's transcript
drops a tool's `toolUseResult.originalFile` above ~10 KB (measured: kept at 9,836 B, gone from
13.6 KB), an Edit's `old_string` is a fragment at an unknown offset, SDK file checkpointing is
off, and git HEAD also holds whatever was uncommitted before the session began.
`src/services/session-file-baselines/session-file-baselines.service.ts` keeps one record per
file at `<ppm dir>/session-baselines/<session id>/<sha256 of the path>.json`. A record is
written to a temp file and hard-linked into place, so the **first capture wins** — a later one
fails with `EEXIST` and can never replace the real "before" with a state the session itself
produced. Files over 5 MB and binary files are recorded without content; credential paths
(`isCredentialPath`) are never copied. Records go with the session (`DELETE /chat/sessions`)
and are pruned after 30 days without a capture or a write recorded in their history
(`pruneSessionBaselines`, at start and daily).

How each provider takes it:

- **Claude** — a PreToolUse hook for `Write|Edit|MultiEdit|NotebookEdit`
  (`buildToolHooks` / `fileWriteTarget` in `claude-agent-sdk-query-options.ts`) awaits
  `captureBaseline` before the CLI runs the tool, and returns `{}` so it makes no permission
  decision. It runs in **every** permission mode, and on warm spares through
  `SpareHandlers.fileWrite`: in bypass mode as a hook of its own, elsewhere from the permission
  hook once that has allowed the write, so a denied write records nothing and an edit made
  while the prompt was open is not put on the session. Verified against the real CLI in bypass
  mode: the main agent's Edit and a sub-agent's Write both left a record.
- **Claude, shell commands** — a `Bash`/`PowerShell` call names no file, so
  `shell-change-tracker.ts` brackets it with `git status --porcelain=v2 -z --untracked-files=all`
  (with `GIT_OPTIONAL_LOCKS=0`, ~6 ms on this repository) in every repository the command can
  reach: the hook's `cwd`, which follows a `cd` (measured with the real CLI), the paths it
  names (`cd`/`pushd`/`-C` targets and path-like words), and the last four the session worked
  in. A PreToolUse hook takes the snapshot and reads every listed file, recorded or not, since
  the command's own two states go in the file's history (32 MB budget per command); PostToolUse
  and PostToolUseFailure take a second one.
  A file listed before whose stat moved keeps the bytes read before; a file listed only after
  was clean, i.e. HEAD, so its record is the blob from the *pre-command* HEAD through
  `cat-file --filters` (the checked-out form — under `core.autocrlf` a raw blob would diff every
  line). A HEAD move of up to 200 files is followed too, which is what finds an edit committed
  in the same command; a larger one (a branch switch, a pull) came from commits and is not. An
  index-only move (`reset --soft`) records nothing, because the post-status names the blob on
  disk. Outside bypass mode the permission hook runs the shell hook itself once it has allowed
  the command, so an edit made while the prompt was open is not put on it (checked with the
  real CLI in default mode); a file another session's file tool wrote during the command is
  skipped (`noteFileToolWrite`). A repository whose status times out (5 s) or lists over 20,000
  files is skipped for 10 minutes, and a home directory kept in git is never bracketed.
- **Codex** — the patch is applied before PPM is notified, so `codex-file-baselines.ts` runs at
  `item/completed` and works the "before" out: an added file did not exist, a deleted file's
  content is in the change, and an update is the unified diff reverse-applied to the file on
  disk (`reverse-unified-diff.ts`, which refuses a hunk that does not match rather than guess).
  The session id is `live.threadId`; the routes resolve migrated ids.

The routes are `POST /chat/sessions/:id/file-changes` (`{ paths? }` → every changed file with
status, line counts, a `version` = size:mtime of the file on disk, its blocks by key with the
kept ones flagged, and `base`, a hash of the text the blocks were cut against) and
`GET /chat/sessions/:id/file-changes/diff?path=` (the same plus both sides), in
`src/server/routes/chat-file-changes.ts` over `session-file-changes.service.ts`. A file with
no record falls back to git HEAD only if it is **inside the project**, named in `paths` and a
regular file at HEAD (a symbolic link's blob is only the name it points to) — which is how a
session from before baselines still gets a review — and every read goes
through the generic file routes' `assertReadPermitted`. Edited versions and forks read their
parents' records too (`getBranchRow` chain), since files are not rewound when one is made.
Files whose two sides are equal are left out. Shapes are in `src/shared/session-file-changes.ts`.
Every route of the file first answers 404 for a session that is not the project's: the
project PPM recorded for it decides (a provider records it when the session starts, the Claude
capture hooks when PPM first keeps a write of a session started elsewhere), and one with no
record passes only while PPM keeps none of its writes.

In the browser, `use-session-file-changes.ts` asks again (400 ms debounce) when the
transcript names a new file, when a file write or a shell command finishes
(`sessionFileWrites` counts those tool calls whose result has arrived — an announced write
has not touched the disk yet, and a shell command's files are known only to the server), and
when a turn starts or ends; not on every streamed token. Each answer is broadcast as
`SESSION_CHANGES_EVENT` so an open Review tab follows along; the tab also fetches on its own
with the paths stored in its metadata, because after a reload its chat may never have
mounted. A diff on screen is refetched on `changeKey` (path, status, baseline kind, version
and review state), since one edit undoing another changes the content without changing the
counts.
Codex patches over several files are one Edit/Write card with `input.files` listing them all
(`changeToToolUse`), which both the turn chip and the session list read.

**Marking files reviewed** hides them from the bar, its totals and the Review tab until the
agent changes them again (Cursor's Keep). A row's checkbox and the bar's "Mark all reviewed"
call `POST /chat/sessions/:id/file-changes/reviewed` (`{ files: { path, version }[], reviewed }`);
the Review tab marks a file through its answers instead (below). A mark is a snapshot of the
file as it was marked, under `<session dir>/reviewed/` (`session-review-marks.ts`): content for
text, a SHA-256 for anything under the 5 MB cap, the version otherwise. The listing still
returns a marked file, flagged `reviewed` while its bytes are unchanged (a rewrite with the
same content stays reviewed) and `sinceReview` once they move; a `sinceReview` file's counts
and blocks are against the marked state, so only what is new is left to answer, while its
status letter stays the session's. Two rules keep a mark honest. It is written only for a file
that is still one of the session's changes **and still at the `version` the browser showed**,
so a file the agent moved on while it was being read is left unhidden and named in `stale`;
and the snapshot comes from that same guarded read, so a path the read guard refuses is never
copied. Unmarking writes a `cleared` record rather than deleting one, because marks are read
along the session's lineage like its "before"s and a deleted record would let a parent's mark
show through. Both lists update at once and ask the server again once the marks are saved,
fetching nothing meanwhile (a list answered before the marks landed would bring the rows
back); a mark saved from the tab is announced as `SESSION_REVIEW_MARKS_EVENT` for the bar.
With every file reviewed the bar shrinks to "All N files reviewed".

**Blocks.** `src/shared/review-blocks.ts` cuts a file into blocks: the hunks of a line diff
(jsdiff `diffLines`, 200 ms timeout) with three lines of context, changes at most six
unchanged lines apart merged into one block. It is shared because both halves must cut exactly the same
blocks — the browser names the block the user answered by its key, and the server cuts the
blocks again from the disk before it does anything. A key is the block's place in the *base*
plus a hash of its lines, so an edit elsewhere in the file leaves it alone, while the agent
touching the block again gives it a new key, which is what reopens a kept block. Lines keep
their terminators while blocks are cut and pasted, so a revert puts back the base's exact
bytes, CRLF and a missing final newline included. A diff that times out (a large file
rewritten wholesale), a binary file and one over the size cap have no blocks: the tab answers
them whole.

**Answers.** `POST /chat/sessions/:id/file-changes/answer`
(`{ answer: "keep" | "open" | "revert", files: [{ path, version, keys? }] }`, no `keys` = every
block) is `session-review-actions.ts`. A file not at the `version` the browser drew it at is
left alone and answered `stale`, so nothing is ever kept or reverted on lines nobody saw. Keep
and open write the session's kept-block record, `<session dir>/reviewed/<sha256 of the
path>.blocks.json` (`session-review-blocks.ts`), which carries the base's hash and is ignored
once the base moves; a file left with every block kept is marked reviewed, exactly as the
bar's checkbox does, so a later agent edit comes back as `sinceReview` with only its new blocks
open. A revert writes the base's lines back on disk — the "before", or the marked state for a
`sinceReview` file — and needs no record, because a reverted block is no longer a change; a
file that is not plain UTF-8 or is over 64 MB is refused, and so is a symbolic link, never
written through nor taken away (Undo keeps bytes, not links). Each answer is journalled under
`<session dir>/undo/` (dropped after 24 h) with the session's records for every file it touched
and, for a revert, the file's bytes before and after — written before the first file is, so a
revert with no journal writes nothing, and a file it cannot write is answered with why while
the others still go. `POST …/file-changes/undo { undoId }`
puts a revert's change back even after other blocks of the file were answered, wherever its
lines are still as the revert left them (`reapply`, a three-way placement through `lineMap`),
and the records only while nothing has answered the file since. One file it cannot put back
makes the whole undo `stale`, and one it cannot write takes back the files written before it
and keeps the journal, so the same Undo can be asked again.

**The tab.** `use-session-review.ts` holds the state and `session-review-model.ts` the pure
half (blocks per file, what each was answered, where focus goes next). Answers show at once
and go to the server one at a time: a revert moves a file's version, so a second answer on the
same file drawn before the first landed is sent with the version the first one left, never
with one the agent made. A list asked for before the last answer landed is dropped, since it
would bring answered blocks back. A reverted block drops out of the server's list, so the tab
keeps it to show in place (and `gone` for a file with nothing left) until the agent writes
over its lines. The rows are cut from the diff on screen while the kept flags come from the
list: a keep or reopen does not move `changeKey`, so the diff is not fetched again for it, and
the last four cuts are cached so an answer does not re-diff the file. Lines are coloured by
the app's shiki adapter like the chat's code blocks, the changed part of a line marked over
the tokens (`review-tokens.tsx`). The desktop layout (`review-desktop.tsx`) is a file rail
beside the blocks with J/K/Y/N keys, Undo in a toast, Revert file… behind a confirmation and
Keep all remaining; the rail folds behind an "N files" button below 760px of the tab's own
width (a container query, since a split is not a phone). Below `md` (`review-phone.tsx`) the
blocks carry no buttons: a 44px bottom bar answers the block in focus, and the file list and
file actions are bottom sheets.

**Which turn wrote what.** Every call that writes a file reports the file as it was just before
the call and just after it: the Claude file-write hook on PreToolUse and PostToolUse (the hook
that takes the "before"), the shell hooks for each file a command moved, and
`codex-file-baselines.ts` for a patch. `session-file-history.ts` appends those states to
`<session dir>/history/<sha256 of the path>.jsonl`, each stored as a line delta from the state
before it (a state that is not text keeps only a hash), so a file edited two hundred times costs
two hundred small deltas rather than two hundred copies. `session-file-blame.ts` replays that
log from the base the blocks were cut against, the way `git blame` walks commits, and the
listing gives each block the `calls` that put its lines in or took them out. A change between
one call's "after" and the next call's "before" — the user's own edit, a formatter on save —
names no call. Replays are cached per file and base, so asking again costs only what the log
gained since. The browser turns calls into turns (`src/web/lib/session-turns.ts`): a turn is a
user message with the tool calls that answered it, sub-agent steps included, numbered from the
last compaction ("Earlier turn" before it). The chat publishes its turns to
`session-turns-store.ts` as it renders them; a Review tab with no chat open reads the transcript
itself (`use-session-turns.ts`), and not again for a call it could not place. A block's chip
opens the turn's prompt, and Show in chat goes through `chat-jump-store.ts` to the chat tab,
which scrolls to the call's tool card and flashes it.

**From the chat.** The pill under each answer reads the session's list through
`SessionChangesContext` (provided by `chat-tab.tsx`, so the bar, the pill and an open tab never
disagree) and says how the turn's edits stand (`src/web/lib/turn-review.ts`): an edit is open
while any block its call wrote is open, kept once all are, and reverted once no block holds it
any more. Where the list names no calls — a session from before the history, a binary file —
the edit is unknown and the pill says nothing, rather than calling it reverted. The tray
(`turn-change-tray.tsx`, a bottom sheet on a phone in `turn-change-sheet.tsx`, both over
`turn-change-review.tsx` and `use-turn-review.ts`) keeps or reverts an edit's blocks through
the same `/file-changes/answer`, at the version on screen, keeps every open block of the turn at
once, and reverts the turn with `POST …/file-changes/revert-turn { calls, apply? }`
(`session-turn-revert.ts`). Without `apply` it is a preview and writes nothing: each file's part
of the turn is cut into runs of the turn's calls with no other change between them, each run
into hunks with no context, and a hunk goes back only where its lines are all still there,
together. One a later change wrote over stays, named with the calls that did, which the
confirmation turns into "Turn 3 changed it again". `apply` names every previewed file at the
version it was previewed at and works everything out again; one file that moved makes the whole
revert `stale`, and the browser shows the newer preview instead. One that changes while the
others are being written — a later turn still running — is left as it is and answered with
why. A revert is journalled like a revert answer, before any file is written, so the same Undo
puts it back. Answering one edit is per block: a block that
holds two calls' lines goes back whole.

Not covered, and said in the list (`shellChangesHint`, which knows the provider): files a
shell command changed that git ignores or that sit outside any repository, anything a
background command writes after its call returns, and every Codex shell command — Codex
reports a command only once it is running, so a snapshot taken then would race it. Source
Control shows everything on disk.

Verify with `bun tests/e2e/session-changes-e2e.mjs` (set `PPM_PLAYWRIGHT_MODULE`): a scripted
provider writes real files over four turns on an isolated `PPM_HOME`, and the test checks the
bar, the inline list and the phone sheet, the changes against the pre-session state (an
uncommitted hand edit included), review marks set and undone from the bar, and the Review tab
on a desktop and a phone: keep and revert by key and by button with the disk and the server
checked after each, Undo and Change, Keep file, Revert file… restoring a deleted file and
undoing it, a kept file changed again coming back with only its new block, the rail folding
in a narrow window, Keep all remaining, and every answer surviving a reload; each block's turn
chips, a turn's prompt and Show in chat; an opened fold's lines measured to share a block's
columns, line numbers and code alike; and the chat's pill and tray on a desktop and a phone —
an edit kept, another reverted and undone, Keep all, and Revert turn previewed (a created file
removed, a line a later turn changed again left alone), applied and undone, a shell command's
files included. The fixture records each call's states the way the hooks do.
`PPM_CHANGES_ONLY=desktop-tray,mobile-tray` runs only the named scenarios.
