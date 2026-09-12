/**
 * The one place that knows how a proxy URL is shaped.
 *
 * The Connection Info card and the Test dialog both need these. They used to
 * build them separately, and the Test dialog never learned about provider
 * prefixes — so picking a provider showed one set of URLs while Test quietly
 * called another, and the answer came back from the wrong engine.
 */

/** `<root>/proxy` for the default Claude path, `<root>/proxy/<provider>` otherwise. */
export function proxyPrefix(root: string, provider?: string): string {
  return `${root}/proxy${provider ? `/${provider}` : ""}`;
}

export interface ProxyEndpoints {
  /** Anthropic SDK base — the SDK appends `/v1/messages` itself. */
  anthropicBase: string;
  /** OpenAI SDK base — the SDK appends `/chat/completions` itself. */
  openAiBase: string;
  anthropicMessages: string;
  openAiChatCompletions: string;
  models: string;
  /** Images live only under a provider; the default path has no such route. */
  imagesGenerations: string | null;
  imagesEdits: string | null;
}

export function proxyEndpoints(root: string, provider?: string): ProxyEndpoints {
  const prefix = proxyPrefix(root, provider);
  return {
    anthropicBase: prefix,
    openAiBase: `${prefix}/v1`,
    anthropicMessages: `${prefix}/v1/messages`,
    openAiChatCompletions: `${prefix}/v1/chat/completions`,
    models: `${prefix}/v1/models`,
    imagesGenerations: provider ? `${prefix}/v1/images/generations` : null,
    imagesEdits: provider ? `${prefix}/v1/images/edits` : null,
  };
}
