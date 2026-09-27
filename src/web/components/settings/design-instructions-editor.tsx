import { useRef, useState } from "react";
import { Sparkles } from "@/lib/icons";
import { SlashCommandPicker, type SlashItem } from "@/components/chat/slash-command-picker";
import { replaceSlashQuery, slashQueryBefore } from "@/lib/slash-trigger";

interface DesignInstructionsEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Installed skills across the design-capable providers, for the `/` picker. */
  skills: SlashItem[];
  disabled?: boolean;
}

/**
 * The design-instructions text box, with the chat composer's `/` picker.
 *
 * A pick inserts exactly what the composer would (`/name`, or `$name` for a codex skill):
 * the text is resolved per provider when a design session starts, and both sigils are
 * understood there, so the user writes skills the way they already do in chat.
 */
export function DesignInstructionsEditor({ value, onChange, skills, disabled }: DesignInstructionsEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [filter, setFilter] = useState<string | null>(null);

  const syncPicker = (el: HTMLTextAreaElement) => {
    setFilter(slashQueryBefore(el.value.slice(0, el.selectionStart ?? el.value.length)));
  };

  const placeCaret = (text: string, caret: number) => {
    onChange(text);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = caret;
    });
  };

  const pick = (item: SlashItem) => {
    const el = ref.current;
    if (!el) return;
    const caret = el.selectionStart ?? value.length;
    const before = replaceSlashQuery(value.slice(0, caret), `${item.invokeSigil ?? "/"}${item.name}`);
    setFilter(null);
    placeCaret(before + value.slice(caret), before.length);
  };

  /** Touch alternative to typing `/`: starts a mention at the caret and opens the picker. */
  const startMention = () => {
    const el = ref.current;
    const caret = el?.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const trigger = before === "" || /\s$/.test(before) ? "/" : " /";
    setFilter("");
    placeCaret(before + trigger + value.slice(caret), caret + trigger.length);
  };

  return (
    <div className="overflow-hidden rounded-md border border-border bg-background focus-within:ring-1 focus-within:ring-primary">
      {/* Above the box, as in the composer: below it, a phone's keyboard would cover the list.
          Holding focus in the textarea on mousedown keeps its blur from closing the list
          before the pick lands; the picker listens for keys document-wide while open, so it
          must close once focus really leaves (Enter on Save would otherwise pick a skill). */}
      <div onMouseDown={(e) => e.preventDefault()}>
        <SlashCommandPicker
          items={skills}
          filter={filter ?? ""}
          visible={filter !== null && !disabled}
          onSelect={pick}
          onClose={() => setFilter(null)}
        />
      </div>
      <textarea
        ref={ref}
        aria-label="Design instructions"
        value={value}
        disabled={disabled}
        rows={8}
        placeholder={"e.g. Before designing, use /ui-ux-pro-max to pick a palette.\nPrefer generous whitespace and a single accent colour."}
        onChange={(e) => { onChange(e.target.value); syncPicker(e.target); }}
        onSelect={(e) => syncPicker(e.currentTarget)}
        onBlur={() => setFilter(null)}
        className="block min-h-40 w-full resize-y bg-transparent px-3 py-2 text-sm leading-relaxed text-foreground placeholder:text-text-subtle focus:outline-none"
      />
      <div className="flex items-center justify-between gap-2 border-t border-border px-2 py-1">
        <span className="text-xs text-text-subtle">
          {skills.length ? "Type / to name an installed skill." : "No installed skills found."}
        </span>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={startMention}
          disabled={disabled || !skills.length}
          className="flex min-h-11 items-center gap-1.5 rounded-md px-3 text-xs text-text-secondary hover:bg-surface-hover disabled:opacity-50 md:min-h-8">
          <Sparkles className="size-3.5" /> Insert skill
        </button>
      </div>
    </div>
  );
}
