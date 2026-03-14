import { useEffect, useRef, useCallback } from "react";
import { WsClient } from "@/lib/ws-client";

interface UseWebSocketOptions {
  url: string;
  onMessage?: (event: MessageEvent) => void;
  autoConnect?: boolean;
}

export function useWebSocket({
  url,
  onMessage,
  autoConnect = true,
}: UseWebSocketOptions) {
  const clientRef = useRef<WsClient | null>(null);

  useEffect(() => {
    const client = new WsClient(url);
    clientRef.current = client;

    if (onMessage) {
      client.onMessage(onMessage);
    }

    if (autoConnect) {
      client.connect();
    }

    return () => {
      client.disconnect();
      clientRef.current = null;
    };
  }, [url, autoConnect]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = useCallback((data: string | ArrayBuffer) => {
    clientRef.current?.send(data);
  }, []);

  const connect = useCallback(() => {
    clientRef.current?.connect();
  }, []);

  const disconnect = useCallback(() => {
    clientRef.current?.disconnect();
  }, []);

  return { send, connect, disconnect };
}
