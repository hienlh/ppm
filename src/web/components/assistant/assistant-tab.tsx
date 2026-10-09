import { AssistantBody } from "./assistant-body";

/**
 * The PPM Assistant as a tab — inside a `tab-host` floating window on a desktop, an
 * ordinary tab below `md`. The tab id and metadata are what the body keys its chat on, so
 * without them (a stale mount) there is nothing to show.
 */
export function AssistantTab({ metadata, tabId }: { metadata?: Record<string, unknown>; tabId?: string }) {
  if (!tabId || !metadata) return null;
  return <AssistantBody tabId={tabId} metadata={metadata} />;
}
