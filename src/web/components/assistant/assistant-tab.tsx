import { AssistantWindowBody } from "./assistant-window-body";

/**
 * The PPM Assistant as a tab — inside a `tab-host` floating window on a desktop, a full-screen
 * tab below `md`. The tab id and metadata are what the body keys its chat on, so without them
 * (a stale mount) there is nothing to show.
 */
export function AssistantTab({ metadata, tabId }: { metadata?: Record<string, unknown>; tabId?: string }) {
  if (!tabId || !metadata) return null;
  return <AssistantWindowBody tabId={tabId} metadata={metadata} />;
}
