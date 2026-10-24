import React from "react";
import { createRoot } from "react-dom/client";
import { WebPreviewTab } from "../../../src/web/components/web-preview/web-preview-tab";

createRoot(document.getElementById("root")!).render(
  <WebPreviewTab metadata={{ url: new URLSearchParams(location.search).get("url"), via: "tailscale" }} />,
);
