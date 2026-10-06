import { useState, useEffect, useCallback, useRef, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import { Trash2, Brain, RefreshCw } from "@/lib/icons";
import { Separator } from "@/components/ui/separator";
import { PPMBotTelegramSection } from "./ppmbot-telegram-section";

interface PPMBotConfig {
  enabled: boolean;
  default_provider: string;
  system_prompt: string;
  show_tool_calls: boolean;
  show_thinking: boolean;
  permission_mode: string;
  debounce_ms: number;
}

interface MemoryRow {
  id: number;
  project: string;
  content: string;
  category: string;
  importance: number;
}

interface BotTaskRow {
  id: string;
  chat_id: string;
  project_name: string;
  prompt: string;
  status: string;
  result_summary: string | null;
  error: string | null;
  created_at: number;
  completed_at: number | null;
}

export function PPMBotSettingsSection() {
  const [config, setConfig] = useState<PPMBotConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: "ok" | "err"; msg: string } | null>(null);

  const [systemPrompt, setSystemPrompt] = useState("");
  const [showToolCalls, setShowToolCalls] = useState(true);
  const [showThinking, setShowThinking] = useState(false);
  const [debounceMs, setDebounceMs] = useState(2000);

  const [memories, setMemories] = useState<MemoryRow[]>([]);
  const [memoryProject, setMemoryProject] = useState("_global");

  const [tasks, setTasks] = useState<BotTaskRow[]>([]);
  const taskPollRef = useRef<ReturnType<typeof setInterval>>(undefined);

  const fetchMemories = useCallback(async (project = memoryProject) => {
    try {
      const data = await api.get<MemoryRow[]>(`/api/settings/clawbot/memories?project=${encodeURIComponent(project)}`);
      setMemories(data);
    } catch {}
  }, [memoryProject]);

  const fetchTasks = useCallback(async () => {
    try {
      const data = await api.get<BotTaskRow[]>("/api/settings/clawbot/tasks?limit=20");
      setTasks(data);
    } catch {}
  }, []);

  const deleteMemory = async (id: number) => {
    try {
      await api.del(`/api/settings/clawbot/memories/${id}`);
      setMemories((prev) => prev.filter((m) => m.id !== id));
    } catch {}
  };

  useEffect(() => {
    api.get<PPMBotConfig>("/api/settings/clawbot").then((data) => {
      setConfig(data);
      setSystemPrompt(data.system_prompt);
      setShowToolCalls(data.show_tool_calls);
      setShowThinking(data.show_thinking);
      setDebounceMs(data.debounce_ms);
    }).catch(() => {});
    fetchMemories("_global");
    fetchTasks();

    // Auto-refresh tasks every 10s
    taskPollRef.current = setInterval(fetchTasks, 10000);
    return () => { if (taskPollRef.current) clearInterval(taskPollRef.current); };
  }, [fetchMemories, fetchTasks]);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      // Not `enabled`: the switch above saves that by itself.
      const body: Partial<PPMBotConfig> = {
        system_prompt: systemPrompt,
        show_tool_calls: showToolCalls,
        show_thinking: showThinking,
        debounce_ms: debounceMs,
      };
      const data = await api.put<PPMBotConfig>("/api/settings/clawbot", body);
      setConfig(data);
      setStatus({ type: "ok", msg: "Saved" });
    } catch (e) {
      setStatus({ type: "err", msg: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  if (!config) return <p className="text-xs text-muted-foreground">Loading...</p>;

  const statusIcon: Record<string, string> = {
    pending: "⏳", running: "🔄", completed: "✅", failed: "❌", timeout: "⏱",
  };
  const statusColor: Record<string, string> = {
    running: "text-primary", completed: "text-success", failed: "text-destructive", timeout: "text-warning",
  };

  return (
    <div className="space-y-4">
      <PPMBotTelegramSection />

      <Separator />

      {/* Delegated Tasks */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium">Delegated Tasks</p>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 cursor-pointer"
            onClick={fetchTasks}
          >
            <RefreshCw className="size-3" />
          </Button>
        </div>

        {tasks.length === 0 ? (
          <p className="text-[10px] text-muted-foreground italic">
            No delegated tasks yet. The coordinator will create tasks when you ask it to work on a project.
          </p>
        ) : (
          <div className="space-y-1 max-h-[200px] overflow-y-auto">
            {tasks.map((t) => {
              const elapsed = t.completed_at
                ? `${Math.round((t.completed_at - t.created_at) / 60)}m`
                : `${Math.round((Date.now() / 1000 - t.created_at) / 60)}m`;
              return (
                <div
                  key={t.id}
                  className="flex items-center gap-2 rounded-md border p-2 text-[11px]"
                >
                  <span className={statusColor[t.status] ?? ""}>
                    {statusIcon[t.status] ?? "?"}
                  </span>
                  <span className="font-medium shrink-0">{t.project_name}</span>
                  <span className="truncate text-muted-foreground flex-1">
                    {t.prompt.slice(0, 60)}
                  </span>
                  <span className="text-[10px] text-muted-foreground shrink-0">{elapsed}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Separator />

      {/* Memory & Identity */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Brain className="size-3.5 text-muted-foreground" />
            <p className="text-xs font-medium">Memory & Identity</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 cursor-pointer"
            onClick={() => fetchMemories(memoryProject)}
          >
            <RefreshCw className="size-3" />
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Facts the bot remembers across sessions. Use /remember on Telegram to add, or delete here.
        </p>

        {memories.length === 0 ? (
          <p className="text-[10px] text-muted-foreground italic">
            No memories stored yet. Send /start on Telegram and introduce yourself.
          </p>
        ) : (
          <div className="space-y-1 max-h-[200px] overflow-y-auto">
            {memories.map((mem) => (
              <div
                key={mem.id}
                className="flex items-start justify-between rounded-md border p-2 gap-1"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] break-words">{mem.content}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {mem.category} · {mem.project}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 text-destructive hover:text-destructive cursor-pointer shrink-0"
                  onClick={() => deleteMemory(mem.id)}
                >
                  <Trash2 className="size-3" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <Separator />

      {/* System Prompt (coordinator override) */}
      <div className="space-y-1.5">
        <label className="text-[11px] text-muted-foreground">Custom Instructions</label>
        <textarea
          placeholder="Additional instructions for the coordinator (optional)..."
          value={systemPrompt}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setSystemPrompt(e.target.value)}
          className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-xs min-h-[60px] resize-y ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          rows={3}
        />
        <p className="text-[10px] text-muted-foreground">
          Extra instructions added to the coordinator identity. Leave empty to use defaults from coordinator.md.
        </p>
      </div>

      {/* Display Toggles */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs">Show tool calls</p>
          <Switch checked={showToolCalls} onCheckedChange={setShowToolCalls} />
        </div>
        <div className="flex items-center justify-between">
          <p className="text-xs">Show thinking</p>
          <Switch checked={showThinking} onCheckedChange={setShowThinking} />
        </div>
      </div>

      {/* Debounce */}
      <div className="space-y-1.5">
        <label className="text-[11px] text-muted-foreground">Debounce (ms)</label>
        <Input
          type="number"
          min={0}
          max={30000}
          step={500}
          value={debounceMs}
          onChange={(e) => setDebounceMs(Number(e.target.value))}
          className="h-7 text-xs w-24"
        />
        <p className="text-[10px] text-muted-foreground">
          Merge rapid messages within this window. 0 = no debounce.
        </p>
      </div>

      {/* Save */}
      <Button
        variant="default"
        size="sm"
        className="h-8 text-xs w-full cursor-pointer"
        disabled={saving}
        onClick={save}
      >
        {saving ? "Saving..." : "Save"}
      </Button>

      {status && (
        <p className={`text-[11px] ${status.type === "ok" ? "text-success" : "text-destructive"}`}>
          {status.msg}
        </p>
      )}
    </div>
  );
}
