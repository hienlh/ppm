/**
 * The boundary above everything, so a render error is a message rather than a
 * blank page.
 *
 * React unmounts the entire tree when a throw reaches the root — `#root` is
 * emptied, and what is left on screen is the body's background gradient and
 * nothing else: no text, no button, no hint that a reload would help. That is
 * the white screen, and every lazily-loaded tab is one missing chunk away from
 * it (`tab-pool.tsx` alone has sixteen).
 *
 * Styled inline rather than with the app's classes. This is the fallback for
 * "the app failed to load its own code", and a stylesheet is code too: the one
 * component whose job is to work when something did not must not depend on a
 * chunk having arrived. The tokens are read with CSS fallbacks for the same
 * reason.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { isChunkLoadError, purgeAndReload } from "@/lib/chunk-recovery";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  stale: boolean;
}

const page: React.CSSProperties = {
  minHeight: "100dvh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
  // Its own background: if the stylesheet was the chunk that went missing,
  // `var(--bg)` on <body> resolves to nothing and dark-mode text would be
  // white on white.
  background: "var(--bg-solid, #0a0e17)",
  color: "var(--text, #eaeefb)",
  font: "16px/1.5 system-ui, sans-serif",
};

const card: React.CSSProperties = {
  width: "100%",
  maxWidth: "440px",
  background: "var(--panel, #141820)",
  border: "1px solid var(--border, rgba(255,255,255,0.12))",
  borderRadius: "var(--rad, 18px)",
  padding: "24px",
};

const button: React.CSSProperties = {
  // 44px is the touch-target floor in docs/design-guidelines.md, and this
  // button is the only way out of the screen it appears on.
  minHeight: "44px",
  width: "100%",
  marginTop: "20px",
  padding: "0 20px",
  border: "none",
  borderRadius: "var(--rad-sm, 12px)",
  background: "var(--accent, #5b8cff)",
  color: "var(--accent-fg, #fff)",
  font: "inherit",
  fontWeight: 600,
  cursor: "pointer",
};

const details: React.CSSProperties = {
  marginTop: "16px",
  maxHeight: "8lh",
  overflow: "auto",
  color: "var(--text-2, #9aa6c2)",
  fontFamily: "ui-monospace, monospace",
  fontSize: "13px",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

export class RootErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, stale: false };

  static getDerivedStateFromError(error: Error): State {
    return { error, stale: isChunkLoadError(error) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ppm] unhandled render error", error, info.componentStack);
  }

  override render() {
    const { error, stale } = this.state;
    if (!error) return this.props.children;

    return (
      <div style={page}>
        <div style={card} role="alert">
          <h1 style={{ margin: 0, fontSize: "18px", fontWeight: 600 }}>
            {stale ? "PPM has been updated" : "Something went wrong"}
          </h1>
          <p style={{ margin: "12px 0 0", color: "var(--text-2, #9aa6c2)" }}>
            {stale
              ? "This tab is still running an older version and asked for a file that no longer exists. Reloading picks up the new one."
              : "The page could not finish rendering. Reloading usually clears it."}
          </p>
          {/* The message, not the stack: the stack is a minified chunk name and
              tells the person reading it nothing, while `console.error` above
              has kept the whole thing for anyone who opens devtools. */}
          {!stale && <div style={details}>{error.message}</div>}
          <button type="button" style={button} onClick={() => void purgeAndReload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
