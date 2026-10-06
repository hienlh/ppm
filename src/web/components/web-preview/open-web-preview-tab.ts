import { useTabStore } from "@/stores/tab-store";
import { previewTitle } from "@/lib/web-preview-url";
import type { TunnelVia } from "@/lib/api-tunnels";

/** Open (or focus) a forwarded dev server in a web-preview tab. */
export function openWebPreviewTab(forward: { url: string; port: number | null; via: TunnelVia }): void {
  useTabStore.getState().openTab({
    type: "web-preview",
    title: previewTitle(forward.port, forward.url),
    projectId: null,
    closable: true,
    metadata: { url: forward.url, port: forward.port, via: forward.via },
  });
}
