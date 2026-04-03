import { useRef, useEffect, useCallback } from "react";
import { useExtensionStore } from "@/stores/extension-store";

interface ExtensionWebviewProps {
  metadata?: Record<string, unknown>;
}

/**
 * iframe-based webview container for extension-contributed webview panels.
 * Renders as a tab component in the editor panel system.
 */
export function ExtensionWebview({ metadata }: ExtensionWebviewProps) {
  const panelId = metadata?.panelId as string | undefined;
  const panel = useExtensionStore((s) => panelId ? s.webviewPanels[panelId] : undefined);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Write HTML content into iframe via srcdoc
  const html = panel?.html ?? "";

  // Listen for postMessage from iframe → forward to extension via WS bridge
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (iframeRef.current && event.source === iframeRef.current.contentWindow) {
        // Forward to server via custom event → picked up by useExtensionWs
        window.dispatchEvent(new CustomEvent("ext:webview:send", {
          detail: { panelId, message: event.data },
        }));
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [panelId]);

  // Listen for server→webview messages (dispatched by useExtensionWs)
  // targetOrigin "*" is safe here because sandbox omits allow-same-origin,
  // so iframe origin is opaque "null". MUST restrict if allow-same-origin is ever added.
  useEffect(() => {
    const handler = (e: Event) => {
      const { panelId: targetId, message } = (e as CustomEvent).detail;
      if (targetId === panelId) {
        iframeRef.current?.contentWindow?.postMessage(message, "*");
      }
    };
    window.addEventListener("ext:webview:message", handler);
    return () => window.removeEventListener("ext:webview:message", handler);
  }, [panelId]);

  if (!panel) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-text-subtle">
        Webview panel not found
      </div>
    );
  }

  return (
    <div className="h-full w-full relative">
      <iframe
        ref={iframeRef}
        srcDoc={html}
        sandbox="allow-scripts"
        className="w-full h-full border-0 bg-white dark:bg-zinc-900"
        title={panel.title}
      />
    </div>
  );
}
