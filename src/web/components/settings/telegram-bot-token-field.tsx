/**
 * A Telegram bot token, with the steps to get one. Notifications and PPMBot each keep a
 * bot of their own, so each passes the endpoint its token is saved to.
 *
 * The server asks Telegram (`getMe`) before saving, so a mistyped token is refused here
 * rather than discovered when the first alert never arrives.
 */
import { useId, useState } from "react";
import { ChevronDown, ExternalLink } from "@/lib/icons";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";

interface SavedToken {
  bot_token: string;
  bot_username: string | null;
}

export function TelegramBotTokenField({
  configured,
  botUsername,
  onSaved,
  endpoint = "/api/settings/telegram",
  usernameExample = "my_ppm_bot",
}: {
  configured: boolean;
  botUsername: string | null;
  onSaved: (botUsername: string | null) => void;
  /** PUT `{ bot_token }` here; the server checks it with Telegram before keeping it. */
  endpoint?: string;
  usernameExample?: string;
}) {
  const inputId = useId();
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(!configured);

  const save = async () => {
    if (!token.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await api.put<SavedToken>(endpoint, { bot_token: token.trim() });
      setToken("");
      setGuideOpen(false);
      onSaved(saved.bot_username);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <label htmlFor={inputId} className="text-xs text-muted-foreground">
        {configured ? "Bot token — paste a new one to replace it" : "Bot token"}
      </label>
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Input
          id={inputId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={configured ? "••••••  (saved)" : "123456789:AA…"}
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            setError(null);
          }}
          className="h-11 w-full font-mono text-sm md:h-9"
        />
        <Button type="submit" disabled={saving || !token.trim()} className="min-h-11 shrink-0 cursor-pointer md:min-h-9">
          {saving ? "Checking…" : "Save"}
        </Button>
      </form>
      {error && <p className="text-xs text-error">{error}</p>}
      {configured && botUsername && (
        <p className="text-xs text-muted-foreground">
          Using{" "}
          <a href={`https://t.me/${botUsername}`} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline">
            @{botUsername}
          </a>
          .
        </p>
      )}

      <button
        type="button"
        onClick={() => setGuideOpen((open) => !open)}
        aria-expanded={guideOpen}
        className="flex min-h-11 cursor-pointer items-center gap-1 text-xs text-primary md:min-h-8"
      >
        <ChevronDown className={cn("size-3.5 transition-transform", !guideOpen && "-rotate-90")} />
        How to create a bot
      </button>
      {guideOpen && (
        <div className="space-y-3 rounded-lg border border-border px-4 py-3">
          <ol className="list-decimal space-y-1.5 pl-4 text-sm leading-relaxed">
            <li>Open <b>@BotFather</b> in Telegram.</li>
            <li>Send <code className="rounded bg-muted px-1 py-0.5 text-xs">/newbot</code>.</li>
            <li>Pick a display name, then a username ending in <b>bot</b>, such as <i>{usernameExample}</i>.</li>
            <li>BotFather replies with a token like <code className="rounded bg-muted px-1 py-0.5 text-xs">123456789:AA…</code>. Copy it and paste it above.</li>
          </ol>
          <p className="text-xs text-muted-foreground">
            Treat the token like a password: whoever has it controls the bot.
          </p>
          <a
            href="https://t.me/BotFather"
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonVariants({ variant: "outline" }), "min-h-11 w-full gap-2 md:min-h-9 sm:w-auto")}
          >
            Open @BotFather
            <ExternalLink className="size-3.5" />
          </a>
        </div>
      )}
    </div>
  );
}
