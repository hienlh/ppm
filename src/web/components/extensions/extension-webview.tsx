import { useRef, useEffect, useState, useCallback } from "react";
import { useExtensionStore } from "@/stores/extension-store";
import { useTabStore } from "@/stores/tab-store";
import { Loader2 } from "lucide-react";

/** Inject acquireVsCodeApi() shim so extension webviews can postMessage to parent */
const VSCODE_API_SHIM = `<script>
function acquireVsCodeApi(){return{postMessage:function(m){window.parent.postMessage(m,"*")},getState:function(){try{return JSON.parse(sessionStorage.getItem("vscode-state")||"null")}catch{return null}},setState:function(s){sessionStorage.setItem("vscode-state",JSON.stringify(s));return s}}}
</script>`;

function injectVscodeApiShim(html: string): string {
  if (!html) return html;
  // Insert shim right after <head> tag (or at start if no <head>)
  const headIdx = html.indexOf("<head>");
  if (headIdx !== -1) {
    return html.slice(0, headIdx + 6) + VSCODE_API_SHIM + html.slice(headIdx + 6);
  }
  return VSCODE_API_SHIM + html;
}

interface ExtensionWebviewProps {
  metadata?: Record<string, unknown>;
}

/**
 * iframe-based webview container for extension-contributed webview panels.
 * Matches panel by panelId (direct) or viewType (reload recovery).
 */
