/** Convert Codex's internal subscription enum to the plan name PPM shows people. */
export function codexPlanLabel(planType: string | null | undefined): string | null {
  if (!planType?.trim()) return null;
  const key = planType.trim().toLowerCase();
  const known: Record<string, string> = {
    free: "ChatGPT Free",
    go: "ChatGPT Go",
    plus: "ChatGPT Plus",
    pro: "ChatGPT Pro",
    team: "ChatGPT Team",
    business: "ChatGPT Business",
    self_serve_business_prolite: "ChatGPT Business",
    enterprise: "ChatGPT Enterprise",
    edu: "ChatGPT Edu",
  };
  return known[key] ?? planType;
}
