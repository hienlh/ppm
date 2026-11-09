import { useEffect, useState } from "react";
import { Check } from "@/lib/icons";
import { getChatProviders, peekChatProviders } from "@/lib/chat-preparation-cache";
import { PROVIDER_LOGOS } from "@/lib/provider-logos";
import { cn } from "@/lib/utils";

interface ProviderInfo {
  id: string;
  name: string;
}

/**
 * The provider's own logo. An id with no artwork — or no id at all, which is a
 * real case, since a chat search result carries no provider — keeps the lettered
 * tile these all used to be, so it still reads as a provider rather than as a
 * gap in the row.
 */
export function ProviderIcon({ providerId, className }: { providerId: string | undefined; className: string }) {
  const Logo = providerId ? PROVIDER_LOGOS[providerId] : undefined;
  if (Logo) return <Logo className={cn("shrink-0", className)} />;
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded bg-surface-elevated text-[10px] font-bold text-text-subtle shrink-0",
        className,
      )}
    >
      ?
    </span>
  );
}

/**
 * The providers a new chat can start on, as one line of choices — the top of the model chip's
 * popup. The model chip carries the provider's logo, so a separate provider chip only said the
 * same thing twice; picking the provider is part of picking the model.
 *
 * Shown only before the chat has a session (a session belongs to one provider). The list is
 * discovered when the popup opens and shown from the cache straight away.
 */
export function ProviderChoiceRow({ value, onChange, projectName }: {
  value: string;
  onChange: (providerId: string) => void;
  projectName: string;
}) {
  const [result, setResult] = useState<{ projectName: string; providers: ProviderInfo[]; error?: boolean } | null>(null);
  const providers = result?.projectName === projectName ? result.providers : peekChatProviders(projectName) ?? [];
  const error = result?.projectName === projectName && result.error;

  useEffect(() => {
    if (!projectName) return;
    let active = true;
    getChatProviders(projectName)
      .then((providers) => { if (active) setResult({ projectName, providers }); })
      .catch(() => { if (active) setResult({ projectName, providers: peekChatProviders(projectName) ?? [], error: true }); });
    return () => { active = false; };
  }, [projectName]);

  return (
    <div className="border-b border-border px-1 py-1" role="radiogroup" aria-label="AI provider">
      <div className="px-2 py-1 text-xs font-medium text-text-secondary">Provider</div>
      {providers.length === 0 ? (
        <div role="status" className="px-2 py-1.5 text-xs text-text-secondary">
          {error ? "Unable to load providers" : result?.projectName === projectName ? "No providers available" : "Loading providers..."}
        </div>
      ) : (
        <div className="flex flex-wrap gap-1 px-1 pb-1">
          {providers.map((p) => {
            const active = p.id === value;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onChange(p.id)}
                className={cn(
                  "inline-flex min-h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors max-md:min-h-11 max-md:px-3.5 max-md:text-sm",
                  active ? "border-accent-wash-border bg-accent-wash text-text" : "border-border-soft text-text-2 can-hover:hover:bg-surface-hover can-hover:hover:text-text",
                )}
              >
                <ProviderIcon providerId={p.id} className="size-3.5 max-md:size-4" />
                <span className="capitalize">{p.name}</span>
                {active && <Check className="size-3.5 text-primary" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Small provider badge for session lists. */
export function ProviderBadge({ providerId, size = "md" }: { providerId: string | undefined; size?: "sm" | "md" }) {
  // The tooltip sits on a wrapper on purpose: a `title` *attribute* on an `<svg>`
  // draws nothing (SVG wants a `<title>` child), so the name would be lost.
  return (
    <span className="inline-flex shrink-0" title={providerId}>
      <ProviderIcon providerId={providerId} className={size === "sm" ? "size-3.5" : "size-4"} />
    </span>
  );
}
