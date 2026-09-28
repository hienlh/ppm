import { useEffect, useRef, useState, type ReactNode } from "react";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useVisualViewport } from "@/hooks/use-visual-viewport";

export function findTourTarget(target: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-onboarding="${target}"]`))
    .find((node) => node.getClientRects().length > 0 && node.getBoundingClientRect().width > 0);
}

/** Nonmodal: the real app stays interactive throughout a guided action. */
export function OnboardingHint({ target, children, collapsed }: { target?: string; children: ReactNode; collapsed: boolean }) {
  const mobile = useIsMobile();
  const viewport = useVisualViewport(mobile);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const card = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(360);
  useEffect(() => {
    if (!card.current) return;
    const observer = new ResizeObserver(() => setHeight(card.current?.getBoundingClientRect().height ?? 360));
    observer.observe(card.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!target || collapsed) { setRect(null); return; }
    const measure = () => setRect(findTourTarget(target)?.getBoundingClientRect() ?? null);
    measure();
    const timer = window.setInterval(measure, 500);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => { clearInterval(timer); window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); };
  }, [target, collapsed]);
  const left = !mobile && rect && rect.right + 380 < window.innerWidth ? rect.right + 12 : undefined;
  const top = collapsed ? 48 : !mobile && rect
    ? Math.max(16, Math.min(left !== undefined ? rect.top : rect.top - height - 12, window.innerHeight - height - 44)) : undefined;
  return <>
    {rect && !mobile && !collapsed && <div aria-hidden className="fixed pointer-events-none z-[59] rounded-md border-2 border-primary" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />}
    <aside ref={card} aria-label="PPM guided tour" className="fixed z-[60] overflow-x-hidden rounded-xl border border-border bg-background text-foreground shadow-xl"
      style={{ width: mobile ? "calc(100% - 24px)" : 352, maxWidth: "calc(100vw - 24px)", left: mobile ? 12 : left, right: mobile || left !== undefined ? undefined : 20,
        top, bottom: top !== undefined ? undefined : mobile ? (viewport?.keyboardInset ?? 0) + 60 : 44, maxHeight: mobile ? "min(48dvh, 370px)" : "calc(100dvh - 80px)", overflowY: "auto" }}>
      {children}
    </aside>
  </>;
}
