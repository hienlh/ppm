import { useEffect, useState, type ReactNode } from "react";
import { getAISettings, type AISettings } from "@/lib/api-settings";
import { api, projectUrl } from "@/lib/api-client";
import { resolveNewChatProvider } from "@/lib/new-chat-provider";
import { usePanelStore } from "@/stores/panel-store";

/** Do not mount chat (or claim an account) until its initial provider is known. */
export function NewChatProviderGate({ tabId, metadata, children }: {
  tabId: string;
  metadata: Record<string, unknown>;
  children: ReactNode;
}) {
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [unavailable, setUnavailable] = useState<{
    provider: string; settings: AISettings; alternatives: Array<{ id: string; name: string }>;
  } | null>(null);
  const pending = metadata.providerPending === true;
  const source = metadata.focusedProviderOnOpen as string | undefined;
  const projectName = metadata.projectName as string | undefined;

  function selectProvider(providerId: string, settings: AISettings) {
    const store = usePanelStore.getState();
    const tab = store.getPanelForTab(tabId)?.tabs.find((t) => t.id === tabId);
    if (!tab?.metadata?.providerPending) return;
    store.updateTab(tabId, { metadata: {
      ...tab.metadata,
      providerId,
      providerPending: undefined,
      focusedProviderOnOpen: undefined,
      permissionMode: tab.metadata.permissionMode ?? settings.providers[providerId]?.permission_mode ?? "bypassPermissions",
    } });
  }

  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    setError(false);
    setUnavailable(null);
    Promise.all([
      getAISettings(),
      projectName ? api.get<Array<{ id: string; name: string }>>(`${projectUrl(projectName)}/chat/providers`) : Promise.resolve(null),
    ]).then(([settings, providers]) => {
      if (cancelled) return;
      const providerId = resolveNewChatProvider(settings, source);
      if (providers && !providers.some((p) => p.id === providerId)) {
        setUnavailable({ provider: providerId, settings, alternatives: providers });
        return;
      }
      selectProvider(providerId, settings);
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [pending, source, projectName, tabId, attempt]);

  if (!pending) return children;
  if (unavailable) return <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-sm text-muted-foreground" role="status">
    <p>{unavailable.provider} is not available. Choose a provider for this chat.</p>
    {unavailable.alternatives.map((p) => <button key={p.id} className="text-primary underline"
      onClick={() => selectProvider(p.id, unavailable.settings)}>Use {p.name}</button>)}
    <button className="text-primary underline" onClick={() => setAttempt((n) => n + 1)}>Check again</button>
  </div>;
  return <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
    {error ? <>
      Could not load chat settings.
      <button className="text-primary underline" onClick={() => setAttempt((n) => n + 1)}>Retry</button>
    </> : "Preparing chat…"}
  </div>;
}
