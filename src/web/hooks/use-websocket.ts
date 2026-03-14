import { useEffect, useRef, useState } from "react";
import { WsClient } from "../lib/ws-client";

interface UseWebSocketResult {
  send: (data: string | ArrayBuffer) => void;
  lastMessage: MessageEvent | null;
  connected: boolean;
}

export function useWebSocket(url: string): UseWebSocketResult {
  const clientRef = useRef<WsClient | null>(null);
  const [lastMessage, setLastMessage] = useState<MessageEvent | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const client = new WsClient(url);
    clientRef.current = client;

    const unsubMsg = client.onMessage((evt) => setLastMessage(evt));
    const unsubOpen = client.onOpen(() => setConnected(true));
    const unsubClose = client.onClose(() => setConnected(false));

    client.connect();

    return () => {
      unsubMsg();
      unsubOpen();
      unsubClose();
      client.disconnect();
      clientRef.current = null;
    };
  }, [url]);

  const send = (data: string | ArrayBuffer) => {
    clientRef.current?.send(data);
  };

  return { send, lastMessage, connected };
}
