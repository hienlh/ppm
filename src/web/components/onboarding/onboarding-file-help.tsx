import { useEffect, useState } from "react";
import { api, projectUrl } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { useOnboardingStore } from "@/stores/onboarding-store";
import type { FileDirEntry } from "../../../types/project";

export function OnboardingFileHelp() {
  const projectName = useOnboardingStore((state) => state.projectName);
  const skip = useOnboardingStore((state) => state.skip);
  const [empty, setEmpty] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let requestId = 0;
    setEmpty(false);
    if (!projectName) return;
    const check = () => {
      const id = ++requestId;
      void api.get<FileDirEntry[]>(`${projectUrl(projectName)}/files/list`).then((entries) => {
        if (!cancelled && id === requestId) setEmpty(entries.length === 0);
      }).catch(() => { if (!cancelled && id === requestId) setEmpty(false); });
    };
    check();
    window.addEventListener("ppm:onboarding-refresh", check);
    return () => { cancelled = true; window.removeEventListener("ppm:onboarding-refresh", check); };
  }, [projectName]);
  return empty ? <div className="mt-3 rounded-lg border border-border p-3" role="status">
    <p className="text-sm text-text-secondary">No files are visible in this project yet. You can create your own files later or choose another project. Nothing needs to be created for this tour.</p>
    <Button variant="outline" className="w-full min-h-11 mt-2" onClick={skip}>Skip empty project step</Button>
    <p className="text-xs text-text-secondary mt-2">This step will be marked skipped, not completed.</p>
  </div> : <p className="text-xs text-text-secondary mt-2">Choose any text file, such as .txt, .js, .py or .md. No README or package.json is required. Markdown Preview counts too. If there is no readable file, use Skip step.</p>;
}
