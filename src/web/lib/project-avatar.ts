/** Compute display initials for a project, resolving collisions. */
export function getProjectInitials(name: string, allNames: string[]): string {
  // Split by common separators, take first char of each word, uppercase
  const words = name.split(/[-_.\s]+/).filter(Boolean);
  const firstChar = (words[0]?.[0] ?? name[0] ?? "?").toUpperCase();
  const twoChars = words.length > 1
    ? (firstChar + (words[1]![0] ?? "").toUpperCase())
    : firstChar;

  // Check if 1-char is unique among all projects
  const others = allNames.filter((n) => n !== name);
  const othersFirstChars = others.map((n) => {
    const w = n.split(/[-_.\s]+/).filter(Boolean);
    return (w[0]?.[0] ?? n[0] ?? "").toUpperCase();
  });

  if (!othersFirstChars.includes(firstChar)) {
    return firstChar;
  }

  // Try 2-char initials
  const othersTwoChars = others.map((n) => {
    const w = n.split(/[-_.\s]+/).filter(Boolean);
    const f = (w[0]?.[0] ?? n[0] ?? "").toUpperCase();
    const s = w.length > 1 ? (w[1]![0] ?? "").toUpperCase() : f;
    return w.length > 1 ? f + s : f;
  });

  if (!othersTwoChars.includes(twoChars)) {
    return twoChars;
  }

  // Fall back to 1-based index
  const idx = allNames.indexOf(name);
  return String(idx >= 0 ? idx + 1 : "?");
}

export interface ProjectAvatar {
  initials: string;
  color: string;
}

export function getProjectAvatar(name: string, allNames: string[], color: string): ProjectAvatar {
  return { initials: getProjectInitials(name, allNames), color };
}
