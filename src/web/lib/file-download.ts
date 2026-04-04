import { api, projectUrl } from "./api-client";

/** Trigger browser-native file download via hidden <a> tag */
export async function downloadFile(projectName: string, filePath: string): Promise<void> {
  const { token } = await api.post<{ token: string }>(`${projectUrl(projectName)}/files/download/token`);
  const url = `${projectUrl(projectName)}/files/raw?path=${encodeURIComponent(filePath)}&download=true&dl_token=${encodeURIComponent(token)}`;
  triggerDownload(url, filePath.split("/").pop() ?? "download");
}

/** Trigger browser-native folder zip download */
export async function downloadFolder(projectName: string, folderPath: string): Promise<void> {
  const { token } = await api.post<{ token: string }>(`${projectUrl(projectName)}/files/download/token`);
  const folderName = folderPath.split("/").pop() ?? "folder";
  const url = `${projectUrl(projectName)}/files/download/zip?path=${encodeURIComponent(folderPath)}&dl_token=${encodeURIComponent(token)}`;
  triggerDownload(url, `${folderName}.zip`);
}

/** Hidden <a> tag download trigger — avoids popup blockers */
function triggerDownload(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
