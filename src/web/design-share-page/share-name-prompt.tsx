import { useId, useState, type FormEvent } from "react";
import { COMMENT_LIMITS } from "../../shared/design-comment-types";
import { buttonPrimary, buttonQuiet, fieldClass } from "./share-ui";

/**
 * The reviewer's name: asked inside the first form that writes anything (so a comment is
 * one step, not two), and changeable later. 1 to 40 characters; "Owner" is refused by the
 * same rule the server applies, because the owner's entries carry a badge, not a name.
 */

export function ShareNameField({ value, onChange, error }: {
  value: string;
  onChange: (v: string) => void;
  error: string | null;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-text-2">Your name</label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={COMMENT_LIMITS.guestName * 2}
        autoComplete="name"
        placeholder="Shown next to your comments"
        className={fieldClass}
        aria-invalid={error ? true : undefined}
      />
      {error && <p className="text-xs text-error" role="alert">{error}</p>}
    </div>
  );
}

/** The change-name form. */
export function ShareNamePrompt({ current, onSave, onDone }: {
  current: string | null;
  onSave: (raw: string) => { ok: true } | { ok: false; error: string };
  onDone: () => void;
}) {
  const [value, setValue] = useState(current ?? "");
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const saved = onSave(value);
    if (!saved.ok) { setError(saved.error); return; }
    onDone();
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 p-4">
      <p className="text-sm text-text-2">Your name is shown next to what you write on this link. Comments you already wrote keep the name they were written with.</p>
      <ShareNameField value={value} onChange={(v) => { setValue(v); setError(null); }} error={error} />
      <div className="flex justify-end gap-2">
        <button type="button" className={buttonQuiet} onClick={onDone}>Cancel</button>
        <button type="submit" className={buttonPrimary}>Save name</button>
      </div>
    </form>
  );
}
