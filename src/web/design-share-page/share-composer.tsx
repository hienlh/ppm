import { useState, type FormEvent } from "react";
import { Loader2, X } from "@/lib/icons";
import type { PickedElement } from "../../shared/design-bridge-messages-picker";
import { COMMENT_LIMITS } from "../../shared/design-comment-types";
import { ShareNameField } from "./share-name-prompt";
import { buttonPrimary, buttonQuiet, cx, fieldClass } from "./share-ui";

/**
 * Writing: one form for a new comment, a reply and an edit. While the reviewer has no name
 * yet the form asks for it too, and the name is checked before anything is sent.
 */

export interface NameControl {
  name: string | null;
  setName: (raw: string) => { ok: true; name: string } | { ok: false; error: string };
}

export function ShareTextForm({ names, submitLabel, placeholder, initial = "", onSubmit, onCancel, autoFocus, compact }: {
  /** Absent for an edit, which keeps the name the entry was written with. */
  names?: NameControl;
  submitLabel: string;
  placeholder: string;
  initial?: string;
  /** Resolves true when it went through, which clears the form. */
  onSubmit: (body: string, name: string) => Promise<boolean>;
  onCancel?: () => void;
  autoFocus?: boolean;
  compact?: boolean;
}) {
  const [body, setBody] = useState(initial);
  const [nameDraft, setNameDraft] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trimmed = body.trim();
  const tooLong = [...body].length > COMMENT_LIMITS.body;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !trimmed || tooLong) return;
    let name = names?.name ?? "";
    if (names && !name) {
      const saved = names.setName(nameDraft);
      if (!saved.ok) { setNameError(saved.error); return; }
      name = saved.name;
    }
    setBusy(true);
    const ok = await onSubmit(trimmed, name);
    setBusy(false);
    if (ok) setBody("");
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      {names && !names.name && (
        <ShareNameField value={nameDraft} onChange={(v) => { setNameDraft(v); setNameError(null); }} error={nameError} />
      )}
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus={autoFocus}
        rows={compact ? 2 : 3}
        className={cx(fieldClass, "resize-y leading-relaxed")}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(e);
        }}
      />
      {tooLong && <p className="text-xs text-error">At most {COMMENT_LIMITS.body} characters.</p>}
      <div className="flex justify-end gap-2">
        {onCancel && <button type="button" className={buttonQuiet} onClick={onCancel}>Cancel</button>}
        <button type="submit" className={buttonPrimary} disabled={busy || !trimmed || tooLong}>
          {busy && <Loader2 className="size-4 animate-spin" />} {submitLabel}
        </button>
      </div>
    </form>
  );
}

/** A new comment on the element the reviewer picked: its tag and text, never its markup. */
export function ShareComposer({ element, names, onSubmit, onCancel }: {
  element: PickedElement;
  names: NameControl;
  onSubmit: (body: string, name: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">New comment</h2>
          <p className="mt-0.5 truncate text-xs text-text-3">
            <span className="font-mono">&lt;{element.tag}&gt;</span>{element.text ? ` ${element.text}` : ""}
          </p>
        </div>
        <button type="button" className={buttonQuiet} onClick={onCancel} aria-label="Cancel comment">
          <X className="size-5" />
        </button>
      </div>
      <ShareTextForm names={names} submitLabel="Comment" placeholder="What should change here?" autoFocus
        onSubmit={onSubmit} />
    </div>
  );
}
