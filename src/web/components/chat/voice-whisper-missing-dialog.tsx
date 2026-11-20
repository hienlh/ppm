/**
 * Shown when the mic is pressed for a voice message on a PPM host without Whisper: the
 * recording would have nothing to turn it into text, so nothing is recorded and the way to
 * install it is one tap away. A bottom sheet below `md`, a dialog above.
 */
import { Mic } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { openSettings } from "@/components/settings/open-settings";
import { useIsMobile } from "@/hooks/use-is-mobile";

const TITLE = "Voice messages need Whisper on this PPM host";
const BODY = "Whisper turns your recording into text on the machine PPM runs on; nothing is sent anywhere else. Install it once in Settings → Voice Input, then press the mic again.";

export function VoiceWhisperMissingDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const mobile = useIsMobile();
  const openVoiceSettings = () => { onClose(); openSettings("voice"); };

  if (mobile) {
    return (
      <BottomSheet open={open} onClose={onClose}>
        <div className="space-y-3 px-4 pb-4 pt-1">
          <div className="flex items-center gap-2 text-base font-semibold">
            <Mic className="size-4 shrink-0 text-primary" />
            {TITLE}
          </div>
          <p className="text-sm leading-relaxed text-text-2">{BODY}</p>
          <div className="flex flex-col gap-2 pt-1">
            <Button className="min-h-11" onClick={openVoiceSettings}>Open Settings → Voice Input</Button>
            <Button variant="ghost" className="min-h-11" onClick={onClose}>Not now</Button>
          </div>
        </div>
      </BottomSheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mic className="size-4 shrink-0 text-primary" />
            {TITLE}
          </DialogTitle>
          <DialogDescription>{BODY}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Not now</Button>
          <Button onClick={openVoiceSettings}>Open Settings → Voice Input</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
