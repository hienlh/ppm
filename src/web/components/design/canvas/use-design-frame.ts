import { useCallback, useEffect, useRef, useState } from "react";
import {
  designFrameKey, loadDesignViewPrefs, saveDesignViewPrefs, withFrame,
} from "@/lib/design/design-view-prefs";
import type { DesignTabContextValue } from "../design-tab-context";
import { defaultFrameFor, framePreset, type DeviceFrameId } from "./device-frame-presets";
import { fitFrame, type Size } from "./canvas-geometry";

/**
 * The device frame the canvas is shown in (remembered per design on this device) and how it
 * fits the stage it sits on, re-measured whenever the stage is resized.
 */
export function useDesignFrame(tab: DesignTabContextValue) {
  const frameKey = designFrameKey(tab.projectName, tab.slug);
  const [frame, setFrameState] = useState<DeviceFrameId>(
    () => loadDesignViewPrefs().frames[frameKey] ?? defaultFrameFor(tab.design.kind),
  );
  const setFrame = useCallback((next: DeviceFrameId) => {
    setFrameState(next);
    saveDesignViewPrefs(withFrame(loadDesignViewPrefs(), frameKey, next));
  }, [frameKey]);

  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<Size>({ width: 0, height: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setStage({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const fit = fitFrame(framePreset(frame).size, stage);
  return { frame, setFrame, stageRef, stage, fit, framed: frame !== "desktop" };
}
