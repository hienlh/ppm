import { useEffect, useState } from "react";
import { FileCode, Loader2, Presentation } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getAISettings } from "@/lib/api-settings";
import { resolveNewChatProvider } from "@/lib/new-chat-provider";
import { createDesign, listDesignProviders, type DesignProvider } from "@/lib/design/api-designs";
import { openDesignTab } from "@/lib/design/open-design-tab";
import { announceDesignsChanged } from "@/lib/design/design-ui-events";
import { DesignResponsiveDialog } from "./design-responsive-dialog";
import type { DesignKind } from "../../../../shared/design-types";

const MAX_TITLE_LENGTH = 120;

const KINDS: Array<{ id: DesignKind; label: string; hint: string; icon: typeof FileCode }> = [
  { id: "page", label: "Page", hint: "A page, screen or prototype", icon: FileCode },
  { id: "slides", label: "Slides", hint: "A 1280×720 slide deck", icon: Presentation },
];

/**
 * Create a design and open its tab.
 *
 * Only providers that deliver design instructions are offered: a design session on any
 * other provider would be an ordinary chat that believes it is not one (the server refuses
 * to create it anyway).
 */
export function NewDesignDialog({ projectName, onClose }: { projectName: string; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<DesignKind>("page");
  const [providers, setProviders] = useState<DesignProvider[] | null>(null);
  const [providerId, setProviderId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listDesignProviders(projectName), getAISettings().catch(() => null)])
      .then(([list, settings]) => {
        if (cancelled) return;
        setProviders(list);
        const preferred = settings ? resolveNewChatProvider(settings) : undefined;
        setProviderId((list.find((p) => p.id === preferred) ?? list[0])?.id ?? "");
      })
      .catch((e) => { if (!cancelled) { setProviders([]); setError((e as Error).message || "Could not load providers"); } });
    return () => { cancelled = true; };
  }, [projectName]);

  const trimmed = title.trim();
  const canCreate = !!trimmed && !!providerId && !creating;

  const create = async () => {
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    try {
      const design = await createDesign(projectName, { title: trimmed, kind });
      announceDesignsChanged(projectName);
      openDesignTab({ projectName, slug: design.slug, title: design.title, providerId, fresh: true });
      onClose();
    } catch (e) {
      setError((e as Error).message || "Could not create the design");
      setCreating(false);
    }
  };

  return (
    <DesignResponsiveDialog
      open
      onClose={() => { if (!creating) onClose(); }}
      title="New design"
      description="The AI builds it in designs/ in this project, with a live preview beside the chat."
      footer={<>
        <Button variant="outline" onClick={onClose} disabled={creating}>Cancel</Button>
        <Button onClick={create} disabled={!canCreate}>
          {creating && <Loader2 className="size-4 animate-spin" />} Create
        </Button>
      </>}
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
          Title
          <input autoFocus value={title} maxLength={MAX_TITLE_LENGTH} onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Pricing page"
            className="min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-text-subtle focus:outline-none focus:ring-1 focus:ring-primary md:min-h-9" />
        </label>
        <div role="radiogroup" aria-label="Kind" className="grid grid-cols-2 gap-2">
          {KINDS.map((k) => (
            <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} onClick={() => setKind(k.id)}
              className={cn("flex min-h-14 flex-col items-start gap-0.5 rounded-md border p-2 text-left",
                kind === k.id ? "border-primary" : "border-border")}>
              <span className="flex items-center gap-1.5 text-sm font-medium"><k.icon className="size-4" /> {k.label}</span>
              <span className="text-xs text-text-subtle">{k.hint}</span>
            </button>
          ))}
        </div>
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
          AI provider
          {providers === null ? (
            <span className="flex min-h-11 items-center gap-2 text-sm text-text-subtle"><Loader2 className="size-4 animate-spin" /> Loading…</span>
          ) : providers.length === 0 ? (
            <span className="text-sm text-text-subtle">No configured provider can run design sessions. Enable Claude or Codex in Settings.</span>
          ) : (
            <select value={providerId} onChange={(e) => setProviderId(e.target.value)}
              className="min-h-11 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground md:min-h-9">
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
        </label>
        {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      </form>
    </DesignResponsiveDialog>
  );
}
