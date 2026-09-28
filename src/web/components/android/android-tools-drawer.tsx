/**
 * The app tools, docked under the screen.
 *
 * One drawer with three tabs rather than a dialog per tool, and it is at the **bottom** on every
 * size. That is not a mobile concession: a log you read while tapping through the guest has to
 * be visible at the same time as the guest, which a modal cannot be — and the bottom is also the
 * thumb zone the design guidelines ask for, so the phone layout comes out of the same decision
 * instead of needing a second one.
 *
 * Each panel is mounted only while its tab is open, which is what makes the logcat subscription
 * follow the panel: switching to Install really does stop the device's log stream.
 */
import { Button } from "@/components/ui/button";
import { ChevronDown, ScrollText, Smartphone, Clipboard } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { AndroidClipboardPanel } from "./android-clipboard-panel";
import { AndroidInstallPanel } from "./android-install-panel";
import { AndroidLogcatPanel } from "./android-logcat-panel";
import type { AndroidLogEntry } from "../../../shared/android-protocol";

export type AndroidTool = "install" | "logs" | "clipboard";

export const ANDROID_TOOLS: { id: AndroidTool; label: string; Icon: typeof ScrollText }[] = [
  { id: "install", label: "Install", Icon: Smartphone },
  { id: "logs", label: "Logs", Icon: ScrollText },
  { id: "clipboard", label: "Clipboard", Icon: Clipboard },
];

export interface AndroidToolsDrawerProps {
  tool: AndroidTool;
  onToolChange: (tool: AndroidTool) => void;
  onClose: () => void;
  deviceId: string;
  deviceName: string;
  setLogcat: (on: boolean) => void;
  onLog: (listener: (entries: AndroidLogEntry[]) => void) => () => void;
}

export function AndroidToolsDrawer(props: AndroidToolsDrawerProps) {
  const { tool, onToolChange, onClose, deviceId, deviceName, setLogcat, onLog } = props;

  return (
    <div className="flex h-full min-h-0 flex-col border-t bg-background">
      <div className="flex items-center gap-1 border-b px-1">
        {ANDROID_TOOLS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => onToolChange(id)}
            aria-current={tool === id}
            className={cn(
              "flex min-h-11 items-center gap-1.5 border-b-2 px-3 text-sm md:min-h-9",
              tool === id
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {label}
          </button>
        ))}
        <span className="flex-1" />
        <Button variant="ghost" size="icon" className="size-11 md:size-9" onClick={onClose}
          title="Hide the tools" aria-label="Hide the tools">
          <ChevronDown />
        </Button>
      </div>

      <div className="min-h-0 flex-1">
        {tool === "install" && <AndroidInstallPanel deviceId={deviceId} deviceName={deviceName} />}
        {tool === "logs" && <AndroidLogcatPanel setLogcat={setLogcat} onLog={onLog} />}
        {tool === "clipboard" && <AndroidClipboardPanel deviceId={deviceId} />}
      </div>
    </div>
  );
}
