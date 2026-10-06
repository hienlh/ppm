import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Check, ChevronRight, Copy, Download, ExternalLink, Loader2, Sparkles } from "@/lib/icons";
import { copyToClipboard } from "@/lib/clipboard";
import { installDesignSkill, type DesignSkillInstallResponse } from "@/lib/design/api-design-settings";
import { DESIGN_SKILL_SUGGESTION } from "../../../shared/design-skill-suggestion";

/** One install recipe: the commands as shown upstream, copyable as a block. */
function CommandBlock({ label, lines }: { label: string; lines: readonly string[] }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyToClipboard(lines.join("\n"))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      toast.error("Could not copy. Select the commands and copy them by hand.");
    }
  };
  return (
    <div className="space-y-1">
      <p className="text-xs text-text-secondary">{label}</p>
      <div className="flex items-start gap-2 rounded-md border border-border bg-background">
        <pre className="min-w-0 flex-1 overflow-x-auto px-2 py-2 font-mono text-xs leading-relaxed text-foreground select-text">
          {lines.join("\n")}
        </pre>
        <button type="button" onClick={copy} aria-label={`Copy: ${label}`}
          className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-text-subtle hover:text-foreground md:min-h-8 md:min-w-8">
          {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
        </button>
      </div>
    </div>
  );
}

/** "Claude", "Claude and Codex", "A, B and C". */
function listNames(names: readonly string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "";
}

/**
 * Shown when no installed skill would be used by a design session: names one design skill and
 * installs it on request. Pressing Install is the consent — nothing is fetched until then — and
 * the server decides what goes where (`design-skill-install.service.ts`). The upstream commands
 * stay one tap away for anyone who would rather run them, or when the host cannot reach npm.
 */
export function DesignSkillSuggestionCard({ providerNames, onInstalled }: {
  /** The design providers it would be installed for, as Settings names them. */
  providerNames: readonly string[];
  onInstalled: (result: DesignSkillInstallResponse) => void | Promise<void>;
}) {
  const s = DESIGN_SKILL_SUGGESTION;
  const [installing, setInstalling] = useState(false);
  const install = async () => {
    setInstalling(true);
    try {
      await onInstalled(await installDesignSkill());
    } catch (e) {
      toast.error(`Could not install ${s.name}`, { description: (e as Error).message });
    } finally {
      setInstalling(false);
    }
  };
  const forWhom = providerNames.length ? ` for ${listNames(providerNames)}` : "";
  return (
    <section aria-label="Suggested design skill" className="space-y-3 rounded-md border border-border bg-surface p-3">
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="space-y-1">
          <p className="text-sm font-medium">No design skill installed</p>
          <p className="text-xs leading-relaxed text-text-subtle">
            A design skill gives the AI a method to follow (palettes, type pairings, layout rules). One option is{" "}
            <a href={s.repoUrl} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 text-primary underline-offset-2 hover:underline">
              {s.name} <ExternalLink className="size-3" />
            </a>{" "}
            ({s.license}). Install sets up version {s.version}{forWhom} and names it in the instructions
            above. {s.requirement}
          </p>
        </div>
      </div>
      <Button onClick={install} disabled={installing} className="min-h-11 w-full gap-1.5 px-4 text-xs md:min-h-8 md:w-auto">
        {installing ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
        {installing ? "Installing…" : `Install ${s.name}`}
      </Button>
      <details className="group">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 text-xs text-text-subtle hover:text-foreground md:min-h-8">
          <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
          Install it yourself instead
        </summary>
        <div className="space-y-3 pt-1">
          {s.installs.map((install) => <CommandBlock key={install.label} label={install.label} lines={install.lines} />)}
        </div>
      </details>
    </section>
  );
}

/** The compact form for the New Design dialog: one line pointing at Settings → Design. */
export function DesignSkillSuggestionHint({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <p className="flex items-center gap-1.5 text-xs leading-relaxed text-text-subtle">
      <Sparkles className="size-3.5 shrink-0 text-warning" />
      <span>
        No design skill is installed.{" "}
        <button type="button" onClick={onOpenSettings}
          className="inline-flex min-h-11 items-center text-primary underline-offset-2 hover:underline md:min-h-0">
          Settings → Design
        </button>{" "}
        can install one for you.
      </span>
    </p>
  );
}
