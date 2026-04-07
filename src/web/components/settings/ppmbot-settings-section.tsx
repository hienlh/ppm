import { useState, useEffect, useCallback, useRef, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import { Trash2, CheckCircle, Clock, Send, Brain, RefreshCw } from "lucide-react";
import { Separator } from "@/components/ui/separator";

interface PPMBotConfig {
  enabled: boolean;
  default_provider: string;
  system_prompt: string;
  show_tool_calls: boolean;
  show_thinking: boolean;
  permission_mode: string;
  debounce_ms: number;
}

interface TelegramConfig {
  bot_token: string;
}

interface MemoryRow {
  id: number;
  project: string;
  content: string;
  category: string;
  importance: number;
}

interface PairedChat {
  id: number;
  telegram_chat_id: string;
  telegram_user_id: string | null;
  display_name: string | null;
  pairing_code: string | null;
  status: "pending" | "approved";
  created_at: number;
  approved_at: number | null;
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

  const [tokenInput, setTokenInput] = useState("");
  const [tokenConfigured, setTokenConfigured] = useState(false);
  const [tokenSaving, setTokenSaving] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [showToolCalls, setShowToolCalls] = useState(true);
  const [showThinking, setShowThinking] = useState(false);
  const [debounceMs, setDebounceMs] = useState(2000);

  const [pairedChats, setPairedChats] = useState<PairedChat[]>([]);
  const [approveCode, setApproveCode] = useState("");
  const [approving, setApproving] = useState(false);
  const [testing, setTesting] = useState(false);

  const [memories, setMemories] = useState<MemoryRow[]>([]);
  const [memoryProject, setMemoryProject] = useState("_global");

  const [tasks, setTasks] = useState<BotTaskRow[]>([]);
  const taskPollRef = useRef<ReturnType<typeof setInterval>>(undefined);

  const fetchPairedChats = useCallback(async () => {
    try {
      const data = await api.get<PairedChat[]>("/api/settings/clawbot/paired");
      setPairedChats(data);
    } catch {}
  }, []);

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
      setEnabled(data.enabled);
      setSystemPrompt(data.system_prompt);
      setShowToolCalls(data.show_tool_calls);
      setShowThinking(data.show_thinking);
      setDebounceMs(data.debounce_ms);
    }).catch(() => {});
    api.get<TelegramConfig>("/api/settings/telegram").then((data) => {
      setTokenConfigured(!!data.bot_token);
    }).catch(() => {});
    fetchPairedChats();
    fetchMemories("_global");
    fetchTasks();

    // Auto-refresh tasks every 10s
    taskPollRef.current = setInterval(fetchTasks, 10000);
    return () => { if (taskPollRef.current) clearInterval(taskPollRef.current); };
  }, [fetchPairedChats, fetchMemories, fetchTasks]);

  const saveToken = async () => {
    if (!tokenInput.trim()) return;
    setTokenSaving(true);
    setStatus(null);
    try {
      await api.put<TelegramConfig>("/api/settings/telegram", { bot_token: tokenInput });
      setTokenConfigured(true);
      setTokenInput("");
      setStatus({ type: "ok", msg: "Bot token saved" });
    } catch (e) {
      setStatus({ type: "err", msg: (e as Error).message });
    } finally {
      setTokenSaving(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const body: Partial<PPMBotConfig> = {
        enabled,
        system_prompt: systemPrompt,
        show_tool_calls: showToolCalls,
        show_thinking: showThinking,
        debounce_ms: debounceMs,
      };
      const data = await api.put<PPMBotConfig>("/api/settings/clawbot", body);
      setConfig(data);
      setStatus({ type: "ok", msg: enabled ? "Saved — bot started" : "Saved — bot stopped" });
    } catch (e) {
      setStatus({ type: "err", msg: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const handleApprovePairing = async () => {
    if (!approveCode.trim()) return;
    setApproving(true);
    try {
      await api.post("/api/settings/clawbot/paired/approve", { code: approveCode.trim().toUpperCase() });
      setApproveCode("");
      await fetchPairedChats();
      setStatus({ type: "ok", msg: "Device approved" });
    } catch (e) {
      setStatus({ type: "err", msg: (e as Error).message });
    } finally {
      setApproving(false);
    }
  };

  const handleRevokePairing = async (chatId: string) => {
    try {
      await api.del(`/api/settings/clawbot/paired/${chatId}`);
      await fetchPairedChats();
      setStatus({ type: "ok", msg: "Device revoked" });
    } catch (e) {
      setStatus({ type: "err", msg: (e as Error).message });
    }
  };

  const handleTestNotification = async () => {
    setTesting(true);
    setStatus(null);
    try {
      await api.post("/api/settings/telegram/test", {});
      setStatus({ type: "ok", msg: "Test notification sent to all paired devices!" });
    } catch (e) {
      setStatus({ type: "err", msg: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  if (!config) return <p className="text-xs text-muted-foreground">Loading...</p>;

  const approvedCount = pairedChats.filter((c) => c.status === "approved").length;

  const statusIcon: Record<string, string> = {
    pending: "⏳", running: "🔄", completed: "✅", failed: "❌", timeout: "⏱",
  };
  const statusColor: Record<string, string> = {
    running: "text-blue-500", completed: "text-green-500", failed: "text-destructive", timeout: "text-yellow-500",
  };

  return (
    <div className="space-y-4">
      {/* Bot Token */}
      <div className="space-y-1.5">
        <label className="text-[11px] text-muted-foreground">Telegram Bot Token</label>
        <div className="flex gap-1.5">
          <Input
            type="password"
            placeholder={tokenConfigured ? "••••••  (saved)" : "123456:ABC-DEF..."}
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            className="h-7 text-xs flex-1"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs shrink-0 cursor-pointer"
            disabled={tokenSaving || !tokenInput.trim()}
            onClick={saveToken}
          >
            {tokenSaving ? "..." : "Save"}
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Create a bot via <b>@BotFather</b> on Telegram. Used for both chat and notifications.
        </p>
      </div>

      {/* Enable/Disable */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium">Enable PPMBot</p>
          <p className="text-[10px] text-muted-foreground">
            AI coordinator on Telegram — delegates tasks to your projects
          </p>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </div>

      {/* Paired Devices */}
      <div className="space-y-2">
        <p className="text-xs font-medium">Paired Devices</p>
        <p className="text-[10px] text-muted-foreground">
          Send any message to the bot on Telegram to get a pairing code. Enter it below to approve.
          Notifications are sent to all approved devices.
        </p>

        <div className="flex gap-2">
          <Input
            placeholder="Enter pairing code (e.g. A3K7WR)"
            value={approveCode}
            onChange={(e) => setApproveCode(e.target.value.toUpperCase())}
            className="h-8 text-xs font-mono tracking-wider uppercase"
            maxLength={6}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs shrink-0 cursor-pointer"
            disabled={approving || approveCode.length < 6}
            onClick={handleApprovePairing}
          >
            {approving ? "..." : "Approve"}
          </Button>
        </div>

        {pairedChats.length === 0 ? (
          <p className="text-[10px] text-muted-foreground italic">No paired devices yet.</p>
        ) : (
          <div className="space-y-1">
            {pairedChats.map((chat) => (
              <div
                key={chat.id}
                className="flex items-center justify-between rounded-md border p-2"
              >
                <div className="flex items-center gap-2 min-w-0">
                  {chat.status === "approved" ? (
                    <CheckCircle className="size-3.5 text-green-500 shrink-0" />
                  ) : (
                    <Clock className="size-3.5 text-yellow-500 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="text-xs truncate">
                      {chat.display_name || `Chat ${chat.telegram_chat_id}`}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {chat.status === "pending" && chat.pairing_code
                        ? `Code: ${chat.pairing_code}`
                        : chat.status}
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-destructive hover:text-destructive cursor-pointer"
                  onClick={() => handleRevokePairing(chat.telegram_chat_id)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Test notification button */}
        {tokenConfigured && approvedCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1 w-full cursor-pointer"
            disabled={testing}
            onClick={handleTestNotification}
          >
            <Send className="size-3" />
            {testing ? "Sending..." : "Test Notification"}
          </Button>
        )}
      </div>

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
        <p className={`text-[11px] ${status.type === "ok" ? "text-green-600 dark:text-green-400" : "text-destructive"}`}>
          {status.msg}
        </p>
      )}
    </div>
  );
}
