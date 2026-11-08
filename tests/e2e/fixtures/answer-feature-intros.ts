/**
 * Answers every "PPM has new features" question at fixture startup, so the step never takes the
 * tour's panel over what a suite clicks. A browser with the basic tour dismissed (most suites'
 * page init) would otherwise get it on its first load, new install or not.
 *
 * "off" by default: it writes the switches at the state an unanswered feature already has (its
 * tools off), so a suite's chats see exactly the tools they saw before the question existed.
 * Call it after the fixture's own `configService.set("ai", ...)`, which would replace the switches.
 * The imports are dynamic so the fixture's isolation guard runs before any service opens a database.
 */
export async function answerFeatureIntrosAtStartup(answer: "on" | "off" = "off"): Promise<void> {
  const { answerFeatureIntro } = await import("../../../src/services/feature-intros.service");
  const { FEATURE_INTROS } = await import("../../../src/shared/feature-intros");
  for (const intro of FEATURE_INTROS) {
    const result = answerFeatureIntro(intro.id, answer);
    if (!result.ok) throw new Error(`Could not answer the feature introduction ${intro.id}`);
  }
}
