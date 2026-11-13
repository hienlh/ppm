import { RpcChannel, type RpcLog } from "./extension-rpc.ts";
import type { RpcMessage } from "../types/extension.ts";

/** The part of a Worker the channel uses; a fake stands in for it in tests. */
export interface ExtensionWorkerPort {
  postMessage(msg: RpcMessage): void;
  addEventListener(type: "message", listener: (event: MessageEvent<RpcMessage>) => void): void;
}

/**
 * The main thread's RPC channel to one extension host worker, bound to that worker for life.
 *
 * Every channel numbers its requests from 1, so after a rebuild the old worker and the new one
 * use the same ids. Two things keep them apart. The message listener hands this worker's
 * messages to this worker's channel only — reading the service's *current* channel there let a
 * late reply from the dead worker settle the new worker's request with the same id. And the
 * post function sends nothing once `isCurrent()` says this worker was replaced, which is what
 * catches a handler that finishes after the rebuild and would otherwise answer a worker that
 * no longer exists.
 *
 * `handleMessage` is not awaited by the event listener, so its rejection — a reply that cannot
 * be cloned, a post to a terminated worker — is caught here. Unhandled rejections on the main
 * thread count toward the server's crash limit.
 */
export function openWorkerChannel(
  worker: ExtensionWorkerPort,
  isCurrent: () => boolean,
  log: RpcLog,
): RpcChannel {
  const rpc = new RpcChannel((msg) => {
    if (!isCurrent()) {
      log.debug(`dropped ${describe(msg)} for an extension host that was replaced`);
      return;
    }
    worker.postMessage(msg);
  }, log);
  worker.addEventListener("message", (event) => {
    rpc.handleMessage(event.data).catch((e) => log.error("extension host message failed:", e));
  });
  return rpc;
}

function describe(msg: RpcMessage): string {
  if (msg.type === "request") return `request ${msg.method}`;
  if (msg.type === "event") return `event ${msg.event}`;
  return `response #${msg.id}`;
}
