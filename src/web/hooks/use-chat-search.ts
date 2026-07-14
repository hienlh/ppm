import { useState, useEffect } from "react";
import { api, projectUrl } from "@/lib/api-client";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import type { ChatSearchResponse } from "../../types/chat";

const EMPTY: ChatSearchResponse = { results: [], indexing: { total: 0, indexed: 0, running: false } };

/**
 * Unified title + full-text content search against `GET /chat/search`.
 * Debounced; empty query short-circuits without hitting the server.
 */
export function useChatSearch(projectName: string, query: string) {
  const debounced = useDebouncedValue(query, 300);
  const [data, setData] = useState<ChatSearchResponse>(EMPTY);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const q = debounced.trim();
    if (!q || !projectName) { setData(EMPTY); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    api.get<ChatSearchResponse>(`${projectUrl(projectName)}/chat/search?q=${encodeURIComponent(q)}`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setData(EMPTY); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectName, debounced]);

  return { results: data.results, indexing: data.indexing, loading, query: debounced };
}
