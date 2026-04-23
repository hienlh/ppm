import { ChevronLeft, ChevronRight } from "lucide-react";

interface PaginationProps {
  total: number;
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

/** Pagination footer for Glide Data Grid — row count + page nav */
export function GlideGridPagination({ total, page, totalPages, onPageChange }: PaginationProps) {
  return (
    <div className="flex items-center justify-between px-3 py-1.5 border-t border-border bg-background shrink-0 text-xs text-muted-foreground">
      <span>{total.toLocaleString()} rows</span>
      {/* Shortcut hints — desktop only */}
      <div className="hidden md:flex items-center gap-2 text-[10px] text-muted-foreground/50">
        <span><kbd className="px-1 py-0.5 rounded bg-muted text-[9px]">/</kbd> columns</span>
        <span><kbd className="px-1 py-0.5 rounded bg-muted text-[9px]">{"\u2318"}A</kbd> select all</span>
        <span><kbd className="px-1 py-0.5 rounded bg-muted text-[9px]">{"\u2318"}C</kbd> copy</span>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)}
          className="p-0.5 rounded hover:bg-muted disabled:opacity-30">
          <ChevronLeft className="size-3.5" />
        </button>
        <span>{page} / {totalPages}</span>
        <button type="button" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}
          className="p-0.5 rounded hover:bg-muted disabled:opacity-30">
          <ChevronRight className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
