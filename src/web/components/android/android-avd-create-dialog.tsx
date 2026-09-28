/**
 * Create an AVD, without ever touching the SDK by hand.
 *
 * Three decisions worth stating, all of them from the plan's Phase 4:
 *
 *  - **PPM only offers images the host already has.** `/system-images` reads the installed tree;
 *    there is no "download 2.9 GB now" button, because "không tự chấp nhận SDK license hay tải
 *    nhiều GB khi mở tab" reads forward as well as back. An image for another CPU is listed but
 *    unselectable, with the reason on the row, rather than hidden — hidden looks like a bug when
 *    the user knows they installed it.
 *  - **A device profile is required**, and the form says why in the hint: `avdmanager` with no
 *    `--device` builds a 320x640 AVD, which looks like a broken emulator rather than a default.
 *  - **The name is validated with the host's own regex** (`@/shared/android-avd`), so the form
 *    cannot accept something the host will refuse after the dialog has closed.
 *
 * `SearchSelect` rather than a plain select: this host lists 88 device profiles, most of which
 * agree for most of their length.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { Input } from "@/components/ui/input";
import { SearchSelect } from "@/components/ui/search-select";
import { Loader2, Smartphone, HardDrive, TriangleAlert } from "@/lib/icons";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { AVD_LIMITS, validateAvdName } from "../../../shared/android-avd";
import type { AvdDeviceProfile } from "../../../shared/android-avd";

/** What `/api/android/system-images` returns per row. `sysdir` is stripped host-side. */
export interface SystemImageRow {
  id: string;
  apiLevel: number | null;
  abi: string;
  tag: string;
  tagDisplay: string;
  description: string;
  playStore: boolean;
  bytes: number;
  hostCompatible: boolean;
}

export interface AndroidAvdCreateDialogProps {
  open: boolean;
  onClose: () => void;
  /** Names already taken, so a duplicate is caught before a round trip. */
  existingNames: string[];
  /** The new AVD landed; the list should refresh. */
  onCreated: (name: string) => void;
}

const KIND_ORDER: AvdDeviceProfile["kind"][] = [
  "phone", "tablet", "tv", "wear", "automotive", "desktop", "other",
];
const KIND_LABEL: Record<AvdDeviceProfile["kind"], string> = {
  phone: "Phones", tablet: "Tablets", tv: "TV", wear: "Wear",
  automotive: "Automotive", desktop: "Desktop", other: "Other",
};

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

