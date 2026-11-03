/**
 * A schedule's script in Monaco; import this file lazily, so Monaco loads only once a script is
 * on screen. On a phone the form shows the first lines and opens the editor full screen, where
 * there is room to read and type; on a desktop it sits in the form and can be enlarged.
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import Editor from "@monaco-editor/react";
import { Maximize2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { usePortalContainer } from "@/components/ui/portal-container-context";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useMonacoTheme } from "@/lib/use-monaco-theme";
import { prepareMonacoTheme } from "@/theme/adapters/monaco-adapter";

const PREVIEW_LINES = 8;

export function ScheduleScriptEditor({
  value,
  onChange,
  readOnly = false,
  title = "Script",
}: {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  title?: string;
}) {
  const isMobile = useIsMobile();
  const theme = useMonacoTheme();
  const portal = usePortalContainer();
  const [full, setFull] = useState(false);

  const editor = (height: string) => (
    <Editor
      beforeMount={prepareMonacoTheme}
      height={height}
      language="javascript"
      theme={theme}
      value={value}
      onChange={(v) => onChange?.(v ?? "")}
      options={{
        readOnly,
        minimap: { enabled: false },
        fontSize: 13,
        tabSize: 2,
        wordWrap: "on",
        scrollBeyondLastLine: false,
        lineNumbers: isMobile ? "off" : "on",
      }}
    />
  );

  const lines = value.split("\n");
  const inline = isMobile ? (
    <button
      type="button"
      onClick={() => setFull(true)}
      className="w-full rounded-md border border-border text-left cursor-pointer active:bg-accent/30"
    >
      <pre className="px-3 py-2 text-[11px] font-mono text-muted-foreground whitespace-pre-wrap break-all line-clamp-[8]">
        {lines.slice(0, PREVIEW_LINES).join("\n")}
      </pre>
      <span className="block border-t border-border px-3 py-3 text-xs font-medium text-primary">
        {readOnly ? `Read all ${lines.length} line${lines.length === 1 ? "" : "s"}` : "Edit script"}
      </span>
    </button>
  ) : (
    <div className="rounded-md border border-border overflow-hidden">
      <div className="flex justify-end border-b border-border px-1 py-0.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setFull(true)}
          className="h-7 px-2 text-[11px] gap-1 cursor-pointer"
        >
          <Maximize2 className="size-3" /> Full screen
        </Button>
      </div>
      {editor("320px")}
    </div>
  );

  return (
    <>
      {inline}
      {full && createPortal(
        <div className="fixed inset-0 z-[70] flex flex-col bg-background" role="dialog" aria-label={title}>
          <p className="shrink-0 border-b border-border px-4 py-3 text-sm font-semibold">
            {title}{readOnly && <span className="ml-2 text-xs font-normal text-muted-foreground">read only</span>}
          </p>
          <div className="min-h-0 flex-1">{editor("100%")}</div>
          <div className="shrink-0 border-t border-border p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <Button type="button" onClick={() => setFull(false)} className="w-full min-h-11 cursor-pointer">Done</Button>
          </div>
        </div>,
        portal ?? document.body,
      )}
    </>
  );
}
