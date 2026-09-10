/**
 * General settings: this device's name, the account password, and the build identity.
 *
 * Grouped together because all three answer "which install am I looking at" rather than
 * changing how PPM behaves.
 */

import { useCallback, useRef, useState } from "react";
import { Check } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useSettingsStore } from "@/stores/settings-store";
import { ChangePasswordSection } from "./change-password-section";

export function GeneralSettingsSection() {
  const { deviceName, setDeviceName, version } = useSettingsStore(
    useShallow((s) => ({ deviceName: s.deviceName, setDeviceName: s.setDeviceName, version: s.version })),
  );
  const [nameInput, setNameInput] = useState(deviceName ?? "");
  const [nameSaving, setNameSaving] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const nameChanged = nameInput.trim() !== (deviceName ?? "");

  const handleSaveName = useCallback(async () => {
    if (!nameChanged) return;
    setNameSaving(true);
    try {
      await setDeviceName(nameInput);
      setNameSaved(true);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setNameSaved(false), 2000);
    } finally {
      setNameSaving(false);
    }
  }, [nameInput, nameChanged, setDeviceName]);

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <Label htmlFor="device-name">Device Name</Label>
        <div className="flex gap-2">
          <Input
            id="device-name"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSaveName(); }}
            placeholder="My Device"
            className="flex-1"
            maxLength={100}
          />
          <Button
            variant={nameSaved ? "default" : "outline"}
            className="cursor-pointer shrink-0"
            disabled={!nameChanged || nameSaving}
            onClick={handleSaveName}
          >
            {nameSaving ? "..." : nameSaved ? <Check className="size-4" /> : "Save"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Shown in page title and synced to PPM Cloud.
        </p>
      </section>

      <Separator />

      <ChangePasswordSection />

      <Separator />

      <section className="space-y-1">
        <h3 className="text-sm font-medium">About</h3>
        <p className="text-sm text-muted-foreground">PPM — Personal Project Manager</p>
        <p className="text-xs text-muted-foreground">
          A mobile-first web IDE for managing your projects.
        </p>
        {version && (
          <p className="text-xs text-muted-foreground tabular-nums">Version {version}</p>
        )}
      </section>
    </div>
  );
}
