/**
 * A spec as the browser shows it, kept fresh: refetched on `spec:changed` (an approval, a task
 * run — anything PPM records) and on `file:changed` under its folder (the AI writing a document).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { specsApi } from "@/lib/api-specs";
import type { SpecView } from "../../shared/spec-view";
import type { SpecSummary } from "../../shared/spec-types";

const SPECS_PREFIX = "specs/";

function useSpecEvents(projectName: string, onChange: (slug: string | null) => void): void {
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    if (!projectName) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pending = new Set<string | null>();
    // A burst of file writes (the AI saving a document) becomes one refetch.
    const queue = (slug: string | null) => {
      pending.add(slug);
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        for (const s of pending) cb.current(s);
        pending.clear();
      }, 250);
    };
    const onSpec = (e: Event) => {
      const d = (e as CustomEvent<{ projectName?: string; slug?: string }>).detail;
      if (d?.projectName === projectName) queue(d.slug ?? null);
    };
    const onFile = (e: Event) => {
      const d = (e as CustomEvent<{ projectName?: string; path?: string }>).detail;
      if (d?.projectName !== projectName || !d.path?.startsWith(SPECS_PREFIX)) return;
      queue(d.path.slice(SPECS_PREFIX.length).split("/")[0] ?? null);
    };
    window.addEventListener("spec:changed", onSpec);
    window.addEventListener("file:changed", onFile);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("spec:changed", onSpec);
      window.removeEventListener("file:changed", onFile);
    };
  }, [projectName]);
}

export function useSpec(projectName: string, slug: string | null) {
  const [spec, setSpec] = useState<SpecView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    if (!projectName || !slug) { setSpec(null); return; }
    const mine = ++seq.current;
    try {
      const v = await specsApi.get(projectName, slug);
      if (mine === seq.current) { setSpec(v); setError(null); }
    } catch (e) {
      if (mine === seq.current) setError((e as Error).message);
    }
  }, [projectName, slug]);

  useEffect(() => { setSpec(null); void refresh(); }, [refresh]);
  useSpecEvents(projectName, (changed) => { if (!changed || changed === slug) void refresh(); });
  return { spec, error, refresh, setSpec };
}

/** The spec a chat is bound to, looked up once per session (and again when a spec is created). */
export function useSessionSpec(projectName: string, sessionId: string | null | undefined) {
  const [binding, setBinding] = useState<{ slug: string; taskId: string | null } | null>(null);
  const refresh = useCallback(async () => {
    if (!projectName || !sessionId) { setBinding(null); return; }
    try {
      setBinding(await specsApi.bySession(projectName, sessionId));
    } catch {
      setBinding(null);
    }
  }, [projectName, sessionId]);
  useEffect(() => { void refresh(); }, [refresh]);
  // `spec_create` from the chat binds it mid-way; the event names the new spec.
  useSpecEvents(projectName, () => { if (!binding) void refresh(); });
  return binding;
}

export function useSpecList(projectName: string) {
  const [specs, setSpecs] = useState<SpecSummary[] | null>(null);
  const refresh = useCallback(async () => {
    if (!projectName) return;
    try { setSpecs(await specsApi.list(projectName)); } catch { setSpecs([]); }
  }, [projectName]);
  useEffect(() => { void refresh(); }, [refresh]);
  useSpecEvents(projectName, () => void refresh());
  return { specs, refresh };
}
