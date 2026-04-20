import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import "./styles/globals.css";
import "katex/dist/katex.min.css";
// Highlight.js themes are loaded dynamically by applyThemeClass() to match light/dark mode

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
