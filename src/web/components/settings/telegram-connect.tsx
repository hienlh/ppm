/**
 * Connecting a Telegram chat with a one-time link, shared by Settings → Notifications and
 * Settings → PPMBot. Each has its own bot and its own endpoint; the flow is the same:
 * mint a link, show it (and a QR code on a desktop, whose Telegram is often on the
 * phone), and watch the status until a new chat appears or the link is spent.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { QRCodeSVG } from "qrcode.react";
import { ExternalLink, Loader2, Trash2 } from "@/lib/icons";
import { Button, buttonVariants } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import type { TelegramChatInfo } from "../../../shared/notification-settings";
import { IconButton } from "./settings-rows";

export interface ConnectLink {
  url: string;
  expiresAt: number;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * `endpoint` mints a link on POST and withdraws it on DELETE. `load` re-reads the
 * section's status, whose `chats` gain the chat that opens the link.
 */
export function useTelegramConnect<S extends { chats: TelegramChatInfo[]; connect: { active: boolean } }>(
  endpoint: string,
  status: S | null,
  load: () => Promise<S | null>,
) {
  const [link, setLink] = useState<ConnectLink | null>(null);
  const [starting, setStarting] = useState(false);
  const chatsBefore = useRef<Set<string>>(new Set());

  // While a link is out, watch for the chat that opens it.
  useEffect(() => {
    if (!link) return;
    const timer = setInterval(async () => {
      const next = await load();
      if (!next) return;
      const added = next.chats.find((c) => !chatsBefore.current.has(c.chatId));
      if (added) {
        setLink(null);
        toast.success(`Connected ${added.name}`);
      } else if (!next.connect.active) {
        // Spent by a chat that was already connected, or past its ten minutes.
        setLink(null);
        if (Date.now() >= link.expiresAt) toast.info("The link expired. Make a new one to connect.");
        else toast.success("Telegram connected");
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [link, load]);

  const connect = useCallback(async () => {
    setStarting(true);
    try {
      chatsBefore.current = new Set(status?.chats.map((c) => c.chatId));
      setLink(await api.post<ConnectLink>(endpoint));
      await load();
    } catch (e) {
      toast.error("Could not make a link", { description: errorText(e) });
    } finally {
      setStarting(false);
    }
  }, [endpoint, status, load]);

  const cancel = useCallback(async () => {
    setLink(null);
    await api.del(endpoint).catch(() => {});
  }, [endpoint]);

  return { link, starting, connect, cancel };
}

/** The connected chats, each with a Disconnect button. */
export function TelegramChatList({ chats, onDisconnect }: {
  chats: TelegramChatInfo[];
  onDisconnect: (chat: TelegramChatInfo) => void;
}) {
  if (chats.length === 0) return null;
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {chats.map((chat) => (
        <li key={chat.chatId} className="flex items-center gap-3 py-1.5 pl-4 pr-1">
          <span className="min-w-0 flex-1 truncate text-sm">{chat.name}</span>
          <IconButton label={`Disconnect ${chat.name}`} danger onClick={() => onDisconnect(chat)}>
            <Trash2 className="size-4" />
          </IconButton>
        </li>
      ))}
    </ul>
  );
}

export function ConnectCard({ link, botUsername, error, onCancel }: {
  link: ConnectLink;
  botUsername: string | null;
  error: string | null;
  onCancel: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.ceil((link.expiresAt - now) / 1000));
  const countdown = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;

  return (
    <div className="space-y-3 rounded-lg border border-primary/40 px-4 py-3">
      <p className="text-sm leading-relaxed">
        Open the link in Telegram and tap <b>Start</b>{botUsername ? <> in the chat with <b>@{botUsername}</b></> : null}.
        It connects one chat, once.
      </p>
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <a
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(buttonVariants(), "min-h-11 w-full gap-2 md:min-h-9 md:w-auto")}
        >
          Open Telegram
          <ExternalLink className="size-3.5" />
        </a>
        {/* A desktop's Telegram is often on the phone: the code gets the link there. */}
        <div className="hidden items-center gap-3 md:flex">
          <div className="rounded-md bg-white p-2">
            <QRCodeSVG value={link.url} size={112} bgColor="#ffffff" fgColor="#000000" level="L" style={{ display: "block" }} />
          </div>
          <p className="max-w-48 text-xs text-muted-foreground">Or scan it with the phone that has Telegram.</p>
        </div>
      </div>
      {error ? (
        <p className="text-xs text-error">{error}</p>
      ) : (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Waiting for Telegram… the link expires in {countdown}
        </p>
      )}
      <Button variant="ghost" onClick={onCancel} className="min-h-11 cursor-pointer md:min-h-9">Cancel</Button>
    </div>
  );
}
