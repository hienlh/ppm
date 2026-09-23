import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { commitDesignTweaks, getDesignTweaks, type DesignTweaksInfo } from "@/lib/design/api-design-tweaks";
import { overriddenVars, pendingChanges } from "@/lib/design/design-tweaks-model";
import { isSafeTweakValueShape } from "../../../../shared/design-tweaks";
import type { TweakWinner } from "../../../../shared/design-bridge-messages-tweaks";
import type { DesignTabContextValue } from "../design-tab-context";
import type { DesignBridge } from "../canvas/use-design-bridge";

/**
 * Tweak controls for one design tab: the definitions from `design.json`, what the page
 * renders for each variable, the user's unapplied edits, and Apply.
 *
 * Edits show live: each one becomes a `tweak-set` (coalesced to one per frame) that the
 * bridge applies as an inline override. Every new document — a live reload, a 409 recovery,
 * a panel move — starts without those overrides, so each `ready` re-reads the rendered
 * values and replays the unapplied edits. Only this side decides what is written: Apply
 * posts the edits it holds, and the frame's reports only ever fill the controls.
 *
 * After an Apply the page reloads from the rewritten file; if the reloaded page does not
 * render a committed value, a later or more specific rule wins over it, and the panel says so.
 */

export function useDesignTweaks(tab: DesignTabContextValue, bridge: DesignBridge, reloadCanvas: () => void, opts: { onPanelOpen: () => void }) {
  const { projectName, slug, design, isStreaming } = tab;
  const [info, setInfo] = useState<DesignTweaksInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rendered, setRendered] = useState<Record<string, string>>({});
  const [winners, setWinners] = useState<Record<string, TweakWinner>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [overridden, setOverridden] = useState<string[]>([]);
  const [applying, setApplying] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const verify = useRef<Record<string, string> | null>(null);
  const gensAfterApply = useRef<Record<string, string>>({});
  const outbox = useRef<Record<string, string>>({});
  const frame = useRef<number | null>(null);
  const live = useRef({ info, edits, ready: bridge.ready });
  live.current = { info, edits, ready: bridge.ready };
  const onPanelOpen = useRef(opts.onPanelOpen);
  onPanelOpen.current = opts.onPanelOpen;
  const { send } = bridge;

  // A manifest refresh hands over a new summary object: the tweaks may have changed with it.
  useEffect(() => {
    let cancelled = false;
    getDesignTweaks(projectName, slug)
      .then((next) => { if (!cancelled) { setInfo(next); setLoadError(null); } })
      .catch((e: Error) => { if (!cancelled) setLoadError(e.message || "Could not load the tweaks"); });
    return () => { cancelled = true; };
  }, [projectName, slug, design]);

  const vars = useMemo(() => (info?.tweaks ?? []).map((t) => t.var), [info]);
  useEffect(() => {
    if (vars.length && live.current.ready) send({ type: "tweak-read", vars });
  }, [vars, send]);

  useEffect(() => {
    const offs = [
      bridge.onReplay((replaySend) => {
        gensAfterApply.current = {};
        const { info: current, edits: pending } = live.current;
        const names = (current?.tweaks ?? []).map((t) => t.var);
        if (!names.length) return;
        // Read first: the rendered values are the file's, before the edits go back on.
        replaySend({ type: "tweak-read", vars: names });
        const values = Object.fromEntries(Object.entries(pending).filter(([name, v]) => names.includes(name) && isSafeTweakValueShape(v)));
        if (Object.keys(values).length) replaySend({ type: "tweak-set", values });
      }),
      bridge.on("tweak-values", (m) => {
        setRendered((r) => ({ ...r, ...m.values }));
        setWinners((w) => ({ ...w, ...m.winners }));
        if (verify.current) {
          setOverridden(overriddenVars(verify.current, m.values));
          verify.current = null;
        }
      }),
    ];
    return () => { for (const off of offs) off(); };
  }, [bridge.on, bridge.onReplay]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);

  const setValue = useCallback((name: string, value: string) => {
    setEdits((e) => ({ ...e, [name]: value }));
    setOverridden((o) => o.filter((v) => v !== name));
    if (!isSafeTweakValueShape(value)) return;
    outbox.current[name] = value;
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const values = outbox.current;
      outbox.current = {};
      send({ type: "tweak-set", values });
    });
  }, [send]);

  const reset = useCallback(() => {
    outbox.current = {};
    setEdits({});
    send({ type: "tweak-reset" });
  }, [send]);

  const pending = useMemo(() => pendingChanges(info?.tweaks ?? [], edits, rendered), [info, edits, rendered]);
  const dirtyCount = Object.keys(pending).length;

  const apply = useCallback(async () => {
    const ready = live.current.ready;
    const values = pending;
    if (!ready || isStreaming || Object.keys(values).length === 0) return;
    setApplying(true);
    try {
      const gens = { ...ready.cssGens, [ready.file]: ready.gen, ...gensAfterApply.current };
      const out = await commitDesignTweaks(projectName, slug, { entry: ready.file, gens, values });
      if (out.status === "stale") {
        // The edits stay; the next `ready` replays them onto the fresh document.
        toast.warning("The design changed; your values are kept, press Apply again");
        reloadCanvas();
        return;
      }
      gensAfterApply.current = { ...gensAfterApply.current, ...out.gens };
      verify.current = values;
      setRendered((r) => ({ ...r, ...values }));
      setEdits((e) => Object.fromEntries(Object.entries(e).filter(([name]) => !(name in values))));
      toast.success(Object.keys(values).length === 1 ? "Tweak applied" : `${Object.keys(values).length} tweaks applied`);
    } catch (e) {
      toast.error("Could not apply the tweaks", { description: (e as Error).message });
    } finally {
      setApplying(false);
    }
  }, [pending, isStreaming, projectName, slug, reloadCanvas]);

  const togglePanel = useCallback(() => {
    if (!panelOpen) onPanelOpen.current();
    setPanelOpen(!panelOpen);
  }, [panelOpen]);
  const closePanel = useCallback(() => setPanelOpen(false), []);

  return {
    info, loadError, rendered, winners, edits, overridden, applying, panelOpen, dirtyCount,
    /** Shown once `design.json` is a JSON object, with or without tweaks. */
    available: info?.manifestValid === true,
    canApply: dirtyCount > 0 && !applying && !isStreaming && bridge.ready !== null,
    isStreaming,
    setValue, reset, apply: () => { void apply(); }, togglePanel, closePanel,
  };
}

export type DesignTweaksFeature = ReturnType<typeof useDesignTweaks>;
