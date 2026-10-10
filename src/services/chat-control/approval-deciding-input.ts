import type { ApprovalSummary } from "../../shared/assistant-approval.ts";
import { normalizeClaudeQuestions, type NormalizedQuestion } from "../../shared/approval-questions.ts";
import { escapeHiddenCharacters } from "../../shared/reveal-hidden-characters.ts";

/**
 * The part of an approval card a person has to see in full before "Allow" means anything: the
 * whole command, the whole content a write puts on disk, every replacement an edit makes, the
 * whole message or SQL an Assistant card sends. Every surface that shows a card away from the
 * chat that asked — a Telegram card, the Assistant's confirmation before it answers another
 * chat's card, the Assistant's overview — builds it here, so none of them can show one thing
 * and approve another.
 *
 * The text is verbatim. The only change is that characters which draw nothing or reorder what
 * does (a right-to-left override, a zero-width space) become visible `⟨U+XXXX⟩` markers; `<`,
 * `>`, backticks and `$(…)` stay exactly as they will run. Nothing is cut either: deciding
 * whether it fits is the showing surface's job, and when it does not fit, it must not offer
 * Allow. `complete` is false when even the full text here is not everything that will run —
 * a Codex patch arrives without its diff, a provider capped a field — and such a card is only
 * ever approved where the whole request is visible (PPM itself).
 */

export type DecidingKind = "command" | "web" | "write" | "edit" | "notebook" | "patch" | "tool" | "endpoint" | "question";

/** A labelled value that is part of the decision (the folder a command runs in, the file a write replaces). */
export interface DecidingFact {
  label: string;
  value: string;
}

export interface DecidingInput {
  kind: DecidingKind;
  /** What is being asked, in a few words: the tool, or an Assistant card's headline. */
  title: string;
  facts: DecidingFact[];
  /** The body to show in full; may be empty when the facts say everything. */
  text: string;
  lang?: "bash" | "diff" | "json" | "sql" | "text";
  /** False when this is not everything that will run, so no surface may offer Allow on it alone. */
  complete: boolean;
  /** Why `complete` is false, worded for the person looking at the card. */
  incompleteReason?: string;
}

/** The card as any caller holds it (a live chat's card, an event on the wire). */
export interface DecidingCard {
  tool: string;
  input: unknown;
  summary?: ApprovalSummary;
  questions?: NormalizedQuestion[];
}

type Input = Record<string, unknown>;

// What a provider leaves where it cut a value short (`codex-redact.ts`): the text is no longer all of it.
const CUT_MARKER = /… \[(?:truncated \d+ chars|\d+ more)\]/;
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const CAPPED_REASON = "The request was cut short before it reached PPM; open the chat in PPM to see all of it.";
const UNREADABLE_REASON = "Part of this request could not be read; open the chat in PPM to see all of it.";

const isRecord = (v: unknown): v is Input => !!v && typeof v === "object" && !Array.isArray(v);
const show = (s: string): string => escapeHiddenCharacters(s);

/** Every string inside a value, for the "was anything cut" check. */
function strings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (typeof value === "string") out.push(value);
  else if (depth < 10 && Array.isArray(value)) for (const v of value) strings(v, out, depth + 1);
  else if (depth < 10 && isRecord(value)) for (const v of Object.values(value)) strings(v, out, depth + 1);
  return out;
}

function finish(d: Omit<DecidingInput, "complete" | "facts"> & { facts?: DecidingFact[]; complete?: boolean }, raw: unknown): DecidingInput {
  const cut = strings(raw).some((s) => CUT_MARKER.test(s));
  const complete = (d.complete ?? true) && !cut;
  return {
    ...d,
    title: show(d.title),
    facts: (d.facts ?? []).map((f) => ({ label: f.label, value: show(f.value) })),
    text: show(d.text),
    complete,
    ...(complete ? {} : { incompleteReason: d.incompleteReason ?? (cut ? CAPPED_REASON : UNREADABLE_REASON) }),
  };
}

const fact = (label: string, value: unknown): DecidingFact[] =>
  typeof value === "string" && value !== "" ? [{ label, value }] : [];

