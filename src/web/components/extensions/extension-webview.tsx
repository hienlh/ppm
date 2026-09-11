import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { useExtensionStore } from "@/stores/extension-store";
import { getAuthToken } from "@/lib/api-client";
import { THEME_CHANGE_EVENT } from "@/theme/apply-theme";
import { HOST_THEME_MESSAGE, injectHostTheme, readHostTheme } from "./webview-theme";
import { commandRunsGit } from "@/lib/git-repo-scope";
import { resolveGitRoot } from "@/stores/git-repo-store";
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

/**
 * The path the recovery dispatch should hand the command.
 *
 * Fetched rather than read from the project store because a panel can be
 * restored before the store has anything in it. A git view is then re-pointed
 * at the repository the user chose, exactly as the live dispatch sites do —
 * otherwise a reload reopens the graph on the container folder and it reports
 * no repository.
 */
async function resolveDispatchPath(projectName: string, command: string): Promise<string | undefined> {
  try {
    const token = getAuthToken();
    const res = await fetch("/api/projects", token ? { headers: { Authorization: `Bearer ${token}` } } : {});
    const json = await res.json() as { ok: boolean; data?: { name: string; path: string }[] };
    const match = json.data?.find((p) => p.name === projectName);
    if (!match) return undefined;
    return commandRunsGit(command) ? await resolveGitRoot(projectName, match.path) : match.path;
  } catch {
    return undefined;
  }
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
  // Use the tab's own project name (frozen at creation time) — NOT the global
  // currentProject. Old project's ExtensionWebview must not react to project
  // switches, which would dispatch commands for the wrong project.
  const projectName = (metadata?.projectName as string | undefined) || undefined;
  const [timedOut, setTimedOut] = useState(false);
  // Track whether extensions are activated (contributions received from WS)
  const extensionsReady = useExtensionStore((s) => s.contributions !== null);

  // Match panel: prefer panelId (exact), fallback to viewType match (reload recovery).
  // Fallback is project-scoped — never adopt another project's panel.
  const panel = useExtensionStore((s) => {
    if (panelId && s.webviewPanels[panelId]) return s.webviewPanels[panelId];
    if (viewType) {
      // Find panel whose viewType matches (with or without .view suffix)
      const fullViewType = viewType.includes(".") ? viewType : `${viewType}.view`;
      const candidates = Object.values(s.webviewPanels).filter(
        (p) => p.viewType === viewType || p.viewType === fullViewType,
      );
      // Exact project match first; panels/tabs without project info fall back
      // to legacy any-match; reject candidates bound to a different project
      return candidates.find((p) => p.projectName && p.projectName === projectName)
        ?? candidates.find((p) => !p.projectName || !projectName);
    }
    return undefined;
  });

  const resolvedPanelId = panel?.id ?? panelId;
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Inject acquireVsCodeApi shim + write HTML into iframe via srcdoc
  const rawHtml = panel?.html ?? "";
  // Seeded with the theme so the panel's first paint is already the right one.
  // Deliberately not a dependency of this memo: srcDoc is what mounts the
  // iframe, so recomputing it on a theme change would reload the panel. Later
  // changes are posted in below instead.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const html = useMemo(
    () => injectHostTheme(injectVscodeApiShim(rawHtml), readHostTheme(document.documentElement)),
    [rawHtml],
  );

  // Track which project was last dispatched to prevent duplicate dispatches
  const prevProjectRef = useRef<string | null>(null);

  // On reload: resolve project path and dispatch command once.
  // Wait for extensions to be activated (contributions received) before dispatching.
  useEffect(() => {
    if (panel || !viewType || !extensionsReady) return;
    // Already dispatched for this project — panel is just temporarily missing
    if (projectName && projectName === prevProjectRef.current) return;
    if (projectName) prevProjectRef.current = projectName;
    const command = viewType.includes(".") ? viewType : `${viewType}.view`;
    let cancelled = false;

    async function dispatch() {
      let args: unknown[] = [];
      if (projectName) {
        const path = await resolveDispatchPath(projectName, command);
        if (path) args = [path];
      }
      if (cancelled) return;
      window.dispatchEvent(new CustomEvent("ext:command:execute", {
        detail: { command, args, recovery: true },
      }));
    }

    dispatch();
    return () => { cancelled = true; };
  }, [panel, viewType, projectName, extensionsReady]);

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
      const path = projectName ? await resolveDispatchPath(projectName, command) : undefined;
      window.dispatchEvent(new CustomEvent("ext:command:execute", {
        detail: { command, args: path ? [path] : [], recovery: true },
      }));
    })();
  }, [viewType, projectName]);

  // On unmount: notify server to dispose the panel so extension clears activePanel state
  const panelIdForCleanup = useRef<string | null>(null);
  const viewTypeForCleanup = useRef<string | undefined>(viewType);
  const projectNameForCleanup = useRef<string | undefined>(projectName);
  useEffect(() => {
    panelIdForCleanup.current = resolvedPanelId ?? null;
  }, [resolvedPanelId]);
  useEffect(() => {
    viewTypeForCleanup.current = viewType;
  }, [viewType]);
  useEffect(() => {
    projectNameForCleanup.current = projectName;
  }, [projectName]);
  useEffect(() => {
    return () => {
      const id = panelIdForCleanup.current;
      if (id) {
        const vt = viewTypeForCleanup.current;
        useExtensionStore.getState().removeWebviewPanel(id);
        window.dispatchEvent(new CustomEvent("ext:webview:close", {
          detail: { panelId: id, viewType: vt, projectName: projectNameForCleanup.current },
        }));
      }
    };
  }, []);

  // Auto-retry: if panel doesn't appear after extensions are ready,
  // re-dispatch the command every 2s (up to 3 times) before showing error.
  // This handles transient WS instability during initial page load where the
  // first command dispatch may be lost due to connection cycling.
  useEffect(() => {
    if (panel) { setTimedOut(false); return; }
    if (!extensionsReady || !viewType) return;
    let retries = 0;
    const id = setInterval(() => {
      retries++;
      if (retries > 3) {
        clearInterval(id);
        setTimedOut(true);
        return;
      }
      handleRetry();
    }, 2_000);
    return () => clearInterval(id);
  }, [panel, extensionsReady, viewType, handleRetry]);

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

  // Forward theme changes to the iframe (see the srcDoc memo above)
  useEffect(() => {
    const handler = () => {
      const { mode, css } = readHostTheme(document.documentElement);
      iframeRef.current?.contentWindow?.postMessage({ command: HOST_THEME_MESSAGE, mode, css }, "*");
    };
    window.addEventListener(THEME_CHANGE_EVENT, handler);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, handler);
  }, []);

  // Loading state — waiting for extension to create the panel AND deliver HTML.
  // We must wait for HTML before mounting the iframe because browsers don't
  // re-execute scripts when React updates the srcDoc attribute from "" to content.
  if (!panel || !rawHtml) {
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
        key={resolvedPanelId}
        srcDoc={html}
        sandbox="allow-scripts"
        className="w-full h-full border-0 bg-white dark:bg-bg"
        title={panel.title}
      />
    </div>
  );
}
