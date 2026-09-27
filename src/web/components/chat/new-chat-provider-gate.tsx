import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { AISettings } from "@/lib/api-settings";
import { chatPreparationGeneration, clearChatPreparationCache, getChatPreparationSettings, getChatProviders, type ChatProviderInfo } from "@/lib/chat-preparation-cache";
import { resolveNewChatProvider } from "@/lib/new-chat-provider";
import { usePanelStore } from "@/stores/panel-store";

interface PreparedChat { providerId: string; permissionMode?: string }
interface NewChatPreparation {
  pending: boolean;
  providerId?: string;
  permissionMode?: string;
  prepare: () => Promise<PreparedChat>;
}
const PreparationContext = createContext<NewChatPreparation>({
  pending: false,
  prepare: () => Promise.reject(new Error("Chat preparation is unavailable.")),
});
export function useNewChatPreparation(): NewChatPreparation { return useContext(PreparationContext); }

/** Keep the composer mounted while resolving the provider in the background. */
export function NewChatProviderGate({ tabId, metadata, children }: {
  tabId: string;
  metadata: Record<string, unknown>;
  children: ReactNode;
}) {
  const [error, setError] = useState<string>();
  const [unavailable, setUnavailable] = useState<{
    provider: string; settings: AISettings; alternatives: ChatProviderInfo[];
  } | null>(null);
  const latest = useRef(metadata);
  latest.current = metadata;
  const active = useRef(true);
  const inFlight = useRef<Promise<PreparedChat> | null>(null);
  const pending = metadata.providerPending === true;

  const currentMetadata = useCallback(() => {
    const store = usePanelStore.getState();
    return store.getPanelForTab(tabId)?.tabs.find((tab) => tab.id === tabId)?.metadata ?? latest.current;
  }, [tabId]);

  const selectProvider = useCallback((providerId: string, settings: AISettings): PreparedChat => {
    const current = currentMetadata();
    if (!current.providerPending && typeof current.providerId === "string") {
      return { providerId: current.providerId, permissionMode: current.permissionMode as string | undefined };
    }
    const result = { providerId, permissionMode: (current.permissionMode as string | undefined)
      ?? settings.providers[providerId]?.permission_mode ?? "bypassPermissions" };
    const next = { ...current, ...result, providerPending: undefined, focusedProviderOnOpen: undefined };
    latest.current = next;
    usePanelStore.getState().updateTab(tabId, { metadata: next });
    return result;
  }, [currentMetadata, tabId]);

  const prepare = useCallback((): Promise<PreparedChat> => {
    const current = currentMetadata();
    if (!current.providerPending) {
      return typeof current.providerId === "string" && current.providerId
        ? Promise.resolve({ providerId: current.providerId, permissionMode: current.permissionMode as string | undefined })
        : Promise.reject(new Error("Choose a provider for this chat."));
    }
    if (inFlight.current) return inFlight.current;
    setError(undefined);
    setUnavailable(null);
    const projectName = current.projectName as string | undefined;
    const generation = chatPreparationGeneration();
    const request = Promise.all([
      getChatPreparationSettings(projectName),
      projectName ? getChatProviders(projectName) : Promise.resolve(null),
    ]).then(([settings, providers]) => {
      if (!active.current) throw new Error("Chat was closed.");
      if (generation !== chatPreparationGeneration()) throw new Error("Chat settings changed. Please retry.");
      const now = currentMetadata();
      if (!now.providerPending && typeof now.providerId === "string") {
        return { providerId: now.providerId, permissionMode: now.permissionMode as string | undefined };
      }
      const providerId = resolveNewChatProvider(settings, current.focusedProviderOnOpen as string | undefined);
      if (providers && !providers.some((provider) => provider.id === providerId)) {
        setUnavailable({ provider: providerId, settings, alternatives: providers });
        throw new Error(`${providerId} is not available. Choose a provider for this chat.`);
      }
      return selectProvider(providerId, settings);
    }).catch((reason: unknown) => {
      if (active.current) setError(reason instanceof Error ? reason.message : "Could not load chat settings.");
      throw reason;
    }).finally(() => { if (inFlight.current === request) inFlight.current = null; });
    inFlight.current = request;
    return request;
  }, [currentMetadata, selectProvider]);

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { if (pending) void prepare().catch(() => {}); }, [pending, prepare]);
  const retry = () => { clearChatPreparationCache(); void prepare().catch(() => {}); };

  return <PreparationContext.Provider value={{ pending, providerId: metadata.providerId as string | undefined,
    permissionMode: metadata.permissionMode as string | undefined, prepare }}>
    <div className="flex h-full min-h-0 flex-col">
      {pending && <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-1 text-xs text-muted-foreground" role="status">
        {unavailable ? <>
          <span>{unavailable.provider} is not available. Choose a provider for this chat.</span>
          {unavailable.alternatives.map((provider) => <button key={provider.id} className="text-primary underline"
            onClick={() => selectProvider(provider.id, unavailable.settings)}>Use {provider.name}</button>)}
          <button className="text-primary underline" onClick={retry}>Check again</button>
        </> : error ? <>
          <span>Could not load chat settings. {error}</span>
          <button className="text-primary underline" onClick={retry}>Retry</button>
        </> : "Preparing chat…"}
      </div>}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  </PreparationContext.Provider>;
}
