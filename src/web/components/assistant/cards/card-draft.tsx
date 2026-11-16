/**
 * A manager's draft, shown whole and verbatim, hidden characters made visible: "OK, send" approves
 * exactly this text, so nothing in it is cut, folded or rendered as markup.
 */
import { Send } from "@/lib/icons";
import { escapeHiddenCharacters } from "../../../../shared/reveal-hidden-characters";
import type { CardDraft as Draft } from "../../../../shared/assistant-cards";

export function CardDraft({ draft }: { draft: Draft }) {
  return (
    <figure className="m-0 overflow-hidden rounded-lg border border-border bg-panel-2" data-card-draft="">
      <figcaption className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-[11px] text-text-subtle">
        <Send className="size-3 shrink-0" />
        <span className="shrink-0 font-medium uppercase tracking-wide">Draft</span>
        <span className="min-w-0 truncate">to {escapeHiddenCharacters(draft.to)}</span>
      </figcaption>
      <p className="whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-text-primary">{escapeHiddenCharacters(draft.text)}</p>
    </figure>
  );
}
