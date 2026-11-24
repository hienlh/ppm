/**
 * Whether the browser view is actually on screen: the document is visible and the element has
 * a size and intersects the viewport. A minimised window, a background PPM tab and a phone with
 * PPM in the background all read false, which closes the socket so the host browser can stop.
 */
import { useEffect, useState } from "react";

export function useVisibleWhileShown(ref: React.RefObject<HTMLElement | null>): boolean {
  const [docVisible, setDocVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  const [onScreen, setOnScreen] = useState(true);

  useEffect(() => {
    const onChange = () => setDocVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      setOnScreen(!!e && e.isIntersecting && e.boundingClientRect.width > 0 && e.boundingClientRect.height > 0);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);

  return docVisible && onScreen;
}
