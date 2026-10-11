/**
 * What the old PPMBot remembered (`GET /api/assistant/telegram/legacy-memories`), shown beside
 * the Assistant's instructions so the user can carry over the facts worth keeping.
 *
 * Nothing here is copied on its own. Those memories were written by the AI, possibly from
 * text a chat fed it, and instructions are the most trusted thing the Assistant reads — so a
 * memory reaches them only when the user presses Copy, and only into the unsaved draft, where
 * it can be read and edited before Save. Hidden entirely when there is nothing to show.
 */
import { useEffect, useState } from "react";
import { Check, ChevronDown, Copy } from "@/lib/icons";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";

export interface LegacyMemory {
  id: number;
  /** `_global` when the memory was not tied to a project. */
  project: string;
  category: string;
  content: string;
  /** Epoch milliseconds. */
  createdAt: number;
}

/** Narrows the server's list; a malformed row is dropped rather than rendered. */
export function parseLegacyMemories(raw: unknown): LegacyMemory[] {
  const list = raw && typeof raw === "object" ? (raw as { memories?: unknown }).memories : undefined;
  if (!Array.isArray(list)) return [];
  return list.flatMap((m): LegacyMemory[] => {
    if (!m || typeof m !== "object") return [];
    const r = m as Record<string, unknown>;
    if (typeof r.id !== "number" || typeof r.content !== "string" || !r.content.trim()) return [];
    return [{
      id: r.id,
      project: typeof r.project === "string" ? r.project : "_global",
      category: typeof r.category === "string" ? r.category : "",
      content: r.content.trim(),
      createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
    }];
  });
}

/** The instructions with `content` added as a line of its own. */
export function appendToInstructions(instructions: string, content: string): string {
  const base = instructions.trimEnd();
  return base ? `${base}\n${content}` : content;
}

export function AssistantLegacyMemories({ instructions, disabled, onCopy }: {
  /** The draft, so a memory already in it reads as copied. */
  instructions: string;
  disabled?: boolean;
  onCopy: (content: string) => void;
}) {
  const [memories, setMemories] = useState<LegacyMemory[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let active = true;
    api.get<unknown>("/api/assistant/telegram/legacy-memories")
      .then((data) => { if (active) setMemories(parseLegacyMemories(data)); })
      // A server without the list (or a failure reading it) simply has nothing to offer here.
      .catch(() => { if (active) setMemories([]); });
    return () => { active = false; };
  }, []);

  if (memories.length === 0) return null;

  return (
    <div className="mt-2 rounded-md border border-border" data-testid="assistant-legacy-memories">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 w-full cursor-pointer items-center gap-2 px-3 text-left md:min-h-9"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm md:text-xs">Remembered by PPMBot ({memories.length})</span>
          <span className="block text-xs text-text-subtle">
            Written by the old bot's AI, so none is used unless you copy it into your instructions.
          </span>
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-text-subtle transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ul className="max-h-72 divide-y divide-border overflow-y-auto border-t border-border">
          {memories.map((m) => {
            const copied = instructions.includes(m.content);
            return (
              <li key={m.id} className="flex items-start gap-2 py-2 pl-3 pr-1">
                <span className="min-w-0 flex-1">
                  <span className="block whitespace-pre-wrap break-words text-sm leading-relaxed md:text-xs">{m.content}</span>
                  <span className="block text-xs text-text-subtle">
                    {[m.category, m.project === "_global" ? null : m.project].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <button
                  type="button"
                  disabled={disabled || copied}
                  onClick={() => onCopy(m.content)}
                  className="flex min-h-11 shrink-0 cursor-pointer items-center gap-1 rounded-md px-3 text-xs text-text-secondary hover:bg-surface-elevated active:bg-surface-elevated disabled:cursor-default disabled:opacity-60 md:min-h-8"
                >
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  {copied ? "Copied" : "Copy to instructions"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
