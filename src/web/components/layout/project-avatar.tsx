import { memo, useState, useEffect } from "react";
import { getProjectInitials } from "@/lib/project-avatar";
import { getAuthToken } from "@/lib/api-client";

/**
 * Single source of truth for a project's avatar visual.
 * Renders the uploaded image when `image` is set (falling back to the
 * color+initials circle on load error or when absent).
 */
export const ProjectAvatar = memo(function ProjectAvatar({
  name,
  color,
  image,
  size,
  allNames,
}: {
  name: string;
  color: string;
  image?: string;
  size: number;
  allNames: string[];
}) {
  const [errored, setErrored] = useState(false);
  useEffect(() => { setErrored(false); }, [image]);

  if (image && !errored) {
    const token = getAuthToken();
    const params = new URLSearchParams({ v: image });
    if (token) params.set("token", token);
    return (
      <img
        src={`/api/projects/${encodeURIComponent(name)}/image?${params.toString()}`}
        alt={name}
        onError={() => setErrored(true)}
        className="rounded-full object-cover shrink-0 select-none"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <div
      className="rounded-full flex items-center justify-center font-bold text-white select-none shrink-0"
      style={{ background: color, width: size, height: size, fontSize: size <= 24 ? 10 : 11 }}
    >
      {getProjectInitials(name, allNames)}
    </div>
  );
});
