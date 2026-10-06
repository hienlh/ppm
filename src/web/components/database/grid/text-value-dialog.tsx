/**
 * DBGate's editors in a dialog — Edit cell value, and Edit JSON value for the JSON documents: a box
 * as wide as the dialog, OK (Ctrl+Enter, as DBGate's) and Close. What OK cannot take is said under
 * the box, and the dialog stays open on the text as typed. On a phone it is a bottom sheet.
 */
import { useId, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { inputClass } from "../connection-form/form-controls";
import { FilterDialogFrame } from "./filter-dialog-frame";

/** Format JSON and Minify JSON: the text spread out or squeezed, or — not JSON — null. */
export function reformatJson(text: string, spread: boolean): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, spread ? 2 : undefined);
  } catch {
    return null;
  }
}

export function TextValueDialog({ title, description, info, initial, label, jsonTools = false, onOk, onClose, returnFocus }: {
  title: string;
  /** Said under the title to screen readers. */
  description: string;
  /** Shown over the box, as DBGate's paste hint is. */
  info?: string;
  initial: string;
  /** The box's name. */
  label: string;
  /** DBGate's Format JSON and Minify JSON. */
  jsonTools?: boolean;
  /** Takes the text: null once it is in, or why it cannot be. */
  onOk: (text: string) => string | null;
  onClose: () => void;
  returnFocus?: () => void;
}) {
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  const ok = () => {
    const refused = onOk(text);
    if (refused) setError(refused);
    else onClose();
  };
  const reformat = (spread: boolean) => {
    const next = reformatJson(text, spread);
    if (next === null) setError("Not valid JSON");
    else {
      setText(next);
      setError(null);
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.nativeEvent.isComposing) return;
    e.preventDefault();
    // Not on to the grid, whose own Ctrl+Enter is Save.
    e.stopPropagation();
    ok();
  };

  return (
    <FilterDialogFrame title={title} description={description} onOk={ok} onClose={onClose} returnFocus={returnFocus} className="sm:max-w-[680px]">
      {info && <p className="text-[12.5px] text-text-2">{info}</p>}
      {jsonTools && (
        <div className="flex justify-end gap-1.5">
          <Button type="button" size="sm" variant="outline" onClick={() => reformat(true)} className="max-md:h-11">Format JSON</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => reformat(false)} className="max-md:h-11">Minify JSON</Button>
        </div>
      )}
      <textarea
        value={text} onChange={(e) => { setText(e.target.value); setError(null); }} onKeyDown={onKeyDown}
        aria-label={label} aria-invalid={error !== null || undefined} aria-describedby={error ? errorId : undefined}
        data-autofocus="" spellCheck={false} autoComplete="off" autoCapitalize="off"
        className={cn(inputClass, "h-auto min-h-[min(40vh,360px)] resize-y py-2 font-mono leading-normal md:h-auto md:text-xs")}
      />
      {error && <p id={errorId} role="alert" className="text-[12.5px] text-error">{error}</p>}
    </FilterDialogFrame>
  );
}
