import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api, projectUrl } from "@/lib/api-client";
import type { SessionInfo } from "../../../types/chat";

interface VersionsResponse {
  versions: SessionInfo[];
  currentIndex: number;
}

// Dedupe in-flight + resolved lookups across re-mounts. Keyed by the viewed
// session + the message ordinal so each message slot fetches its group once.
const cache = new Map<string, Promise<VersionsResponse | null>>();

/** Drop all cached version groups — call after an edit changes the tree so
 *  switchers refetch fresh `n/m` counts instead of showing stale numbers. */
export function clearVersionsCache(): void {
  cache.clear();
}

function fetchVersions(
  projectName: string,
  sessionId: string,
  providerId: string,
  ordinal: number,
): Promise<VersionsResponse | null> {
  const key = `${sessionId}:${ordinal}`;
  let p = cache.get(key);
  if (!p) {
    p = api
      .get<VersionsResponse>(
        `${projectUrl(projectName)}/chat/sessions/${sessionId}/versions?ordinal=${ordinal}&providerId=${providerId}`,
      )
      .catch(() => null); // 400 = no versions at this ordinal → hide switcher
    cache.set(key, p);
  }
  return p;
}

/**
 * `‹ n/m ›` switcher shown on a user message that has edited versions. Fetches
 * the version group for the message anchored at `anchorMsgId`; renders nothing
 * unless 2+ versions exist. Prev/next swap the tab to the sibling session.
 */
export function VersionSwitcher({
  projectName,
  sessionId,
  providerId,
  ordinal,
  onNavigate,
  disabled,
}: {
  projectName?: string;
  sessionId?: string;
  providerId: string;
  ordinal?: number;
  onNavigate: (sessionId: string) => void;
  disabled?: boolean;
}) {
  const [data, setData] = useState<VersionsResponse | null>(null);

  useEffect(() => {
    if (!projectName || !sessionId || !ordinal || ordinal < 1) {
      setData(null);
      return;
    }
    let alive = true;
    fetchVersions(projectName, sessionId, providerId, ordinal).then((res) => {
      if (alive) setData(res && res.versions.length >= 2 ? res : null);
    });
    return () => {
      alive = false;
    };
  }, [projectName, sessionId, providerId, ordinal]);

  if (!data) return null;

  const { versions, currentIndex } = data;
  const go = (idx: number) => {
    const target = versions[idx];
    if (target && !disabled) onNavigate(target.id);
  };

  return (
    <div className="mt-1 flex items-center gap-1 text-xs text-text-subtle select-none">
      <button
        type="button"
        onClick={() => go(currentIndex - 1)}
        disabled={disabled || currentIndex <= 0}
        aria-label="Previous version"
        className="flex items-center justify-center rounded p-0.5 hover:text-text-primary disabled:opacity-30 disabled:cursor-default"
      >
        <ChevronLeft className="size-3.5" />
      </button>
      <span className="tabular-nums">{currentIndex + 1}/{versions.length}</span>
      <button
        type="button"
        onClick={() => go(currentIndex + 1)}
        disabled={disabled || currentIndex >= versions.length - 1}
        aria-label="Next version"
        className="flex items-center justify-center rounded p-0.5 hover:text-text-primary disabled:opacity-30 disabled:cursor-default"
      >
        <ChevronRight className="size-3.5" />
      </button>
    </div>
  );
}
