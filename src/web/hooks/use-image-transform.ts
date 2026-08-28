import { useCallback, useEffect, useRef, useState } from "react";
import { useGesture } from "@use-gesture/react";

/**
 * Pan / zoom / rotate / flip state for a single image inside a fixed container.
 *
 * The transform is written straight to the element's style on every gesture frame and only
 * mirrored into React state for the zoom readout. Re-rendering a component tree per
 * pointermove is what makes a viewer feel heavy, and none of the surrounding UI depends on
 * the intermediate values.
 *
 * `scale` is relative to the image's laid-out size, not its pixels: the `<img>` is already
 * CSS-fitted to the container, so scale 1 means "fits" and the fit never has to be measured
 * for the unrotated case.
 */

export interface ImageTransform {
  scale: number;
  x: number;
  y: number;
  /** Multiples of 90 degrees, always normalised to 0/90/180/270. */
  rotation: number;
  flipX: boolean;
  flipY: boolean;
}

const IDENTITY: ImageTransform = { scale: 1, x: 0, y: 0, rotation: 0, flipX: false, flipY: false };

const MIN_SCALE = 0.1;
const MAX_SCALE = 20;
/** Scale applied when double-clicking an image that is currently at fit. */
const DOUBLE_CLICK_SCALE = 2.5;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Whether a wheel event looks like a real mouse wheel rather than a trackpad.
 *
 * Trackpads emit a dense stream of small, often fractional deltas and frequently move on both
 * axes; a wheel emits sparse whole-number notches on one axis. The guess only decides whether
 * a bare wheel zooms or pans — Ctrl/Cmd+wheel, the toolbar and the keyboard always zoom, so a
 * wrong guess is an annoyance rather than a dead end.
 */
function looksLikeMouseWheel(e: WheelEvent): boolean {
  if (e.deltaMode !== 0) return true; // line/page deltas only ever come from a wheel
  if (e.deltaX !== 0) return false;
  return Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40;
}

export interface UseImageTransformResult {
  containerRef: React.RefObject<HTMLDivElement | null>;
  imageRef: React.RefObject<HTMLImageElement | null>;
  /** Current zoom as a percentage of the fitted size, for display only. */
  zoomPercent: number;
  rotation: number;
  zoomBy: (factor: number) => void;
  reset: () => void;
  fit: () => void;
  actualSize: () => void;
  rotate: (deltaDegrees: number) => void;
  flip: (axis: "x" | "y") => void;
}

