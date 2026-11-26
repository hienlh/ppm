/**
 * What setting up the Windows headless helper does, said before the administrator prompt.
 * Bottom sheet below `md`, centred dialog above (design-guidelines rule 1).
 */
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { AlertTriangle } from "@/lib/icons";
import { TEXT_BUTTON } from "@/lib/control-size";

const TITLE = "Set up the headless helper";

export function HeadlessHelperConfirm({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const isMobile = useIsMobile();
  const body = (
    <div className="space-y-3 text-sm" data-testid="headless-helper-confirm">
      <p>Windows will show an administrator prompt on this PC. After you approve it, PPM installs:</p>
      <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
        <li>A small script in <code>Program Files\PPM\RemoteDesktopHelper</code> that only administrators can change.</li>
        <li>Scheduled tasks under <code>\PPM-RemoteDesktop</code> that run that script as SYSTEM. They take no input,
          only your Windows user can start them, they only ever move your own session, and they make at most a few
          changes per half hour.</li>
        <li>A safety net: after PPM brings your session back or turns the virtual display on, you have 5 minutes to
          confirm you can still reach the PC. If you don&apos;t, Windows turns the virtual display on for the session at
          the PC&apos;s screen. It never signs you out. PPM also never turns the virtual display off while it is the
          only screen of someone signed in at the PC.</li>
        <li>A virtual display driver (Virtual Display Driver 25.7.23, MIT, signed by SignPath Foundation). PPM checks its
          signature and the hash of every file before installing it, leaves it off, and turns it on only while a Remote
          Desktop session needs a screen. Windows may ask once more whether to trust the publisher.</li>
      </ul>
      <p className="flex gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs leading-relaxed">
        <AlertTriangle className="mt-px size-3.5 shrink-0 text-amber-500" />
        <span>
          When PPM brings your session back, it is signed in at this PC&apos;s own screen and <strong>left unlocked</strong>:
          anyone at the PC, or anyone who plugs a monitor in, sees and can use your desktop.
          Some antivirus tools flag SYSTEM tasks like this one.
        </span>
      </p>
      <p className="text-xs text-muted-foreground">
        The prompt appears on the PC itself, so do this while you are at it or connected with RDP or TeamViewer.
      </p>
      <div className="flex flex-col-reverse gap-2 pt-1 md:flex-row md:justify-end">
        <Button variant="outline" onClick={onCancel} className={TEXT_BUTTON}>Cancel</Button>
        <Button onClick={onConfirm} className={TEXT_BUTTON} data-testid="headless-helper-confirm-install">
          Install (admin prompt on the PC)
        </Button>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <BottomSheet open onClose={onCancel}>
        <div className="px-4 pb-4">
          <h2 className="mb-3 text-base font-semibold">{TITLE}</h2>
          {body}
        </div>
      </BottomSheet>
    );
  }
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle className="text-sm">{TITLE}</DialogTitle></DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
