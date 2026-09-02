import { api, projectUrl } from "./api-client";
import { basename } from "./utils";

/** Trigger browser-native file download via hidden <a> tag */
export async function downloadFile(projectName: string, filePath: string): Promise<void> {
  // Absolute paths (external files opened from filesystem browser) use /api/fs routes
  const isAbsolute = /^(\/|[A-Za-z]:[/\\])/.test(filePath);
  if (isAbsolute) {
    // The token is issued for this exact file and spent on first use.
    const { token } = await api.post<{ token: string }>("/api/fs/download/token", { path: filePath });
    const url = `/api/fs/raw?path=${encodeURIComponent(filePath)}&download=true&dl_token=${encodeURIComponent(token)}`;
    triggerDownload(url, basename(filePath));
    return;
  }
  const { token } = await api.post<{ token: string }>(`${projectUrl(projectName)}/files/download/token`);
  const url = `${projectUrl(projectName)}/files/raw?path=${encodeURIComponent(filePath)}&download=true&dl_token=${encodeURIComponent(token)}`;
  triggerDownload(url, basename(filePath));
}

/** Trigger browser-native folder zip download */
export async function downloadFolder(projectName: string, folderPath: string): Promise<void> {
  const { token } = await api.post<{ token: string }>(`${projectUrl(projectName)}/files/download/token`);
  const folderName = basename(folderPath) || "folder";
  const url = `${projectUrl(projectName)}/files/download/zip?path=${encodeURIComponent(folderPath)}&dl_token=${encodeURIComponent(token)}`;
  triggerDownload(url, `${folderName}.zip`);
}

/** Hidden <a> tag download trigger — avoids popup blockers */
export function triggerDownload(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
