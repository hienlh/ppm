import { useState, useEffect } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";

interface TelegramConfig {
  bot_token: string;
  chat_id: string;
}

export function TelegramSettingsSection() {
  const [config, setConfig] = useState<TelegramConfig>({ bot_token: "", chat_id: "" });
  const [tokenInput, setTokenInput] = useState("");
  const [chatIdInput, setChatIdInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{ type: "ok" | "err"; msg: string } | null>(null);

  useEffect(() => {
    api.get<TelegramConfig>("/api/settings/telegram").then((data) => {
      setConfig(data);
      setChatIdInput(data.chat_id);
    }).catch(() => {});
  }, []);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const body: Record<string, string> = { chat_id: chatIdInput };
      if (tokenInput) body.bot_token = tokenInput;
      const data = await api.put<TelegramConfig>("/api/settings/telegram", body);
      setConfig(data);
      setTokenInput("");
      setStatus({ type: "ok", msg: "Saved" });
    } catch (e) {
      setStatus({ type: "err", msg: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setStatus(null);
    try {
      // Send current input values; backend falls back to saved config for empty fields
      await api.post("/api/settings/telegram/test", {
        ...(tokenInput ? { bot_token: tokenInput } : {}),
        ...(chatIdInput ? { chat_id: chatIdInput } : {}),
      });
      setStatus({ type: "ok", msg: "Test message sent!" });
    } catch (e) {
      setStatus({ type: "err", msg: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const isConfigured = !!config.bot_token;

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <label className="text-[11px] text-text-subtle">Bot Token</label>
        <Input
          type="password"
          placeholder={isConfigured ? "••••••  (saved)" : "123456:ABC-DEF..."}
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          className="h-7 text-xs"
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-[11px] text-text-subtle">Chat ID</label>
        <Input
          placeholder="-1001234567890"
          value={chatIdInput}
          onChange={(e) => setChatIdInput(e.target.value)}
          className="h-7 text-xs"
        />
        <p className="text-[10px] text-text-subtle">Personal or group chat ID</p>
      </div>
      <div className="flex gap-1.5">
        <Button
          variant="default"
          size="sm"
          className="h-7 text-xs flex-1"
          disabled={saving || (!tokenInput && !chatIdInput)}
          onClick={save}
        >
          {saving ? "..." : "Save"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs gap-1"
          disabled={testing || !isConfigured}
          onClick={test}
        >
          <Send className="size-3" />
          {testing ? "..." : "Test"}
        </Button>
      </div>
      {status && (
        <p className={`text-[11px] ${status.type === "ok" ? "text-green-600 dark:text-green-400" : "text-destructive"}`}>
          {status.msg}
        </p>
      )}
    </div>
  );
}
