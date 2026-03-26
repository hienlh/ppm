import { useState, useRef, useCallback, useEffect } from "react";
import {
  ArrowLeft,
  ArrowRight,
  RotateCcw,
  ExternalLink,
  Globe,
} from "lucide-react";
import { useTabStore } from "@/stores/tab-store";

/** Parse a URL string — returns normalized URL or null if invalid */
function parseUrl(input: string): string | null {
  let url = input.trim();
  if (!url) return null;

  // If just a port number, treat as localhost
  if (/^\d+$/.test(url)) return `http://localhost:${url}`;

  // If host:port without scheme, add http://
  if (/^localhost(:\d+)?/.test(url)) url = `http://${url}`;
  if (/^[\w.-]+:\d+/.test(url) && !url.includes("://")) url = `http://${url}`;

  // If no scheme at all, add https:// for external, http:// for localhost
  if (!url.includes("://")) {
    url = url.includes("localhost") ? `http://${url}` : `https://${url}`;
  }

  try {
    new URL(url);
    return url;
  } catch {
    return null;
  }
}

/** Check if a URL is a localhost address */
function isLocalhost(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.hostname === "localhost" ||
      u.hostname === "127.0.0.1" ||
      u.hostname === "0.0.0.0" ||
      u.hostname === "::1"
    );
  } catch {
    return false;
  }
}

/** Convert URL to iframe src — proxy localhost through backend */
function toIframeSrc(url: string): string {
  if (!isLocalhost(url)) return url;

  try {
    const u = new URL(url);
    const port = u.port || "80";
    const path = u.pathname + u.search + u.hash;
    return `/api/preview/${port}${path}`;
  } catch {
    return url;
  }
}

/** Extract display URL from iframe src (reverse of toIframeSrc) */
function fromIframeSrc(src: string): string {
  const match = src.match(/^\/api\/preview\/(\d+)(\/.*)?$/);
  if (match) {
    const port = match[1];
    const path = match[2] || "/";
    return `http://localhost:${port}${path}`;
  }
  return src;
}

interface BrowserTabProps {
  metadata?: Record<string, unknown>;
  tabId?: string;
}

export function BrowserTab({ metadata, tabId }: BrowserTabProps) {
  const initialUrl = (metadata?.url as string) || "http://localhost:3000";
  const [addressBar, setAddressBar] = useState(initialUrl);
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [iframeSrc, setIframeSrc] = useState(toIframeSrc(initialUrl));
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const updateTab = useTabStore((s) => s.updateTab);

  // Navigation history (iframe same-origin only)
  const historyRef = useRef<string[]>([initialUrl]);
  const historyIdxRef = useRef(0);

  const navigate = useCallback(
    (url: string, addToHistory = true) => {
      const parsed = parseUrl(url);
      if (!parsed) {
        setError("Invalid URL");
        return;
      }

      setError(null);
      setCurrentUrl(parsed);
      setAddressBar(parsed);
      setIframeSrc(toIframeSrc(parsed));
      setLoading(true);

      if (addToHistory) {
        const h = historyRef.current;
        const idx = historyIdxRef.current;
        // Truncate forward history
        historyRef.current = h.slice(0, idx + 1);
        historyRef.current.push(parsed);
        historyIdxRef.current = historyRef.current.length - 1;
      }

      setCanGoBack(historyIdxRef.current > 0);
      setCanGoForward(
        historyIdxRef.current < historyRef.current.length - 1,
      );

      // Update tab title
      if (tabId) {
        try {
          const u = new URL(parsed);
          const title = isLocalhost(parsed)
            ? `localhost:${u.port || "80"}`
            : u.hostname;
          updateTab(tabId, { title });
        } catch {}
      }
    },
    [tabId, updateTab],
  );

  const goBack = useCallback(() => {
    if (historyIdxRef.current > 0) {
      historyIdxRef.current--;
      navigate(historyRef.current[historyIdxRef.current]!, false);
    }
  }, [navigate]);

  const goForward = useCallback(() => {
    if (historyIdxRef.current < historyRef.current.length - 1) {
      historyIdxRef.current++;
      navigate(historyRef.current[historyIdxRef.current]!, false);
    }
  }, [navigate]);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    if (iframeRef.current) {
      // Force reload by re-setting src
      const src = iframeRef.current.src;
      iframeRef.current.src = "";
      requestAnimationFrame(() => {
        if (iframeRef.current) iframeRef.current.src = src;
      });
    }
  }, []);

  const openExternal = useCallback(() => {
    window.open(currentUrl, "_blank");
  }, [currentUrl]);

  const handleAddressKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      navigate(addressBar);
    }
  };

  // Navigate when metadata.url changes (e.g. opened from command palette)
  useEffect(() => {
    const metaUrl = metadata?.url as string | undefined;
    if (metaUrl && metaUrl !== currentUrl) {
      navigate(metaUrl);
    }
  }, [metadata?.url]);

  return (
    <div className="flex flex-col h-full w-full bg-background">
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border bg-surface shrink-0">
        {/* Nav buttons */}
        <button
          onClick={goBack}
          disabled={!canGoBack}
          className="p-1.5 rounded hover:bg-surface-elevated disabled:opacity-30 transition-colors"
          title="Back"
        >
          <ArrowLeft className="size-4" />
        </button>
        <button
          onClick={goForward}
          disabled={!canGoForward}
          className="p-1.5 rounded hover:bg-surface-elevated disabled:opacity-30 transition-colors"
          title="Forward"
        >
          <ArrowRight className="size-4" />
        </button>
        <button
          onClick={reload}
          className="p-1.5 rounded hover:bg-surface-elevated transition-colors"
          title="Reload"
        >
          <RotateCcw className={`size-4 ${loading ? "animate-spin" : ""}`} />
        </button>

        {/* Address bar */}
        <div className="flex-1 flex items-center gap-2 mx-1 px-2.5 py-1.5 rounded-md bg-background border border-border focus-within:border-accent/50 transition-colors">
          <Globe className="size-3.5 text-text-subtle shrink-0" />
          <input
            type="text"
            value={addressBar}
            onChange={(e) => setAddressBar(e.target.value)}
            onKeyDown={handleAddressKeyDown}
            placeholder="Enter URL or port (e.g. 3000, localhost:8080)"
            className="flex-1 bg-transparent text-xs text-text-primary outline-none placeholder:text-text-subtle min-w-0"
          />
        </div>

        {/* Open external */}
        <button
          onClick={openExternal}
          className="p-1.5 rounded hover:bg-surface-elevated transition-colors"
          title="Open in browser"
        >
          <ExternalLink className="size-4" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 relative min-h-0">
        {error ? (
          <div className="flex items-center justify-center h-full text-text-secondary text-sm">
            <p>{error}</p>
          </div>
        ) : (
          <iframe
            ref={iframeRef}
            src={iframeSrc}
            className="w-full h-full border-0"
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
            onLoad={() => setLoading(false)}
            onError={() => {
              setLoading(false);
              setError(`Failed to load ${currentUrl}`);
            }}
          />
        )}

        {/* Loading overlay */}
        {loading && !error && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/50">
            <div className="flex items-center gap-2 text-sm text-text-secondary">
              <RotateCcw className="size-4 animate-spin" />
              <span>Loading...</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
