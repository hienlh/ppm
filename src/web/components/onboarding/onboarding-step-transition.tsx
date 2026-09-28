import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Animate the existing content node: no delayed state updates or duplicate controls. */
export function OnboardingStepTransition({ stepKey, order, className, children }: {
  stepKey: string; order: number; className?: string; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef({ stepKey, order });
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { stepKey, order };
    const node = ref.current;
    if (before.stepKey === stepKey || !node?.animate) return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (preference.matches) return;
    const animation = node.animate([
      { opacity: 0.35, transform: `translateX(${order < before.order ? -12 : 12}px)` },
      { opacity: 1, transform: "translateX(0)" },
    ], { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" });
    // Canceling on rapid navigation/unmount rejects finished; that is expected.
    void animation.finished.catch(() => {});
    const stop = () => { if (preference.matches) animation.cancel(); };
    preference.addEventListener("change", stop);
    return () => { animation.cancel(); preference.removeEventListener("change", stop); };
  }, [stepKey, order]);
  return <div ref={ref} data-onboarding-transition={stepKey} className={className}>{children}</div>;
}
