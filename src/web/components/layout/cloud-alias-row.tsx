import { useState, useEffect, useCallback } from "react";
import { Loader2, Pencil, ExternalLink, Check, X } from "lucide-react";
import { api } from "@/lib/api-client";

/** Cloud's slug rules — mirrored here so a bad name fails before a round-trip. */
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,31}$/;
const SLUG_HINT = "2–32 characters: lowercase letters, numbers, hyphens.";

interface Props {
  /** Base URL of the cloud instance, e.g. https://cloud.ppm.sh */
  cloudUrl: string;
  /** Machine name — seeds the input with a sensible default slug. */
  deviceName: string | null;
}

/** Strip the scheme so the permanent link reads like an address, not a URL. */
function displayHost(cloudUrl: string): string {
  return cloudUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function suggestSlug(deviceName: string | null): string {
  if (!deviceName) return "";
  const slug = deviceName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return SLUG_REGEX.test(slug) ? slug : "";
}

/**
 * Permanent link for this machine. The tunnel URL rotates on every restart;
 * the alias is the stable address that always resolves to the current one.
 */
export function CloudAliasRow({ cloudUrl, deviceName }: Props) {
  const [slug, setSlug] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [unreadable, setUnreadable] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<{ slug: string | null }>("/api/cloud/alias");
        setSlug(res.slug);
      } catch {
        // A failed read must not look like "no link yet": saving uses the device
        // secret, so it would succeed and silently replace a link already in use.
        setUnreadable(true);
      }
      setLoading(false);
    })();
  }, []);

  const startEdit = useCallback(() => {
    setDraft(slug ?? suggestSlug(deviceName));
    setError(null);
    setEditing(true);
  }, [slug, deviceName]);

  const handleSave = useCallback(async () => {
    const next = draft.trim().toLowerCase();
    if (!SLUG_REGEX.test(next)) {
      setError(SLUG_HINT);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await api.patch<{ slug: string }>("/api/cloud/alias", { slug: next });
      setSlug(res.slug);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that name");
    } finally {
      setSaving(false);
    }
  }, [draft]);

  if (loading) return null;

  if (unreadable) {
    return (
      <p className="text-[11px] text-muted-foreground leading-relaxed">
        Couldn't check this machine's permanent link. Open the cloud dashboard, or sign in again.
      </p>
    );
  }

  if (editing) {
    return (
      <div className="space-y-1.5">
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Permanent link</span>
        <div className="flex items-center gap-1">
          <span className="text-xs font-mono text-muted-foreground shrink-0">{displayHost(cloudUrl)}/</span>
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave();
              if (e.key === "Escape") setEditing(false);
            }}
            placeholder="my-mac"
            // 16px font on mobile — anything smaller makes iOS zoom on focus.
            className="flex-1 min-w-0 text-base md:text-xs font-mono text-foreground bg-muted px-2 min-h-11 md:min-h-0 md:py-1.5 rounded border border-border outline-none focus:border-primary"
          />
          <button
            onClick={handleSave}
            disabled={saving}
            title="Save"
            className="flex items-center justify-center size-11 md:size-8 rounded border border-border text-primary bg-muted hover:bg-accent transition-colors shrink-0 disabled:opacity-50"
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          </button>
          <button
            onClick={() => setEditing(false)}
            title="Cancel"
            className="flex items-center justify-center size-11 md:size-8 rounded border border-border text-muted-foreground bg-muted hover:bg-accent transition-colors shrink-0"
          >
            <X className="size-3.5" />
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground">{error ?? SLUG_HINT}</p>
      </div>
    );
  }

  if (!slug) {
    return (
      <button
        onClick={startEdit}
        className="w-full flex items-center justify-center gap-1.5 px-3 min-h-11 md:min-h-0 md:py-2 text-xs font-medium rounded-md border border-border hover:bg-muted transition-colors"
      >
        <Pencil className="size-3.5" />
        Set a permanent link
      </button>
    );
  }

  return (
    <div className="space-y-1">
      <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Permanent link</span>
      <div className="flex items-center gap-1">
        <a
          href={`${cloudUrl}/${slug}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 min-w-0 flex items-center gap-1 text-xs font-mono text-primary hover:underline truncate"
        >
          <span className="truncate">{displayHost(cloudUrl)}/{slug}</span>
          <ExternalLink className="size-3 shrink-0" />
        </a>
        <button
          onClick={startEdit}
          title="Change permanent link"
          className="flex items-center justify-center size-11 md:size-8 rounded border border-border text-muted-foreground bg-muted hover:bg-accent hover:text-foreground transition-colors shrink-0"
        >
          <Pencil className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
