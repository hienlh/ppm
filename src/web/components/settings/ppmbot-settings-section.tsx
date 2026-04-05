import { useState, useEffect, useCallback, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import { Trash2, CheckCircle, Clock } from "lucide-react";

interface PPMBotConfig {
  enabled: boolean;
  default_provider: string;
  default_project: string;
  system_prompt: string;
  show_tool_calls: boolean;
  show_thinking: boolean;
  permission_mode: string;
  debounce_ms: number;
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

export function PPMBotSettingsSection() {
  const [config, setConfig] = useState<PPMBotConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: "ok" | "err"; msg: string } | null>(null);

  const [enabled, setEnabled] = useState(false);
  const [defaultProject, setDefaultProject] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [showToolCalls, setShowToolCalls] = useState(true);
  const [showThinking, setShowThinking] = useState(false);
  const [debounceMs, setDebounceMs] = useState(2000);

  const [pairedChats, setPairedChats] = useState<PairedChat[]>([]);
  const [approveCode, setApproveCode] = useState("");
  const [approving, setApproving] = useState(false);

  const fetchPairedChats = useCallback(async () => {
    try {
      const data = await api.get<PairedChat[]>("/api/settings/clawbot/paired");
      setPairedChats(data);
    } catch {}
  }, []);

  useEffect(() => {
    api.get<PPMBotConfig>("/api/settings/clawbot").then((data) => {
      setConfig(data);
      setEnabled(data.enabled);
      setDefaultProject(data.default_project);
      setSystemPrompt(data.system_prompt);
      setShowToolCalls(data.show_tool_calls);
      setShowThinking(data.show_thinking);
      setDebounceMs(data.debounce_ms);
    }).catch(() => {});
    fetchPairedChats();
  }, [fetchPairedChats]);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const body: Partial<PPMBotConfig> = {
        enabled,
        default_project: defaultProject.trim(),
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

  if (!config) return <p className="text-xs text-muted-foreground">Loading...</p>;

  return (
    <div className="space-y-4">
      {/* Enable/Disable */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium">Enable PPMBot</p>
          <p className="text-[10px] text-muted-foreground">
            Telegram bot that chats with your AI providers
          </p>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </div>

      {/* Paired Devices */}
      <div className="space-y-2">
        <p className="text-xs font-medium">Paired Devices</p>
        <p className="text-[10px] text-muted-foreground">
          Send any message to the bot on Telegram to get a pairing code. Enter it below to approve.
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
      </div>

      {/* Default Project */}
      <div className="space-y-1.5">
        <label className="text-[11px] text-muted-foreground">Default Project</label>
        <Input
          placeholder="my-project"
          value={defaultProject}
          onChange={(e) => setDefaultProject(e.target.value)}
          className="h-7 text-xs"
        />
        <p className="text-[10px] text-muted-foreground">
          Project used when starting a new chat. Must match a project name in PPM.
        </p>
      </div>

      {/* System Prompt */}
      <div className="space-y-1.5">
        <label className="text-[11px] text-muted-foreground">System Prompt</label>
        <textarea
          placeholder="You are a helpful assistant..."
          value={systemPrompt}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setSystemPrompt(e.target.value)}
          className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-xs min-h-[60px] resize-y ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          rows={3}
        />
        <p className="text-[10px] text-muted-foreground">
          Custom personality/instructions prepended to each session.
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
