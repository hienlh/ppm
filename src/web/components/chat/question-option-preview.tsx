import type { QuestionOption } from "./question-card";

/** Whether any option of a question carries a preview — the pane exists only then. */
export function hasOptionPreviews(options: QuestionOption[]): boolean {
  return options.some((option) => !!option.preview?.trim());
}

/**
 * Which option the preview pane describes: the focused one, as in Claude Code, which follows the
 * arrow keys and every tap. With "Other" focused there is no option under the cursor, so the pane
 * keeps showing what is selected rather than going blank while the user types.
 */
export function previewOptionIndex(options: QuestionOption[], focused: number, selected: string[]): number {
  if (focused >= 0 && focused < options.length) return focused;
  return options.findIndex((option) => selected.includes(option.label));
}

/**
 * The text Claude attached to an option. Monospace with whitespace kept, because previews are
 * mostly ASCII mockups, code and step lists whose layout is the content; lines still wrap, since
 * a phone has no room for a horizontal scroll through a plan written in sentences.
 * The cap is a third of a phone's screen because the chat list is only about half of it once the
 * composer and tab bar are drawn: a taller pane would fill the list, leaving no spot for a finger
 * to scroll the chat itself rather than the pane.
 */
export function QuestionOptionPreview({ option }: { option: QuestionOption | undefined }) {
  const text = option?.preview?.trim();
  return (
    <div className="flex min-w-0 flex-col rounded border border-border bg-background" data-testid="question-option-preview">
      <div className="truncate border-b border-border px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
        Preview{option ? ` · ${option.label}` : ""}
      </div>
      {text ? (
        <pre className="max-h-[35dvh] @2xl:max-h-[60vh] overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[11px] leading-relaxed text-text-primary select-text">
          {text}
        </pre>
      ) : (
        <div className="px-2.5 py-2 text-[11px] text-text-subtle">
          {option ? "No preview for this option." : "Choose an option to see its preview."}
        </div>
      )}
    </div>
  );
}
