import { useCallback, useState } from "react";
import {
  DEFAULT_SHARE_EXPIRY, expiryFromChoice, toDateInputValue, type ShareExpiryChoice,
} from "@/lib/design/design-share-expiry";
import { SHARE_LIMITS, type DesignShareLink } from "../../../../shared/design-share-types";
import { ShareExpiryPicker } from "./share-expiry-picker";
import { CURRENT_VERSION, ShareVersionPicker } from "./share-version-picker";
import type { ShareLinksFeature } from "./use-share-links";

/**
 * The New link part of the Share dialog: label, expiry and version. The Create button lives
 * in the dialog's footer (the thumb zone on a phone), so the form's state is a hook the
 * dialog holds and hands to both.
 */

export interface NewShareLinkForm {
  label: string;
  setLabel: (label: string) => void;
  expiry: ShareExpiryChoice;
  setExpiry: (choice: ShareExpiryChoice) => void;
  version: string;
  setVersion: (version: string) => void;
  error: string | null;
  creating: boolean;
  submit: () => Promise<DesignShareLink | null>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useNewShareLinkForm(links: ShareLinksFeature): NewShareLinkForm {
  const [label, setLabel] = useState("");
  const [expiry, setExpiry] = useState<ShareExpiryChoice>(() => ({
    preset: DEFAULT_SHARE_EXPIRY, customDate: toDateInputValue(Date.now() + 14 * 24 * 60 * 60 * 1000),
  }));
  const [version, setVersion] = useState(CURRENT_VERSION);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const submit = useCallback(async () => {
    const expiresAt = expiryFromChoice(expiry, Date.now());
    if (!expiresAt.ok) { setError(expiresAt.error); return null; }
    setCreating(true);
    setError(null);
    try {
      const link = await links.create({ label: label.trim() || undefined, expiresAt: expiresAt.expiresAt, version });
      setLabel("");
      setVersion(CURRENT_VERSION);
      return link;
    } catch (e) {
      setError(message(e) || "Could not create the link");
      return null;
    } finally {
      setCreating(false);
    }
  }, [expiry, label, version, links]);

  const setExpiryAndClear = useCallback((choice: ShareExpiryChoice) => { setExpiry(choice); setError(null); }, []);
  return { label, setLabel, expiry, setExpiry: setExpiryAndClear, version, setVersion, error, creating, submit };
}

const field = "flex flex-col gap-1.5";
const caption = "text-xs font-medium text-text-subtle";

export function NewShareLinkFields({ form, projectName, slug }: { form: NewShareLinkForm; projectName: string; slug: string }) {
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void form.submit(); }} data-testid="share-new-link">
      <div className={field}>
        <label htmlFor="share-new-label" className={caption}>Label (optional)</label>
        <input id="share-new-label" value={form.label} maxLength={SHARE_LIMITS.maxLabelChars}
          placeholder="For example: Client review" onChange={(e) => form.setLabel(e.target.value)}
          className="min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary md:min-h-9" />
      </div>
      <div className={field}>
        <span className={caption}>Expires after</span>
        <ShareExpiryPicker idPrefix="share-new" value={form.expiry} onChange={form.setExpiry} />
      </div>
      <div className={field}>
        <label htmlFor="share-new-version" className={caption}>Version reviewers see</label>
        <ShareVersionPicker id="share-new-version" projectName={projectName} slug={slug}
          value={form.version} onChange={form.setVersion} />
      </div>
      {form.error && <p className="text-xs text-destructive" role="alert" data-testid="share-new-error">{form.error}</p>}
    </form>
  );
}
