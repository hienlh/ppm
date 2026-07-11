import { memo, useState, useEffect } from "react";
import { getProjectInitials } from "@/lib/project-avatar";
import { getAuthToken } from "@/lib/api-client";
import { cn } from "@/lib/utils";

/**
 * Single source of truth for a project's avatar visual.
 * Renders the uploaded image when `image` is set (falling back to the
 * color+initials chip on load error or when absent).
 * `shape="square"` = 7px squircle (design language of tabs/rail/mobile chips).
 */
export const ProjectAvatar = memo(function ProjectAvatar({
  name,
  color,
  image,
  size,
  allNames,
  shape = "circle",
}: {
  name: string;
  color: string;
  image?: string;
  size: number;
  allNames: string[];
  shape?: "circle" | "square";
}) {
  const [errored, setErrored] = useState(false);
  useEffect(() => { setErrored(false); }, [image]);

  const radiusClass = shape === "square" ? "rounded-[7px]" : "rounded-full";

  if (image && !errored) {
    const token = getAuthToken();
    const params = new URLSearchParams({ v: image });
    if (token) params.set("token", token);
    return (
      <img
        src={`/api/projects/${encodeURIComponent(name)}/image?${params.toString()}`}
        alt={name}
        onError={() => setErrored(true)}
        className={cn("object-cover shrink-0 select-none", radiusClass)}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <div
      className={cn("flex items-center justify-center font-bold text-white select-none shrink-0", radiusClass)}
      style={{ background: color, width: size, height: size, fontSize: size <= 24 ? 10 : 11 }}
    >
      {getProjectInitials(name, allNames)}
    </div>
  );
});