export function useImageTransform(): UseImageTransformResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const t = useRef<ImageTransform>({ ...IDENTITY });
  const frame = useRef<number | null>(null);

  const [zoomPercent, setZoomPercent] = useState(100);
  const [rotation, setRotation] = useState(0);

  /** Laid-out size of the image — unaffected by transforms, so it is the stable reference. */
  const layout = useCallback(() => {
    const img = imageRef.current;
    const box = containerRef.current;
    return {
      dw: img?.clientWidth ?? 0,
      dh: img?.clientHeight ?? 0,
      cw: box?.clientWidth ?? 0,
      ch: box?.clientHeight ?? 0,
      natural: img?.naturalWidth ?? 0,
    };
  }, []);

  /** How far the image may travel before its edge crosses the container's. */
  const panLimits = useCallback(() => {
    const { dw, dh, cw, ch } = layout();
    const quarterTurned = Math.abs(t.current.rotation % 180) === 90;
    const w = (quarterTurned ? dh : dw) * t.current.scale;
    const h = (quarterTurned ? dw : dh) * t.current.scale;
    return { maxX: Math.max(0, (w - cw) / 2), maxY: Math.max(0, (h - ch) / 2) };
  }, [layout]);

  const commit = useCallback(() => {
    setZoomPercent(Math.round(t.current.scale * 100));
    setRotation(t.current.rotation);
  }, []);

  /**
   * Write the transform, and publish the readout.
   *
   * Mid-gesture the readout is throttled to one frame, since it is cosmetic and re-rendering
   * per pointermove is what makes a viewer feel heavy. At rest it must be published outright:
   * a frame callback only runs if the browser goes on to paint, so a gesture that ends the
   * moment the finger lifts would otherwise leave the number showing the previous value.
   */
  const apply = useCallback((immediate = false) => {
    const el = imageRef.current;
    if (!el) return;
    const { scale, x, y, rotation: r, flipX, flipY } = t.current;
    el.style.transform =
      `translate3d(${x}px, ${y}px, 0) rotate(${r}deg) ` +
      `scale(${scale * (flipX ? -1 : 1)}, ${scale * (flipY ? -1 : 1)})`;

    if (immediate) {
      if (frame.current != null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
      commit();
      return;
    }
    if (frame.current == null) {
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        commit();
      });
    }
  }, [commit]);

  /** Clamp the pan back inside the limits — used after any scale or rotation change. */
  const settle = useCallback((immediate = false) => {
    const { maxX, maxY } = panLimits();
    t.current.x = clamp(t.current.x, -maxX, maxX);
    t.current.y = clamp(t.current.y, -maxY, maxY);
    apply(immediate);
  }, [apply, panLimits]);

  /**
   * Zoom while holding one point of the image still.
   *
   * `originX/Y` are client coordinates; without this correction the image slides away from
   * whatever the user was pointing at, which is the single most noticeable flaw in a viewer.
   */
  const zoomAt = useCallback((nextScale: number, originX?: number, originY?: number, immediate = false) => {
    const box = containerRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const cx = (originX ?? rect.left + rect.width / 2) - (rect.left + rect.width / 2);
    const cy = (originY ?? rect.top + rect.height / 2) - (rect.top + rect.height / 2);

    const prev = t.current.scale;
    const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    const ratio = scale / prev;
    t.current.scale = scale;
    t.current.x = cx - (cx - t.current.x) * ratio;
    t.current.y = cy - (cy - t.current.y) * ratio;
    settle(immediate);
  }, [settle]);

  const reset = useCallback(() => {
    t.current = { ...IDENTITY };
    apply(true);
  }, [apply]);

  /**
   * Scale the image so its rotated bounding box fits the container.
   *
   * At 0 and 180 degrees CSS has already fitted it, so the answer is 1. At a quarter turn the
   * width and height swap and the fitted box no longer fits.
   */
  const fit = useCallback(() => {
    const { dw, dh, cw, ch } = layout();
    const quarterTurned = Math.abs(t.current.rotation % 180) === 90;
    t.current.scale = quarterTurned && dw > 0 && dh > 0 ? Math.min(cw / dh, ch / dw) : 1;
    t.current.x = 0;
    t.current.y = 0;
    settle(true);
  }, [layout, settle]);

  /** One image pixel per CSS pixel. */
  const actualSize = useCallback(() => {
    const { dw, natural } = layout();
    if (dw > 0 && natural > 0) zoomAt(natural / dw, undefined, undefined, true);
  }, [layout, zoomAt]);

  const rotate = useCallback((delta: number) => {
    t.current.rotation = ((t.current.rotation + delta) % 360 + 360) % 360;
    // A quarter turn changes which dimension is constrained, so an untouched view would
    // otherwise overflow. Re-fitting keeps the whole image visible, which is the reason
    // someone rotates in the first place.
    fit();
  }, [fit]);

  const flip = useCallback((axis: "x" | "y") => {
    if (axis === "x") t.current.flipX = !t.current.flipX;
    else t.current.flipY = !t.current.flipY;
    apply(true);
  }, [apply]);

  const zoomBy = useCallback(
    (factor: number) => zoomAt(t.current.scale * factor, undefined, undefined, true),
    [zoomAt],
  );

  // Bound to the container element itself rather than returning props to spread: only a
  // natively attached, non-passive listener may call preventDefault on wheel, and React's
  // synthetic wheel handler is always passive.
  useGesture(
    {
      onDrag: ({ delta: [dx, dy], pinching, cancel, last }) => {
        if (pinching) return cancel();
        t.current.x += dx;
        t.current.y += dy;
        settle(last);
      },
      onPinch: ({ offset: [s], origin: [ox, oy], first, last, memo }) => {
        // `offset` is cumulative from the gesture's start, so anchor it to the scale we had.
        const base = first ? t.current.scale / (s || 1) : memo ?? 1;
        zoomAt(base * s, ox, oy, last);
        return base;
      },
      onWheel: ({ event, last }) => {
        // A wheel gesture closes with a trailing frame that carries the previous event
        // object, deltas and all. Acting on it would apply every notch twice — but it is the
        // right moment to publish the readout, since no further frame is guaranteed.
        if (last) {
          apply(true);
          return;
        }
        // Read the deltas off the event rather than the gesture state, which accumulates.
        const { deltaX, deltaY } = event;
        if (deltaX === 0 && deltaY === 0) return;
        event.preventDefault();

        // A trackpad pinch reaches the page as Ctrl+wheel — the browser exposes no separate
        // pinch event outside of Safari, and @use-gesture's pinch recogniser does not claim
        // it here, so this is the only place it can be handled.
        if (event.ctrlKey || event.metaKey || looksLikeMouseWheel(event)) {
          // Exponential so every notch scales by the same proportion, and so a trackpad's
          // stream of small fractional deltas reads as one continuous zoom.
          zoomAt(t.current.scale * Math.exp(-deltaY / 300), event.clientX, event.clientY);
          return;
        }

        t.current.x -= deltaX;
        t.current.y -= deltaY;
        settle();
      },
      onDoubleClick: ({ event }) => {
        if (t.current.scale > 1.05) fit();
        else zoomAt(DOUBLE_CLICK_SCALE, event.clientX, event.clientY, true);
      },
    },
    {
      target: containerRef,
      drag: { from: () => [t.current.x, t.current.y], filterTaps: true, pointer: { touch: true } },
      pinch: { scaleBounds: { min: MIN_SCALE, max: MAX_SCALE }, rubberband: true },
      eventOptions: { passive: false },
    },
  );

  // A resized window changes what "fits", and a stale pan clamp would leave the image
  // stranded off-centre.
  useEffect(() => {
    const onResize = () => settle();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (frame.current != null) cancelAnimationFrame(frame.current);
    };
  }, [settle]);

  return { containerRef, imageRef, zoomPercent, rotation, zoomBy, reset, fit, actualSize, rotate, flip };
}
