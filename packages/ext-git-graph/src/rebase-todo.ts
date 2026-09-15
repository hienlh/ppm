/**
 * Todo-list generation for interactive rebase.
 *
 * `git rebase -i` opens its todo list in `$GIT_SEQUENCE_EDITOR`. Git invokes it
 * as `sh -c "$GIT_SEQUENCE_EDITOR \"$@\"" <editor> <todo-path>`, so the editor
 * string is pasted into a shell command while the todo path arrives as `$@`.
 * Passing the replacement todo through an *environment variable* keeps it out of
 * that command string entirely — no quoting to get wrong, no temp file to write
 * or clean up, and a path containing spaces still works:
 *
 *     GIT_SEQUENCE_EDITOR='printf "%s" "$PPM_REBASE_TODO" >'
 *     PPM_REBASE_TODO='pick abc1234 …'
 *
 * `reword` uses the same trick a second time. Git's own `reword` would open
 * `$GIT_EDITOR` mid-rebase and block, which the extension API cannot answer, so
 * the message is collected up front and applied by an `exec` line that reads it
 * from the environment:
 *
 *     pick abc1234 old subject
 *     exec git commit --amend --allow-empty -m "$PPM_REWORD_0"
 *
 * `edit` needs none of that. It only *stops* the rebase — git does not open an
 * editor for it — and the panel already offers Continue/Skip/Abort for a rebase
 * that is paused.
 */

export const REBASE_ACTIONS = ["pick", "reword", "edit", "squash", "fixup", "drop"] as const;
export type RebaseAction = (typeof REBASE_ACTIONS)[number];

export const TODO_ENV_VAR = "PPM_REBASE_TODO";
export const SEQUENCE_EDITOR = `printf "%s" "$${TODO_ENV_VAR}" >`;
/** Each reworded commit gets `${REWORD_ENV_PREFIX}<n>` holding its new message. */
export const REWORD_ENV_PREFIX = "PPM_REWORD_";

export interface RebaseTodoEntry {
  hash: string;
  action: RebaseAction;
  /** Only used to comment the line, so a human reading `git status` can follow. */
  subject?: string;
  /** The replacement commit message. Required when `action` is "reword". */
  message?: string;
}

export interface RebasePlan {
  /** The todo body, for `TODO_ENV_VAR`. */
  todo: string;
  /** Reword messages, keyed by their environment variable name. */
  env: Record<string, string>;
}

export function isRebaseAction(value: unknown): value is RebaseAction {
  return typeof value === "string" && (REBASE_ACTIONS as readonly string[]).includes(value);
}

/**
 * Build the todo body from entries in **oldest-first** order — the order git
 * itself uses. The panel lists commits newest-first, so it reverses before
 * calling this.
 */
export function buildRebaseTodo(entries: RebaseTodoEntry[]): RebasePlan {
  const kept = entries.filter((e) => e.action !== "drop");
  const oldest = kept[0];
  if (!oldest) {
    throw new Error("Dropping every commit would leave nothing to rebase.");
  }
  if (oldest.action === "squash" || oldest.action === "fixup") {
    throw new Error(
      `The oldest kept commit cannot be "${oldest.action}" — there is no earlier commit to fold it into.`,
    );
  }

  const lines: string[] = [];
  const env: Record<string, string> = {};
  let rewordCount = 0;

  for (const entry of entries) {
    if (!/^[0-9a-f]{4,40}$/i.test(entry.hash)) {
      throw new Error(`Invalid commit hash in rebase plan: "${entry.hash}"`);
    }
    if (!isRebaseAction(entry.action)) {
      throw new Error(`Invalid rebase action: "${String(entry.action)}"`);
    }
    // A dropped commit is simply omitted rather than written as `drop`: both are
    // valid to git, and omission keeps the todo readable if a conflict stops the
    // rebase and the user inspects it.
    if (entry.action === "drop") continue;

    // Subjects are collapsed to one line — a newline here would inject an extra
    // todo command.
    const subject = (entry.subject ?? "").replace(/[\r\n]+/g, " ").trim();

    if (entry.action === "reword") {
      const message = (entry.message ?? "").trim();
      if (!message) {
        throw new Error(`Reword needs a new message for commit ${entry.hash.slice(0, 7)}.`);
      }
      const variable = `${REWORD_ENV_PREFIX}${rewordCount++}`;
      env[variable] = message;
      lines.push(`pick ${entry.hash}${subject ? ` ${subject}` : ""}`);
      // `--allow-empty` because a commit that was already empty survives the
      // rebase, and amending it without the flag would abort the whole run.
      lines.push(`exec git commit --amend --allow-empty -m "$${variable}"`);
      continue;
    }

    lines.push(`${entry.action} ${entry.hash}${subject ? ` ${subject}` : ""}`);
  }

  // Trailing newline: git's todo parser expects the final command to be
  // terminated like any other line.
  return { todo: `${lines.join("\n")}\n`, env };
}

/** Does this plan actually change anything, or is it the identity rebase? */
export function isNoopPlan(entries: RebaseTodoEntry[], originalOrder: string[]): boolean {
  if (entries.some((e) => e.action !== "pick")) return false;
  if (entries.length !== originalOrder.length) return false;
  return entries.every((e, i) => e.hash === originalOrder[i]);
}
