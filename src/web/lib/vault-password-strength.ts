/**
 * A rough strength reading for a new vault password, for the meter under the field. It is a
 * nudge, not a gate: the only rule the server enforces is the tier's minimum length.
 */
export interface PasswordStrength {
  /** 0 (too short) to 4 (strong). */
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
}

const LABELS = ["Too short", "Weak", "Fair", "Good", "Strong"] as const;

export function passwordStrength(password: string, minLength: number): PasswordStrength {
  const length = [...password].length;
  if (length < minLength) return { score: 0, label: LABELS[0] };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  // Mostly one repeated character reads as weak whatever its length.
  const distinct = new Set(password).size;
  let score = 1;
  if (length >= minLength + 4 || classes >= 3) score++;
  if (length >= minLength * 1.5 && classes >= 2) score++;
  if (length >= minLength * 2 || (length >= minLength + 4 && classes >= 4)) score++;
  if (distinct < Math.min(6, length / 2)) score = 1;
  const s = Math.min(4, score) as PasswordStrength["score"];
  return { score: s, label: LABELS[s] };
}
