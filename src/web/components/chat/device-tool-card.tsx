/**
 * Card surfaces for the tab server's tools that take no file: `open_url`, `read_terminal` and
 * `run_in_terminal`. Rendered by `tool-cards.tsx`; the call is read by `@/lib/tab-tool-call`.
 * The command `run_in_terminal` typed is shown in full: it is what the user's Enter runs.
 */
import { OPEN_URL_TOOL, RUN_IN_TERMINAL_TOOL } from "../../../shared/tab-open-protocol";
import type { DeviceToolCall } from "@/lib/tab-tool-call";

const cap = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** One-line header: what the tool did, and to what. */
export function DeviceToolSummary({ call }: { call: DeviceToolCall }) {
  if (call.tool === OPEN_URL_TOOL) {
    return <>Open app <span className="font-mono text-text-subtle">{cap(call.url.replace(/^https?:\/\//, ""), 60)}</span></>;
  }
  if (call.tool === RUN_IN_TERMINAL_TOOL) {
    return <>Type in terminal <span className="font-mono text-text-subtle">{cap(call.command, 60)}</span></>;
  }
  return (
    <>
      Read terminal
      {call.terminal && <span className="font-mono text-text-subtle"> {call.terminal}</span>}
      {call.lines && <span className="text-text-subtle"> · {call.lines} lines</span>}
    </>
  );
}

/** Expanded body: the address, the terminal read, or the command typed and where. */
export function DeviceToolDetails({ call }: { call: DeviceToolCall }) {
  if (call.tool === OPEN_URL_TOOL) return <p className="font-mono text-text-secondary break-all">{call.url}</p>;
  if (call.tool === RUN_IN_TERMINAL_TOOL) {
    return (
      <div className="space-y-1">
        <pre className="font-mono text-text-secondary overflow-x-auto whitespace-pre-wrap break-all">{call.command}</pre>
        {call.cwd && <p className="text-text-subtle">in <span className="font-mono text-text-secondary break-all">{call.cwd}</span></p>}
      </div>
    );
  }
  return (
    <p className="text-text-subtle">
      {call.terminal ? <>Terminal <span className="font-mono text-text-secondary">{call.terminal}</span></> : "The chat's terminals"}
      {call.lines ? `, last ${call.lines} lines` : ""}
    </p>
  );
}