/** Every line of `text` with a diff prefix, so an edit's old and new text cannot be confused. */
function prefixed(prefix: "-" | "+", text: string): string {
  return text.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function editHunks(edits: Array<{ old: unknown; next: unknown }>): { text: string; ok: boolean } {
  const parts: string[] = [];
  let ok = true;
  edits.forEach(({ old, next }, i) => {
    if (typeof old !== "string" || typeof next !== "string") { ok = false; return; }
    const head = edits.length > 1 ? `@@ edit ${i + 1} of ${edits.length} @@\n` : "";
    parts.push(`${head}${prefixed("-", old)}\n${prefixed("+", next)}`);
  });
  return { text: parts.join("\n"), ok };
}

function questionText(questions: readonly NormalizedQuestion[]): string {
  return questions.map((q, i) => {
    const lines = [`${questions.length > 1 ? `${i + 1}. ` : ""}${q.header ? `[${q.header}] ` : ""}${q.question}`];
    for (const o of q.options) lines.push(`  - ${o.label}${o.description ? ` — ${o.description}` : ""}`);
    if (q.allowsFreeText) lines.push(q.options.length ? "  - (or a typed answer)" : "  (a typed answer)");
    if (q.multiSelect) lines.push("  (several may be chosen)");
    return lines.join("\n");
  }).join("\n\n");
}

/** The deciding part of `card`. See the module comment. */
export function decidingInput(card: DecidingCard): DecidingInput {
  const { tool, input, summary } = card;

  if (summary) {
    const facts = summary.facts.map((f) => ({ label: f.label, value: f.value }));
    if (summary.warning) facts.push({ label: "Warning", value: summary.warning });
    return finish({
      kind: "endpoint",
      title: summary.headline,
      facts,
      text: summary.body?.text ?? "",
      lang: summary.body?.format === "sql" ? "sql" : "text",
      // The summary is the server's own; its fields are never capped on the way here.
      complete: true,
    }, null);
  }

  if (tool === "AskUserQuestion") {
    const questions = card.questions ?? normalizeClaudeQuestions(input);
    return finish({ kind: "question", title: questions.length > 1 ? `${questions.length} questions` : "Question", text: questionText(questions), lang: "text" }, questions);
  }

  const i: Input = isRecord(input) ? input : {};

  if (SHELL_TOOLS.has(tool)) {
    const command = Array.isArray(i.command) ? i.command.filter((c) => typeof c === "string").join(" ") : i.command;
    if (typeof command !== "string") {
      return finish({ kind: "command", title: tool, text: JSON.stringify(input ?? null, null, 2) ?? "", lang: "json", complete: false }, input);
    }
    return finish({
      kind: "command",
      title: tool,
      facts: [...fact("Folder", i.cwd), ...(i.run_in_background === true ? [{ label: "Runs", value: "in the background" }] : [])],
      text: command,
      lang: "bash",
    }, input);
  }

  if (tool === "WebFetch") {
    return finish({ kind: "web", title: tool, facts: fact("URL", i.url), text: typeof i.prompt === "string" ? i.prompt : "", lang: "text", complete: typeof i.url === "string" }, input);
  }
  if (tool === "WebSearch") {
    const domains = (key: string, label: string) => (Array.isArray(i[key]) ? fact(label, (i[key] as unknown[]).filter((d) => typeof d === "string").join(", ")) : []);
    return finish({
      kind: "web", title: tool,
      facts: [...domains("allowed_domains", "Only these sites"), ...domains("blocked_domains", "Never these sites")],
      text: typeof i.query === "string" ? i.query : "", lang: "text", complete: typeof i.query === "string",
    }, input);
  }

  if (tool === "Write") {
    return finish({ kind: "write", title: tool, facts: fact("File", i.file_path), text: typeof i.content === "string" ? i.content : "", lang: "text", complete: typeof i.file_path === "string" && typeof i.content === "string" }, input);
  }

  if ((tool === "Edit" || tool === "MultiEdit") && typeof i.file_path === "string") {
    const edits = tool === "MultiEdit"
      ? (Array.isArray(i.edits) ? i.edits : []).map((e) => ({ old: isRecord(e) ? e.old_string : undefined, next: isRecord(e) ? e.new_string : undefined }))
      : [{ old: i.old_string, next: i.new_string }];
    const all = tool === "Edit" ? i.replace_all === true : false;
    const hunks = editHunks(edits);
    return finish({
      kind: "edit", title: tool,
      facts: [...fact("File", i.file_path), ...(all ? [{ label: "Replaces", value: "every occurrence" }] : [])],
      text: hunks.text, lang: "diff", complete: hunks.ok && edits.length > 0,
    }, input);
  }

  if (tool === "Edit" || tool === "MultiEdit") {
    // Codex's patch approval: it names the files (or nothing) and a reason, never the diff.
    const files = Array.isArray(i.files) ? i.files.filter((f) => typeof f === "string") as string[] : [];
    return finish({
      kind: "patch", title: "Patch",
      facts: [...fact("Files", files.join(", ")), ...fact("Write access to", i.grantRoot), ...fact("Reason", i.reason)],
      text: "",
      complete: false,
      incompleteReason: "The patch's changes are not part of this request; open the chat in PPM to review them.",
    }, input);
  }

  if (tool === "NotebookEdit") {
    return finish({
      kind: "notebook", title: tool,
      facts: [...fact("Notebook", i.notebook_path), ...fact("Cell", i.cell_id), ...fact("Cell type", i.cell_type), ...fact("Change", i.edit_mode)],
      text: typeof i.new_source === "string" ? i.new_source : "", lang: "text",
      complete: typeof i.notebook_path === "string" && (i.edit_mode === "delete" || typeof i.new_source === "string"),
    }, input);
  }

  // An MCP tool (Codex's MCP approval carries `{ server, tool, arguments }`) or any other tool:
  // all of its input, since PPM cannot know which field matters.
  const json = typeof input === "string" ? input : JSON.stringify(input ?? null, null, 2) ?? "";
  return finish({ kind: "tool", title: tool, text: json, lang: typeof input === "string" ? "text" : "json" }, input);
}
