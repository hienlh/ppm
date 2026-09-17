import { useEffect, useRef, useCallback } from "react";
import { WsClient, type WsClientOptions } from "@/lib/ws-client";

interface UseWebSocketOptions extends WsClientOptions {
  url: string;
  onMessage?: (event: MessageEvent) => void;
  autoConnect?: boolean;
}

export function useWebSocket({
  url,
  onMessage,
  autoConnect = true,
  idleTimeoutMs,
  onConnectionChange,
}: UseWebSocketOptions) {
  const clientRef = useRef<WsClient | null>(null);
  const onMessageRef = useRef(onMessage);
  const onConnectionChangeRef = useRef(onConnectionChange);
  onMessageRef.current = onMessage;
  onConnectionChangeRef.current = onConnectionChange;

  useEffect(() => {
    let active = true;
    const client = new WsClient(url, {
      idleTimeoutMs,
      onConnectionChange: (connected) => {
        if (active) onConnectionChangeRef.current?.(connected);
      },
    });
    clientRef.current = client;

    client.onMessage((event) => onMessageRef.current?.(event));

    if (autoConnect) {
      client.connect();
    }

    return () => {
      // Replacing a session socket is intentional, not a connection failure.
      // The old client's cleanup must not update the new session's UI.
      active = false;
      client.disconnect();
      clientRef.current = null;
    };
  }, [url, autoConnect, idleTimeoutMs]);

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
