import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import "./styles/globals.css";
import "katex/dist/katex.min.css";
// Highlight.js themes are loaded dynamically by applyThemeClass() to match light/dark mode

// Patch DOM methods to prevent React crash when browser extensions
// (Grammarly, password managers, etc.) or rehype-raw modify the DOM tree
// outside React's knowledge. See: https://github.com/facebook/react/issues/11538
if (typeof Node !== "undefined") {
  const origRemoveChild = Node.prototype.removeChild;
  Node.prototype.removeChild = function <T extends Node>(child: T): T {
    if (child.parentNode !== this) return child;
    return origRemoveChild.call(this, child) as T;
  };
  const origInsertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function <T extends Node>(node: T, ref: Node | null): T {
    if (ref && ref.parentNode !== this) return node;
    return origInsertBefore.call(this, node, ref) as T;
  };
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