export function AndroidAvdCreateDialog(
  { open, onClose, existingNames, onCreated }: AndroidAvdCreateDialogProps,
) {
  const isMobile = useIsMobile();
  const [images, setImages] = useState<SystemImageRow[] | null>(null);
  const [profiles, setProfiles] = useState<AvdDeviceProfile[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [profile, setProfile] = useState("");
  const [ramMb, setRamMb] = useState(String(AVD_LIMITS.ramMb.default));
  const [storageMb, setStorageMb] = useState(String(AVD_LIMITS.storageMb.default));

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The two lists are the host's, and the profile list costs a real `avdmanager` run (~730 ms
  // cold, cached after), so they are fetched when the dialog opens rather than with the tab.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoadError(null);
    void (async () => {
      try {
        const [i, p] = await Promise.all([
          api.get<{ images: SystemImageRow[] }>("/api/android/system-images"),
          api.get<{ profiles: AvdDeviceProfile[] }>("/api/android/device-profiles"),
        ]);
        if (!alive) return;
        setImages(i.images);
        setProfiles(p.profiles);
        // Default to something that will actually boot here: the newest image this CPU can run.
        const usable = i.images.filter((x) => x.hostCompatible);
        const newest = usable.slice().sort((a, b) => (b.apiLevel ?? 0) - (a.apiLevel ?? 0))[0];
        if (newest) setImage((current) => current || newest.id);
        if (p.profiles.some((x) => x.id === "pixel_9")) setProfile((c) => c || "pixel_9");
      } catch (e) {
        if (alive) setLoadError((e as Error).message);
      }
    })();
    return () => { alive = false; };
  }, [open]);

  const imageItems = useMemo(() => (images ?? []).map((i) => ({
    value: i.hostCompatible ? i.id : "",
    label: `API ${i.apiLevel ?? "?"} · ${i.tagDisplay} · ${i.abi}`,
    group: i.hostCompatible ? "Runs on this host" : "Wrong CPU for this host",
    hint: i.hostCompatible ? gb(i.bytes) : `needs ${i.abi}`,
    title: i.id,
  })), [images]);

  const profileItems = useMemo(() => {
    const list = profiles ?? [];
    return KIND_ORDER.flatMap((kind) => list
      .filter((p) => p.kind === kind)
      .map((p) => ({ value: p.id, label: p.name, group: KIND_LABEL[kind], hint: p.oem })));
  }, [profiles]);

  const nameProblem = name.length === 0
    ? null
    : existingNames.some((n) => n.toLowerCase() === name.toLowerCase())
      ? "an AVD with that name already exists"
      : validateAvdName(name);
  const ram = Number(ramMb);
  const storage = Number(storageMb);
  const ramProblem = Number.isFinite(ram) && ram >= AVD_LIMITS.ramMb.min && ram <= AVD_LIMITS.ramMb.max
    ? null : `RAM must be between ${AVD_LIMITS.ramMb.min} and ${AVD_LIMITS.ramMb.max} MB`;
  const storageProblem = Number.isFinite(storage) && storage >= AVD_LIMITS.storageMb.min
    && storage <= AVD_LIMITS.storageMb.max
    ? null : `Storage must be between ${AVD_LIMITS.storageMb.min} and ${AVD_LIMITS.storageMb.max} MB`;

  const ready = name.length > 0 && !nameProblem && !ramProblem && !storageProblem
    && image !== "" && profile !== "" && !saving;

  const reset = () => {
    setName(""); setError(null); setSaving(false);
    setRamMb(String(AVD_LIMITS.ramMb.default));
    setStorageMb(String(AVD_LIMITS.storageMb.default));
  };

  const submit = async () => {
    if (!ready) return;
    setSaving(true);
    setError(null);
    try {
      await api.post("/api/android/avds", {
        name, systemImage: image, deviceProfile: profile, ramMb: ram, storageMb: storage,
      });
      onCreated(name);
      reset();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  const loading = !loadError && (images === null || profiles === null);

  const body = (
    <div className="space-y-4">
      {loadError && (
        <p className="flex items-start gap-2 text-sm leading-relaxed text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1">{loadError}</span>
        </p>
      )}
      {loading && (
        <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Reading the SDK…
        </p>
      )}

      {!loading && !loadError && (
        <>
          <div className="space-y-1.5">
            <label htmlFor="avd-name" className="text-sm font-medium">Name</label>
            <Input
              id="avd-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Pixel_9_API_35"
              autoComplete="off"
              spellCheck={false}
              className="h-11"
            />
            {nameProblem
              ? <p className="text-xs leading-relaxed text-destructive">{nameProblem}</p>
              : <p className="text-xs leading-relaxed text-muted-foreground">
                  This becomes a folder name, so no spaces.
                </p>}
          </div>

          <div className="space-y-1.5">
            <span className="text-sm font-medium">System image</span>
            <SearchSelect
              value={image}
              items={imageItems}
              onChange={setImage}
              label="System image"
              searchPlaceholder="Search images"
              emptyText="No system images are installed"
              placeholder="Pick an installed image"
              icon={HardDrive}
              className="h-11 w-full md:h-9"
              modal={!isMobile}
            />
            <p className="text-xs leading-relaxed text-muted-foreground">
              Only images already downloaded on this host. PPM never downloads one for you —
              use Android Studio's SDK Manager, or{" "}
              <code className="rounded bg-muted px-1 text-[11px]">sdkmanager</code>.
            </p>
          </div>

          <div className="space-y-1.5">
            <span className="text-sm font-medium">Device</span>
            <SearchSelect
              value={profile}
              items={profileItems}
              onChange={setProfile}
              label="Device profile"
              searchPlaceholder="Search devices"
              emptyText="No device profiles"
              placeholder="Pick a device"
              icon={Smartphone}
              className="h-11 w-full md:h-9"
              modal={!isMobile}
            />
            <p className="text-xs leading-relaxed text-muted-foreground">
              Sets the screen. Without one the emulator is 320x640.
            </p>
          </div>

          <div className="flex gap-3">
            <div className="min-w-0 flex-1 space-y-1.5">
              <label htmlFor="avd-ram" className="text-sm font-medium">RAM (MB)</label>
              <Input id="avd-ram" inputMode="numeric" value={ramMb} className="h-11"
                onChange={(e) => setRamMb(e.target.value)} />
            </div>
            <div className="min-w-0 flex-1 space-y-1.5">
              <label htmlFor="avd-storage" className="text-sm font-medium">Storage (MB)</label>
              <Input id="avd-storage" inputMode="numeric" value={storageMb} className="h-11"
                onChange={(e) => setStorageMb(e.target.value)} />
            </div>
          </div>
          {(ramProblem || storageProblem) && (
            <p className="text-xs leading-relaxed text-destructive">{ramProblem ?? storageProblem}</p>
          )}

          <p className="text-xs leading-relaxed text-muted-foreground">
            PPM writes <code className="rounded bg-muted px-1 text-[11px]">hw.keyboard=yes</code>{" "}
            into every AVD it creates — without it the emulator accepts key presses and shows
            nothing.
          </p>
        </>
      )}

      {error && (
        <p className="flex items-start gap-2 text-sm leading-relaxed text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
        </p>
      )}

      <div className="flex flex-col-reverse gap-2 pt-2 md:flex-row md:justify-end">
        <Button variant="outline" className="min-h-11" onClick={() => { reset(); onClose(); }}>
          Cancel
        </Button>
        <Button className="min-h-11" disabled={!ready} onClick={() => void submit()}>
          {saving ? <><Loader2 className="animate-spin" /> Creating…</> : "Create device"}
        </Button>
      </div>
    </div>
  );

  if (!open) return null;

  if (isMobile) {
    return (
      <BottomSheet open onClose={onClose}>
        <div className="max-h-[80vh] overflow-y-auto px-4 pb-4">
          <h2 className="mb-3 text-base font-semibold">New Android device</h2>
          {body}
        </div>
      </BottomSheet>
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New Android device</DialogTitle>
          <DialogDescription>Built from a system image already installed on this host.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] overflow-y-auto pr-1">{body}</div>
      </DialogContent>
    </Dialog>
  );
}
