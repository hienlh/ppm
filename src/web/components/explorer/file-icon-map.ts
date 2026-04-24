/**
 * File extension → icon + color mapping for the file tree explorer.
 * Extracted from file-tree.tsx for modularity.
 */
import {
  File,
  FileCode,
  FileJson,
  FileText,
  FileType,
  FileImage,
  FileVideo,
  FileAudio,
  FileSpreadsheet,
  FileArchive,
  Database,
} from "lucide-react";

export type FileIconInfo = { icon: React.ComponentType<{ className?: string }>; color?: string };

const FILE_ICON_MAP: Record<string, FileIconInfo> = {
  // Code
  ts: { icon: FileCode, color: "text-blue-400" }, tsx: { icon: FileCode, color: "text-blue-400" },
  js: { icon: FileCode, color: "text-yellow-400" }, jsx: { icon: FileCode, color: "text-yellow-400" },
  py: { icon: FileCode, color: "text-green-400" }, rs: { icon: FileCode, color: "text-orange-400" },
  go: { icon: FileCode, color: "text-cyan-400" }, c: { icon: FileCode, color: "text-blue-300" },
  cpp: { icon: FileCode, color: "text-blue-300" }, java: { icon: FileCode, color: "text-red-400" },
  rb: { icon: FileCode, color: "text-red-400" }, php: { icon: FileCode, color: "text-purple-400" },
  swift: { icon: FileCode, color: "text-orange-400" }, kt: { icon: FileCode, color: "text-purple-400" },
  dart: { icon: FileCode, color: "text-cyan-400" }, sh: { icon: FileCode, color: "text-green-300" },
  html: { icon: FileCode, color: "text-orange-400" }, css: { icon: FileCode, color: "text-blue-400" },
  scss: { icon: FileCode, color: "text-pink-400" },
  // Data
  json: { icon: FileJson, color: "text-yellow-400" },
  yaml: { icon: FileType, color: "text-orange-300" }, yml: { icon: FileType, color: "text-orange-300" },
  toml: { icon: FileType, color: "text-orange-300" }, ini: { icon: FileType, color: "text-orange-300" },
  env: { icon: FileType, color: "text-yellow-300" },
  csv: { icon: FileSpreadsheet, color: "text-green-400" },
  xls: { icon: FileSpreadsheet, color: "text-green-400" }, xlsx: { icon: FileSpreadsheet, color: "text-green-400" },
  // Text/Docs
  md: { icon: FileText, color: "text-text-secondary" }, txt: { icon: FileText, color: "text-text-secondary" },
  log: { icon: FileText, color: "text-text-subtle" }, pdf: { icon: FileText, color: "text-red-400" },
  // Images
  png: { icon: FileImage, color: "text-green-400" }, jpg: { icon: FileImage, color: "text-green-400" },
  jpeg: { icon: FileImage, color: "text-green-400" }, gif: { icon: FileImage, color: "text-green-400" },
  svg: { icon: FileImage, color: "text-yellow-400" }, webp: { icon: FileImage, color: "text-green-400" },
  ico: { icon: FileImage, color: "text-green-400" }, bmp: { icon: FileImage, color: "text-green-400" },
  // Video
  mp4: { icon: FileVideo, color: "text-purple-400" }, webm: { icon: FileVideo, color: "text-purple-400" },
  mov: { icon: FileVideo, color: "text-purple-400" }, avi: { icon: FileVideo, color: "text-purple-400" },
  mkv: { icon: FileVideo, color: "text-purple-400" },
  // Audio
  mp3: { icon: FileAudio, color: "text-pink-400" }, wav: { icon: FileAudio, color: "text-pink-400" },
  ogg: { icon: FileAudio, color: "text-pink-400" }, flac: { icon: FileAudio, color: "text-pink-400" },
  // Database
  db: { icon: Database, color: "text-amber-400" }, sqlite: { icon: Database, color: "text-amber-400" },
  sqlite3: { icon: Database, color: "text-amber-400" }, sql: { icon: Database, color: "text-amber-400" },
  // Archives
  zip: { icon: FileArchive, color: "text-amber-300" }, tar: { icon: FileArchive, color: "text-amber-300" },
  gz: { icon: FileArchive, color: "text-amber-300" }, rar: { icon: FileArchive, color: "text-amber-300" },
  "7z": { icon: FileArchive, color: "text-amber-300" },
};

const DEFAULT_FILE_ICON: FileIconInfo = { icon: File };

export function getFileIcon(name: string): FileIconInfo {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return FILE_ICON_MAP[ext] ?? DEFAULT_FILE_ICON;
}
