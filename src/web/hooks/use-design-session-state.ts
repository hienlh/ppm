import { useCallback, useEffect, useState } from "react";
import { api, projectUrl } from "@/lib/api-client";
import { getAISettings } from "@/lib/api-settings";
import { resolveNewChatProvider } from "@/lib/new-chat-provider";
import { listDesignProviders } from "@/lib/design/api-designs";
import { patchTabMetadata } from "@/lib/patch-tab-metadata";
import { nextChatEpoch } from "@/lib/design/open-design-tab";
import type { ChatForkRequest } from "@/components/chat/chat-tab";
import type { SessionListResponse } from "../../types/chat";

/**
 * Which chat session a design tab's embedded chat runs, and on which provider.
 *
 * Settled before the chat mounts, for two reasons. A tab opened from a deep link knows only
 * the slug, so its latest session is looked up (once — `designSessionChecked`) rather than a
 * fresh one silently started beside it. And the provider must be one that carries design
 * instructions: the chat's own new-tab gate would pick the default provider whatever it is.
 *
 * The chat is keyed on `designChatEpoch`, so replacing its session (a fork, a new session,
 * a pick from history elsewhere) is a metadata write plus an epoch bump, never a second tab.
 */

export type DesignSessionStatus = "resolving" | "ready" | "no-provider" | "error";

/** Sessions scanned for the design's latest one; the list is newest-first. */
const ADOPT_SCAN_LIMIT = 200;

export function useDesignSessionState(tabId: string, metadata: Record<string, unknown>) {
  const [status, setStatus] = useState<DesignSessionStatus>("resolving");
  const [attempt, setAttempt] = useState(0);
  const projectName = String(metadata.projectName ?? "");
  const slug = String(metadata.designSlug ?? "");
  const sessionId = typeof metadata.sessionId === "string" ? metadata.sessionId : undefined;
  const checked = metadata.designSessionChecked === true;
  const pending = metadata.providerPending === true || typeof metadata.providerId !== "string";
  const epoch = typeof metadata.designChatEpoch === "number" ? metadata.designChatEpoch : 0;

  useEffect(() => {
    if (!projectName || !slug) return;
    let cancelled = false;
    const run = async () => {
      if (!sessionId && !checked) {
        const params = new URLSearchParams({ limit: String(ADOPT_SCAN_LIMIT), offset: "0" });
        const data = await api.get<SessionListResponse>(`${projectUrl(projectName)}/chat/sessions?${params}`);
        if (cancelled) return;
        const latest = data.sessions.find((s) => s.designSlug === slug);
        patchTabMetadata(tabId, {
          designSessionChecked: true,
          ...(latest ? {
            sessionId: latest.id, providerId: latest.providerId, providerPending: undefined,
            designChatEpoch: epoch + 1,
          } : {}),
        });
        return; // the write re-runs this effect with the new metadata
      }
      if (pending) {
        const [settings, providers] = await Promise.all([getAISettings(), listDesignProviders(projectName)]);
        if (cancelled) return;
        const preferred = resolveNewChatProvider(settings);
        const pick = providers.find((p) => p.id === preferred) ?? providers[0];
        if (!pick) { setStatus("no-provider"); return; }
        patchTabMetadata(tabId, { providerId: pick.id, providerPending: undefined });
        return;
      }
      setStatus("ready");
    };
    setStatus((s) => (s === "ready" && !pending && (sessionId || checked) ? s : "resolving"));
    run().catch((e) => {
      console.warn(`[design] could not prepare the chat for ${slug}: ${(e as Error).message}`);
      if (!cancelled) setStatus("error");
    });
    return () => { cancelled = true; };
  }, [tabId, projectName, slug, sessionId, checked, pending, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  /** `/clear` inside the design: the next session starts in this tab, in design mode. */
  const startNewSession = useCallback((clearedFrom?: string) => {
    patchTabMetadata(tabId, {
      sessionId: undefined, pendingMessage: undefined, clearedFrom,
      designSessionChecked: true, designChatEpoch: nextChatEpoch({ designChatEpoch: epoch }),
    });
  }, [tabId, epoch]);

  /** A fork stays in the design: swap it in and let the remounted chat resend the message. */
  const adoptFork = useCallback((fork: ChatForkRequest) => {
    patchTabMetadata(tabId, {
      sessionId: fork.sessionId, providerId: fork.providerId, pendingMessage: fork.pendingMessage,
      designChatEpoch: nextChatEpoch({ designChatEpoch: epoch }),
    });
  }, [tabId, epoch]);

  return { status, retry, epoch, sessionId: sessionId ?? null, startNewSession, adoptFork };
}
