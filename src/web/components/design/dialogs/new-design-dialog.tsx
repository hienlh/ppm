import { useEffect, useState } from "react";
import { FileCode, Loader2, Presentation } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getAISettings } from "@/lib/api-settings";
import { resolveNewChatProvider } from "@/lib/new-chat-provider";
import { createDesign, listDesignProviders, type DesignProvider } from "@/lib/design/api-designs";
import { listDesignSystems, skipDesignSystemSetup } from "@/lib/design/api-design-systems";
import { openDesignTab } from "@/lib/design/open-design-tab";
import { announceDesignsChanged } from "@/lib/design/design-ui-events";
import { getDesignSettings, readSkillLists } from "@/lib/design/api-design-settings";
import { getLastUsedDesignSystem, setLastUsedDesignSystem } from "@/lib/design/last-used-design-system";
import { runDesignSystemSetup } from "@/lib/design/run-design-system-setup";
import { openSettings } from "@/components/settings/open-settings";
import { DesignResponsiveDialog } from "./design-responsive-dialog";
import { DesignSystemSetupStep } from "./design-system-setup-step";
import { DesignSkillSuggestionHint } from "../design-skill-suggestion";
import type { DesignKind, DesignSystemSummary } from "../../../../shared/design-types";
import { needsDesignSkillSuggestion } from "../../../../shared/design-skill-suggestion";

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
  const [systems, setSystems] = useState<DesignSystemSummary[] | null>(null);
  const [systemId, setSystemId] = useState("default");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Shown after "Create" when the chosen app's design system is not set up yet (option B:
  // offered at the first design, never run on its own).
  const [confirmingSetup, setConfirmingSetup] = useState(false);

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
    listDesignSystems(projectName)
      .then((list) => {
        if (cancelled) return;
        setSystems(list);
        const last = getLastUsedDesignSystem(projectName);
        setSystemId(last && list.some((s) => s.id === last) ? last : (list[0]?.id ?? "default"));
      })
      .catch(() => { if (!cancelled) setSystems([]); });
    return () => { cancelled = true; };
  }, [projectName]);

  // Only a hint: the dialog must work the same whether or not this ever answers.
  const [suggestSkill, setSuggestSkill] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getDesignSettings(projectName)
      .then((s) => {
        const lists = readSkillLists(s);
        if (!cancelled) setSuggestSkill(lists.length > 0 && needsDesignSkillSuggestion(s.instructions, lists));
      })
      .catch(() => { /* the hint is optional; Settings → Design shows the real error */ });
    return () => { cancelled = true; };
  }, [projectName]);

  const trimmed = title.trim();
  const canCreate = !!trimmed && !!providerId && !!systems && !creating;
  const chosenSystem = systems?.find((s) => s.id === systemId) ?? null;

  const finishCreate = async (setupFirst: boolean) => {
    setCreating(true);
    setError(null);
    try {
      const design = await createDesign(projectName, { title: trimmed, kind, system: systemId });
      setLastUsedDesignSystem(projectName, systemId);
      announceDesignsChanged(projectName);
      openDesignTab({ projectName, slug: design.slug, title: design.title, providerId, fresh: true });
      if (setupFirst) await runDesignSystemSetup(projectName, systemId);
      else if (chosenSystem && !chosenSystem.hasDesignMd) await skipDesignSystemSetup(projectName, systemId).catch(() => undefined);
      onClose();
    } catch (e) {
      setError((e as Error).message || "Could not create the design");
      setCreating(false);
      setConfirmingSetup(false);
    }
  };

  const create = () => {
    if (!canCreate) return;
    // Every app (including the implicit default) gets the offer once, the first time a
    // design is created for it and it has no design system yet.
    if (chosenSystem && !chosenSystem.hasDesignMd && !chosenSystem.setupSkipped) {
      setConfirmingSetup(true);
      return;
    }
    void finishCreate(false);
  };

  if (confirmingSetup && chosenSystem) {
    return (
      <DesignResponsiveDialog open onClose={() => { if (!creating) onClose(); }} title="New design">
        <DesignSystemSetupStep
          system={chosenSystem}
          busy={creating}
          onSetupFirst={() => void finishCreate(true)}
          onSkip={() => void finishCreate(false)}
        />
      </DesignResponsiveDialog>
    );
  }

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
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); create(); }}>
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
        {systems && systems.length > 1 && (
          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
            Which app is this for?
            <select value={systemId} onChange={(e) => setSystemId(e.target.value)}
              className="min-h-11 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground md:min-h-9">
              {systems.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
        )}
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
        {suggestSkill && <DesignSkillSuggestionHint onOpenSettings={() => { onClose(); openSettings("design"); }} />}
        {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      </form>
    </DesignResponsiveDialog>
  );
}
