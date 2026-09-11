/**
 * Translation between LSP's shapes and Monaco's.
 *
 * The two were designed from the same model, so most of this is mechanical.
 * The parts that are not are exactly the parts worth isolating here:
 *
 * - **Positions are numbered differently.** LSP counts lines and characters
 *   from zero; Monaco counts both from one. An off-by-one does not throw and
 *   does not look broken — it quietly asks the server about the token next to
 *   the cursor, so completions and hovers are confidently about the wrong
 *   thing. This is the single most likely bug in the whole bridge.
 * - **The kind enums share names and not numbers.** LSP's `CompletionItemKind`
 *   starts `Text = 1, Method = 2`; Monaco's starts `Method = 0, Function = 1`.
 *   Passing one through as the other yields plausible-but-wrong icons on every
 *   suggestion, so the tables below map by *name* and let Monaco supply its own
 *   numbers.
 *
 * The tables are plain data so they can be checked without a Monaco instance;
 * only the functions that need Monaco's enums take it as an argument.
 */
import type * as MonacoType from "monaco-editor";

// ── Geometry ───────────────────────────────────────────────────────────────

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** Monaco position (1-based) to LSP position (0-based). */
export function toLspPosition(position: MonacoType.IPosition): LspPosition {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

/** LSP position (0-based) to the Monaco pair. */
export function fromLspPosition(position: LspPosition): { lineNumber: number; column: number } {
  return { lineNumber: position.line + 1, column: position.character + 1 };
}

export function toLspRange(range: MonacoType.IRange): LspRange {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  };
}

export function fromLspRange(range: LspRange): MonacoType.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

// ── Kind tables, mapped by name ────────────────────────────────────────────

/** LSP CompletionItemKind number to the name of Monaco's member. */
export const COMPLETION_KIND_NAMES: Record<number, keyof typeof MonacoType.languages.CompletionItemKind> = {
  1: "Text", 2: "Method", 3: "Function", 4: "Constructor", 5: "Field",
  6: "Variable", 7: "Class", 8: "Interface", 9: "Module", 10: "Property",
  11: "Unit", 12: "Value", 13: "Enum", 14: "Keyword", 15: "Snippet",
  16: "Color", 17: "File", 18: "Reference", 19: "Folder", 20: "EnumMember",
  21: "Constant", 22: "Struct", 23: "Event", 24: "Operator", 25: "TypeParameter",
};

/**
 * LSP SymbolKind number to the name of Monaco's member.
 *
 * Written out rather than computed as `kind - 1`. The offset happens to hold
 * for every current value, but it is a coincidence of two independent enums,
 * and a table that is wrong is easier to see than arithmetic that is.
 */
export const SYMBOL_KIND_NAMES: Record<number, keyof typeof MonacoType.languages.SymbolKind> = {
  1: "File", 2: "Module", 3: "Namespace", 4: "Package", 5: "Class",
  6: "Method", 7: "Property", 8: "Field", 9: "Constructor", 10: "Enum",
  11: "Interface", 12: "Function", 13: "Variable", 14: "Constant", 15: "String",
  16: "Number", 17: "Boolean", 18: "Array", 19: "Object", 20: "Key",
  21: "Null", 22: "EnumMember", 23: "Struct", 24: "Event", 25: "Operator",
  26: "TypeParameter",
};

/** LSP DiagnosticSeverity to the name of Monaco's MarkerSeverity member. */
export const SEVERITY_NAMES: Record<number, keyof typeof MonacoType.MarkerSeverity> = {
  1: "Error", 2: "Warning", 3: "Info", 4: "Hint",
};

/** LSP DocumentHighlightKind to Monaco's member name. */
export const HIGHLIGHT_KIND_NAMES: Record<number, keyof typeof MonacoType.languages.DocumentHighlightKind> = {
  1: "Text", 2: "Read", 3: "Write",
};

export function completionKind(
  monaco: typeof MonacoType,
  kind: number | undefined,
): MonacoType.languages.CompletionItemKind {
  const name = COMPLETION_KIND_NAMES[kind ?? 0];
  // An unknown kind becomes Text, which is what an editor shows for "something
  // I have no icon for" — never a wrong icon.
  return monaco.languages.CompletionItemKind[name ?? "Text"];
}

export function symbolKind(monaco: typeof MonacoType, kind: number | undefined): MonacoType.languages.SymbolKind {
  const name = SYMBOL_KIND_NAMES[kind ?? 0];
  return monaco.languages.SymbolKind[name ?? "Variable"];
}

export function markerSeverity(monaco: typeof MonacoType, severity: number | undefined): MonacoType.MarkerSeverity {
  // LSP says an absent severity is up to the client; treating it as an error
  // would put a red squiggle on something the server was unsure about, so it
  // becomes a warning.
  const name = SEVERITY_NAMES[severity ?? 0];
  return monaco.MarkerSeverity[name ?? "Warning"];
}

export function highlightKind(
  monaco: typeof MonacoType,
  kind: number | undefined,
): MonacoType.languages.DocumentHighlightKind {
  const name = HIGHLIGHT_KIND_NAMES[kind ?? 0];
  return monaco.languages.DocumentHighlightKind[name ?? "Text"];
}

// ── Documentation ─────────────────────────────────────────────────────────

export type LspMarkup = string | { kind?: string; value: string } | { language: string; value: string };

/**
 * Whatever a server sent as documentation, as a Monaco markdown string.
 *
 * Servers use all three historical shapes: a bare string, a `MarkupContent`,
 * and the deprecated `MarkedString` with a language for a fenced block. A
 * plain string is *not* passed through as markdown — underscores and asterisks
 * in an identifier would render as emphasis and the text would silently lose
 * characters.
 */
export function toMarkdown(content: LspMarkup | LspMarkup[] | null | undefined): MonacoType.IMarkdownString | undefined {
  if (content == null) return undefined;

  if (Array.isArray(content)) {
    const parts = content.map(toMarkdown).filter((p): p is MonacoType.IMarkdownString => Boolean(p?.value));
    if (parts.length === 0) return undefined;
    return { value: parts.map((p) => p.value).join("\n\n---\n\n"), isTrusted: false };
  }

  if (typeof content === "string") {
    return { value: escapeMarkdown(content), isTrusted: false };
  }

  if ("language" in content) {
    return { value: fence(content.language, content.value), isTrusted: false };
  }

  const value = content.kind === "markdown" ? content.value : escapeMarkdown(content.value);
  return { value, isTrusted: false };
}

function fence(language: string, code: string): string {
  return ["```" + language, code, "```"].join("\n");
}

/** Neutralise the characters that would otherwise render as formatting. */
function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+\-.!|>~])/g, "\\$1");
}

// ── Edits ─────────────────────────────────────────────────────────────────

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

/** A single LSP edit as a Monaco model edit. */
export function toModelEdit(edit: LspTextEdit): MonacoType.editor.ISingleEditOperation {
  return { range: fromLspRange(edit.range), text: edit.newText };
}

/**
 * Order edits so applying them in sequence is safe.
 *
 * A server returns edits against the *original* document, in no particular
 * order. Applying an earlier one first shifts the offsets of every edit after
 * it, so a formatting result or an organise-imports action lands scrambled.
 * Applying from the bottom up leaves earlier positions untouched.
 */
export function sortEditsBottomUp(edits: LspTextEdit[]): LspTextEdit[] {
  return [...edits].sort((a, b) =>
    b.range.start.line - a.range.start.line ||
    b.range.start.character - a.range.start.character,
  );
}
