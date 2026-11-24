/** The desktop floating window's body. */
import type { WindowContentProps } from "@/components/floating-window/window-content-registry";
import { WebBrowserView } from "./web-browser-view";

export default function WebBrowserWindowContent(_props: WindowContentProps) {
  return <WebBrowserView phone={false} />;
}
