import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WsClient } from "../lib/ws-client";

interface UseTerminalOptions {
  terminalId: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

export function useTerminal({ terminalId, containerRef }: UseTerminalOptions) {
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WsClient | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      theme: {
        background: "#1e1e2e",
        foreground: "#cdd6f4",
      },
    });
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(el);
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/terminal/${terminalId}`;
    const ws = new WsClient(wsUrl);
    wsRef.current = ws;

    ws.onMessage((evt) => {
      term.write(typeof evt.data === "string" ? evt.data : new Uint8Array(evt.data as ArrayBuffer));
    });

    ws.onOpen(() => {
      fitAddon.fit();
      const { cols, rows } = term;
      ws.send(`\x01RESIZE:${cols},${rows}`);
    });

    ws.connect();

    term.onData((data) => {
      ws.send(data);
    });

    const observer = new ResizeObserver(() => {
      fitAddon.fit();
      const { cols, rows } = term;
      if (ws) ws.send(`\x01RESIZE:${cols},${rows}`);
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
      ws.disconnect();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      wsRef.current = null;
    };
  // containerRef is stable (useRef), terminalId should be stable per tab
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId]);
}
