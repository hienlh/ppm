/** The browser as a PPM tab: what a phone gets, where there are no floating windows. */
import { useIsMobile } from "@/hooks/use-is-mobile";
import { WebBrowserView } from "./web-browser-view";

export function WebBrowserTab() {
  const phone = useIsMobile();
  return <WebBrowserView phone={phone} />;
}
