/**
 * The history list's status filter and the auto-archive rule, per device (`src/shared/session-archive.ts`).
 */
import { create } from "zustand";
import { SESSION_STATUS_FILTERS, type SessionStatusFilter } from "../../shared/session-archive";

const FILTER_KEY = "ppm.chatHistory.status";
const AUTO_KEY = "ppm.chatHistory.autoArchiveDays";
/** The auto-archive choices Settings offers; 0 = never. */
export const AUTO_ARCHIVE_DAYS = [0, 7, 14, 30, 90] as const;

function read<T>(key: string, parse: (v: string) => T | null, fallback: T): T {
  try {
    const v = globalThis.localStorage?.getItem(key);
    return (v != null ? parse(v) : null) ?? fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: string): void {
  try { globalThis.localStorage?.setItem(key, value); } catch { /* private mode: this session only */ }
}

interface ChatHistoryFilterState {
  status: SessionStatusFilter;
  autoArchiveDays: number;
  setStatus: (status: SessionStatusFilter) => void;
  setAutoArchiveDays: (days: number) => void;
}

export const useChatHistoryFilter = create<ChatHistoryFilterState>((set) => ({
  status: read(FILTER_KEY, (v) => (SESSION_STATUS_FILTERS as readonly string[]).includes(v) ? v as SessionStatusFilter : null, "active"),
  autoArchiveDays: read(AUTO_KEY, (v) => (AUTO_ARCHIVE_DAYS as readonly number[]).includes(Number(v)) ? Number(v) : null, 0),
  setStatus: (status) => { write(FILTER_KEY, status); set({ status }); },
  setAutoArchiveDays: (days) => { write(AUTO_KEY, String(days)); set({ autoArchiveDays: days }); },
}));
