import { useState } from "react";
import { toast } from "sonner";
import { Check, Copy, ExternalLink, Sparkles } from "@/lib/icons";
import { copyToClipboard } from "@/lib/clipboard";
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

/**
 * Shown when no installed skill would be used by a design session: names one design skill
 * and how to install it. PPM only shows the commands — installing software is the user's
 * call, so nothing here runs anything.
 */
export function DesignSkillSuggestionCard() {
  const s = DESIGN_SKILL_SUGGESTION;
  return (
    <section aria-label="Suggested design skill" className="space-y-3 rounded-md border border-border bg-surface p-3">
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="space-y-1">
          <p className="text-sm font-medium">No design skill installed</p>
          <p className="text-xs leading-relaxed text-text-subtle">
            A design skill gives the AI a method to follow (palettes, type pairings, layout rules).
            PPM does not install skills for you. One option is{" "}
            <a href={s.repoUrl} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 text-primary underline-offset-2 hover:underline">
              {s.name} <ExternalLink className="size-3" />
            </a>{" "}
            ({s.license}). {s.requirement} After installing, name it in the instructions above,
            e.g. <code>/{s.name}</code>.
          </p>
        </div>
      </div>
      {s.installs.map((install) => <CommandBlock key={install.label} label={install.label} lines={install.lines} />)}
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
        suggests one you can install.
      </span>
    </p>
  );
}
