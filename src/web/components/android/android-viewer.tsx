/**
 * One running emulator, on screen and under the finger.
 *
 * Layout notes that are decisions rather than styling:
 *  - The canvas is `object-contain` inside a flex box, so the picture keeps the guest's aspect
 *    ratio at any window size and the letterbox bars are real — `android-coords.ts` returns null
 *    for a tap on one rather than clamping it onto the guest's edge.
 *  - `touch-action: none` is what stops the browser reading a swipe as a scroll and handing the
 *    guest a fraction of the gesture.
 *  - The controls sit at the **bottom** on every size (design guidelines §9), not only on mobile:
 *    an emulator's own navigation bar is at the bottom too, and putting PPM's copy anywhere else
 *    makes the two disagree about which direction "back" is.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getAuthToken } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { ChevronLeft, Image, Loader2, RefreshCw, TriangleAlert, Hand } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { AndroidControls } from "./android-controls";
import { ANDROID_TOOLS, AndroidToolsDrawer, type AndroidTool } from "./android-tools-drawer";
import { downloadScreenshot } from "./android-screenshot-download";
import { useAndroidKeyboard } from "./use-android-keyboard";
import { useAndroidSession } from "./use-android-session";
import { useAndroidTouch } from "./use-android-touch";
import type { AndroidQuality } from "../../../shared/android-protocol";

export interface AndroidViewerProps {
  deviceId: string;
  deviceName: string;
  /** The tab is mounted but not visible — `tab-pool` keeps other tabs alive. */
  hidden?: boolean;
  /** Back to the device picker. Rendered here rather than by the tab so the header is one row. */
  onBack?: () => void;
}

export function AndroidViewer({ deviceId, deviceName, hidden = false, onBack }: AndroidViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [quality, setQuality] = useState<AndroidQuality>("balanced");
  const [tool, setTool] = useState<AndroidTool | null>(null);
  const [shooting, setShooting] = useState(false);
  const [toolError, setToolError] = useState<string | null>(null);

  const session = useAndroidSession({ deviceId, quality, canvasRef, paused: hidden });
  const touch = useAndroidTouch({
    canvasRef, geometry: session.geometry, enabled: session.controller, send: session.send,
  });
  const keyboard = useAndroidKeyboard({
    geometry: session.geometry, enabled: session.controller, send: session.send,
  });

  // A viewer that has lost the lease must not keep a soft keyboard up over a screen it cannot
  // type into.
  useEffect(() => { if (!session.controller) keyboard.blur(); }, [session.controller, keyboard]);

  const rotation = session.geometry?.rotation ?? 0;
  const connecting = session.state === "connecting" || session.state === "reconnecting";

  const screenshot = useCallback(async () => {
    setShooting(true);
    setToolError(null);
    try {
      await downloadScreenshot(deviceId, getAuthToken(), `${deviceName}.png`);
    } catch (e) {
      setToolError((e as Error).message);
    } finally {
      setShooting(false);
    }
  }, [deviceId, deviceName]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-black">
      {/* One header row for the whole tab: where you are, and what you can do to the device that
          is not a key press. The tool buttons are here rather than in the bottom bar because that
          bar mirrors the guest's own navigation and must not grow app tooling. */}
      <div className="flex items-center gap-1 border-b bg-background px-1 py-1">
        {onBack && (
          <Button variant="ghost" size="icon" className="size-11 md:size-9" onClick={onBack}
            title="All devices" aria-label="All devices">
            <ChevronLeft />
          </Button>
        )}
        <span className="min-w-0 flex-1 truncate px-1 text-sm font-medium">{deviceName}</span>

        <Button variant="ghost" size="icon" className="size-11 md:size-9" disabled={shooting}
          onClick={() => void screenshot()} title="Save a screenshot" aria-label="Save a screenshot">
          {shooting ? <Loader2 className="animate-spin" /> : <Image />}
        </Button>
        {ANDROID_TOOLS.map(({ id, label, Icon }) => (
          <Button
            key={id}
            variant={tool === id ? "secondary" : "ghost"}
            size="icon"
            className="size-11 md:size-9"
            aria-pressed={tool === id}
            onClick={() => setTool((current) => (current === id ? null : id))}
            title={label}
            aria-label={label}
          >
            <Icon />
          </Button>
        ))}
      </div>

      {toolError && (
        <div className="bg-destructive/90 px-4 py-2 text-center text-sm text-white">{toolError}</div>
      )}
      {!session.controller && session.state === "live" && (
        <div className="flex items-center gap-2 border-b bg-background px-4 py-2 text-sm">
          <Hand className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {session.controllerReason ?? "Someone else is controlling this device."}
          </span>
          <Button size="sm" onClick={session.takeControl}>Take control</Button>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        <canvas
          ref={canvasRef}
          // `touch-action: none` or the browser claims the gesture; `select-none` so a long press
          // does not start a text selection over the picture.
          className={cn(
            "max-h-full max-w-full touch-none select-none object-contain",
            session.controller ? "cursor-crosshair" : "cursor-default",
          )}
          onPointerDown={(e) => { touch.onPointerDown(e); keyboard.focus(); }}
          onPointerMove={touch.onPointerMove}
          onPointerUp={touch.onPointerUp}
          onPointerCancel={touch.onPointerCancel}
        />

        {!session.hasPicture && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-white/70">
            {session.state === "failed" ? (
              <>
                <TriangleAlert className="size-6" />
                <p className="max-w-xs px-6 text-center">{session.errorMessage ?? "Could not connect."}</p>
                <Button size="sm" variant="secondary" onClick={session.reconnect}>
                  <RefreshCw /> Try again
                </Button>
              </>
            ) : (
              <>
                <Loader2 className="size-6 animate-spin" />
                <p>{connecting ? `Connecting to ${deviceName}…` : "Waiting for the first frame…"}</p>
              </>
            )}
          </div>
        )}

        {session.hasPicture && session.errorMessage && (
          <div className="absolute inset-x-0 top-0 bg-destructive/90 px-4 py-2 text-center text-sm text-white">
            {session.errorMessage}
          </div>
        )}
      </div>

      {/* Off-screen but rendered: `display:none` or `visibility:hidden` cannot take focus, and a
          textarea that cannot take focus receives no `beforeinput`, which is the whole text path. */}
      <textarea
        ref={keyboard.inputRef}
        className="pointer-events-none absolute size-px opacity-0"
        aria-hidden
        tabIndex={-1}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        value=""
        onChange={() => { /* every input is preventDefault'd; this only silences React */ }}
      />

      {tool && (
        // A fixed share of the viewer rather than a draggable splitter: the picture has a fixed
        // aspect ratio, so the space it does not use is letterbox either way.
        <div className="h-[45%] min-h-0 shrink-0">
          <AndroidToolsDrawer
            tool={tool}
            onToolChange={setTool}
            onClose={() => setTool(null)}
            deviceId={deviceId}
            deviceName={deviceName}
            setLogcat={session.setLogcat}
            onLog={session.onLog}
          />
        </div>
      )}

      <AndroidControls
        layout="bar"
        send={session.send}
        controller={session.controller}
        rotation={rotation}
        quality={quality}
        onQualityChange={setQuality}
        onKeyboard={keyboard.focus}
      />
    </div>
  );
}