export function ExtensionWebview({ metadata }: ExtensionWebviewProps) {
  const panelId = metadata?.panelId as string | undefined;
  const viewType = metadata?.viewType as string | undefined;
  const currentProject = useTabStore((s) => s.currentProject);
  const projectName = (metadata?.projectName as string | undefined) || currentProject || undefined;
  const [timedOut, setTimedOut] = useState(false);

  // Match panel: prefer panelId (exact), fallback to viewType match (reload recovery)
  const panel = useExtensionStore((s) => {
    if (panelId && s.webviewPanels[panelId]) return s.webviewPanels[panelId];
    if (viewType) {
      // Find panel whose viewType matches (with or without .view suffix)
      const fullViewType = viewType.includes(".") ? viewType : `${viewType}.view`;
      return Object.values(s.webviewPanels).find(
        (p) => p.viewType === viewType || p.viewType === fullViewType,
      );
    }
    return undefined;
  });

  const resolvedPanelId = panel?.id ?? panelId;
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Inject acquireVsCodeApi shim + write HTML into iframe via srcdoc
  const rawHtml = panel?.html ?? "";
  const html = injectVscodeApiShim(rawHtml);

  // On reload: resolve project path, then dispatch command with retry
  // Retry needed because WS connection may not be ready on first attempt
  useEffect(() => {
    if (panel || !viewType) return;
    const command = viewType.includes(".") ? viewType : `${viewType}.view`;
    let cancelled = false;
    let resolvedArgs: unknown[] | null = null;

    async function resolveArgs(): Promise<unknown[]> {
      if (resolvedArgs) return resolvedArgs;
      if (!projectName) return [];
      try {
        const res = await fetch("/api/projects");
        const json = await res.json() as { ok: boolean; data?: { name: string; path: string }[] };
        const match = json.data?.find((p) => p.name === projectName);
        resolvedArgs = match ? [match.path] : [];
      } catch {
        resolvedArgs = [];
      }
      return resolvedArgs;
    }

    async function attempt() {
      const args = await resolveArgs();
      if (cancelled) return;
      window.dispatchEvent(new CustomEvent("ext:command:execute", {
        detail: { command, args },
      }));
    }

    // First attempt after short delay (let WS connect), then retry every 2s
    const initialTimer = setTimeout(() => {
      if (!cancelled) attempt();
    }, 500);
    const retryTimer = setInterval(() => {
      if (!cancelled) attempt();
    }, 2_000);

    return () => { cancelled = true; clearTimeout(initialTimer); clearInterval(retryTimer); };
  }, [panel, viewType, projectName]);

  // When project switches while panel exists, re-dispatch command with new project path
  const prevProjectRef = useRef(currentProject);
  useEffect(() => {
    if (!panel || !viewType || !currentProject || currentProject === prevProjectRef.current) {
      prevProjectRef.current = currentProject;
      return;
    }
    prevProjectRef.current = currentProject;
    // Resolve new project path and dispatch command
    (async () => {
      try {
        const res = await fetch("/api/projects");
        const json = await res.json() as { ok: boolean; data?: { name: string; path: string }[] };
        const match = json.data?.find((p: { name: string }) => p.name === currentProject);
        if (match) {
          const command = viewType.includes(".") ? viewType : `${viewType}.view`;
          window.dispatchEvent(new CustomEvent("ext:command:execute", {
            detail: { command, args: [match.path] },
          }));
        }
      } catch {}
    })();
  }, [panel, viewType, currentProject]);

  // Check activation errors for this extension
  const extensionId = metadata?.extensionId as string | undefined;
  const activationError = useExtensionStore((s) => {
    // Direct match by extensionId (most reliable)
    if (extensionId && s.activationErrors[extensionId]) return s.activationErrors[extensionId];
    // Fallback: check by viewType prefix (e.g. "ext-git-graph" for viewType "git-graph")
    if (!viewType) return undefined;
    for (const [extId, error] of Object.entries(s.activationErrors)) {
      if (extId === `ext-${viewType}`) return error;
    }
    return undefined;
  });

  // Retry handler — re-dispatches the command
  const handleRetry = useCallback(() => {
    setTimedOut(false);
    if (!viewType) return;
    const command = viewType.includes(".") ? viewType : `${viewType}.view`;
    (async () => {
      try {
        const res = await fetch("/api/projects");
        const json = await res.json() as { ok: boolean; data?: { name: string; path: string }[] };
        const match = json.data?.find((p) => p.name === projectName);
        const args = match ? [match.path] : [];
        window.dispatchEvent(new CustomEvent("ext:command:execute", {
          detail: { command, args },
        }));
      } catch {}
    })();
  }, [viewType, projectName]);

  // Timeout: if panel doesn't appear within 10s, show error
  useEffect(() => {
    if (panel) { setTimedOut(false); return; }
    const timer = setTimeout(() => setTimedOut(true), 10_000);
    return () => clearTimeout(timer);
  }, [panel]);

  // Listen for postMessage from iframe → forward to extension via WS bridge
  useEffect(() => {
    if (!resolvedPanelId) return;
    const handler = (event: MessageEvent) => {
      if (iframeRef.current && event.source === iframeRef.current.contentWindow) {
        window.dispatchEvent(new CustomEvent("ext:webview:send", {
          detail: { panelId: resolvedPanelId, message: event.data },
        }));
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [resolvedPanelId]);

  // Listen for server→webview messages (dispatched by useExtensionWs)
  useEffect(() => {
    if (!resolvedPanelId) return;
    const handler = (e: Event) => {
      const { panelId: targetId, message } = (e as CustomEvent).detail;
      if (targetId === resolvedPanelId) {
        iframeRef.current?.contentWindow?.postMessage(message, "*");
      }
    };
    window.addEventListener("ext:webview:message", handler);
    return () => window.removeEventListener("ext:webview:message", handler);
  }, [resolvedPanelId]);

  // Loading state — waiting for extension to create the panel
  if (!panel) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-sm text-text-subtle">
        {timedOut ? (
          <>
            <span className="text-destructive font-medium">Extension failed to load</span>
            {activationError && (
              <span className="text-xs text-muted-foreground max-w-md text-center">{activationError}</span>
            )}
            <button
              onClick={handleRetry}
              className="text-xs text-primary hover:underline"
            >
              Retry
            </button>
          </>
        ) : (
          <>
            <Loader2 className="size-5 animate-spin" />
            <span>Loading extension...</span>
          </>
        )}
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
