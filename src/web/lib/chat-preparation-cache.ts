import { api, projectUrl } from "./api-client";
import type { AISettings } from "./api-settings";

export interface ChatProviderInfo { id: string; name: string }
const TTL_MS = 60_000;
export const CHAT_PREPARATION_TIMEOUT_MS = 30_000;
type Entry<T> = { value?: T; expires: number; request?: Promise<T> };
const settings = new Map<string, Entry<AISettings>>();
const providers = new Map<string, Entry<ChatProviderInfo[]>>();
let generation = 0;
export function chatPreparationGeneration(): number { return generation; }

function cached<T>(cache: Map<string, Entry<T>>, key: string, fetch: () => Promise<T>): Promise<T> {
  const previous = cache.get(key);
  if (previous?.value !== undefined && previous.expires > Date.now()) return Promise.resolve(previous.value);
  if (previous?.request) return previous.request;
  const entry: Entry<T> = { expires: 0 };
  cache.set(key, entry);
  entry.request = new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chat preparation timed out. Please retry.")), CHAT_PREPARATION_TIMEOUT_MS);
    Promise.resolve().then(fetch).then(resolve, reject).finally(() => clearTimeout(timer));
  }).then((value) => {
    if (cache.get(key) === entry) {
      entry.value = value;
      entry.expires = Date.now() + TTL_MS;
      entry.request = undefined;
    }
    return value;
  }, (error) => {
    if (cache.get(key) === entry) cache.delete(key);
    throw error;
  });
  return entry.request;
}

/** Only provider selection and permissions are retained; never account credentials. */
export function getChatPreparationSettings(projectName = ""): Promise<AISettings> {
  return cached(settings, projectName, async () => {
    const value = await api.get<AISettings>("/api/settings/ai", { signal: AbortSignal.timeout(CHAT_PREPARATION_TIMEOUT_MS) });
    return {
      default_provider: value.default_provider,
      new_chat_provider_mode: value.new_chat_provider_mode,
      providers: Object.fromEntries(Object.entries(value.providers).map(([id, provider]) =>
        [id, { permission_mode: provider.permission_mode }])),
    };
  });
}

export function getChatProviders(projectName: string): Promise<ChatProviderInfo[]> {
  return cached(providers, projectName, () => api.get<ChatProviderInfo[]>(`${projectUrl(projectName)}/chat/providers`,
    { signal: AbortSignal.timeout(CHAT_PREPARATION_TIMEOUT_MS) }));
}

export function peekChatProviders(projectName: string): ChatProviderInfo[] | undefined {
  const entry = providers.get(projectName);
  return entry && entry.expires > Date.now() ? entry.value : undefined;
}

export function clearChatPreparationCache(): void {
  ++generation;
  settings.clear();
  providers.clear();
}
