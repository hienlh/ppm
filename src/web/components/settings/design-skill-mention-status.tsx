import { AlertTriangle, Check } from "@/lib/icons";
import { resolveSkillMention } from "../../../shared/design-skill-mentions";
import type { DesignProviderSkills } from "@/lib/design/api-design-settings";

/**
 * Where each skill named in the instructions resolves, per provider — the same resolution
 * the server applies when a design session starts, so what this says is what the AI gets.
 * A name that resolves nowhere is flagged: the session is told it is not a skill.
 */
export function DesignSkillMentionStatus({ mentions, providers }: { mentions: string[]; providers: DesignProviderSkills[] }) {
  if (!mentions.length || !providers.length) return null;
  return (
    <section aria-label="Skills named in the instructions" className="space-y-1.5">
      <p className="text-xs font-medium">Skills named</p>
      <ul className="space-y-1.5">
        {mentions.map((mention) => {
          const hits = providers.map((p) => ({ provider: p, skill: resolveSkillMention(mention, p.items) }));
          // Only a list that was actually read can say "not installed".
          const nowhere = hits.every((h) => !h.skill && h.provider.available);
          return (
            <li key={mention} data-mention={mention} className="rounded-md border border-border px-2 py-1.5 text-xs">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <code className="font-mono text-foreground">/{mention}</code>
                {nowhere ? (
                  <span className="flex items-center gap-1 text-warning">
                    <AlertTriangle className="size-3.5" /> Not an installed skill. Design chats read it as plain text.
                  </span>
                ) : hits.map(({ provider, skill }) => (
                  <span key={provider.id} className={skill ? "flex items-center gap-1 text-text-secondary" : "text-text-subtle"}>
                    {skill && <Check className="size-3.5 text-success" />}
                    {provider.name}: {skill ? skill.name : provider.available ? "not installed" : "skill list unavailable"}
                  </span>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
